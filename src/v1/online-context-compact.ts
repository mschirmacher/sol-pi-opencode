import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import type { OnlineContextCompactConfig } from "../core/config.js";
import { analyzePlanTransition, formatPlanSnapshot, todosToPlanSteps } from "../core/online-context-compact/plan.js";
import { decideCompaction } from "../core/online-context-compact/economics.js";
import {
  averageContextTokenIncrement,
  createFileStore,
  initialState,
  recordBoundary,
  recordCompaction,
  recordRequest,
  requestsSinceLastCompaction,
  type OnlineCompactState,
} from "../core/online-context-compact/state.js";
import { archiveDirFor } from "./observation-pack.js";

/**
 * Online Context Compact for opencode 1.x (mapping.md §3).
 *
 * Boundary signal (verified against v1.19.0 SDK event types):
 * - The reliable "completed step" signal IS observable in 1.x: the built-in
 *   todo tool emits `todo.updated` events with the full todo list
 *   (properties.sessionID + properties.todos). We diff consecutive todo
 *   snapshots via analyzePlanTransition; a step transitioning to
 *   "completed" is a compaction boundary candidate.
 * - LIMITATION (honest): if the model never uses the todo tool there are no
 *   plan boundaries and OCC never fires — we do NOT fabricate boundaries
 *   from session.idle alone, because turn-end is not a completed-step
 *   signal and would compact on the wrong economics. session.idle is used
 *   only as the safe (quiescent) FIRING POINT for a candidate that was
 *   detected mid-turn (mapping.md mid-turn-race mitigation), plus
 *   `session.compacted` reconciles state for native/pressure compactions.
 *
 * Trigger: client.session.summarize({path:{id}, body:{providerID, modelID}})
 * — does not abort; opencode continues via experimental.compaction.autocontinue
 * (default enabled:true = SoL-Pi's plan continuation; we deliberately do NOT
 * register that hook, so the default stays on).
 *
 * Fail-open everywhere: any error leaves the session untouched.
 */

/** Rough size of the replacement summary; compaction keeps a tail + memo. */
const MEMO_TOKEN_ESTIMATE = 2_048;

interface SessionModel {
  providerID: string;
  modelID: string;
}

export function createOnlineContextCompactHooks(input: PluginInput, config: OnlineContextCompactConfig): Hooks {
  if (!config.enabled) return {};

  const store = createFileStore(archiveDirFor(input, "_occ"));
  const states = new Map<string, OnlineCompactState>();
  const pendingCandidate = new Set<string>();
  const compactInFlight = new Set<string>();
  const windowCache = new Map<string, number | null>();

  const log = (level: "debug" | "info" | "warn" | "error", message: string, extra?: unknown): void => {
    try {
      const app = (input.client as unknown as { app?: { log?: (arg: { body: unknown }) => unknown } })?.app;
      void app?.log?.({ body: { service: "sol-pi", level, message, extra } });
    } catch {
      // logging must never break the mechanism
    }
  };

  const loadState = async (sessionID: string): Promise<OnlineCompactState> => {
    const cached = states.get(sessionID);
    if (cached) return cached;
    const loaded = (await store.load(sessionID)) ?? initialState();
    states.set(sessionID, loaded);
    return loaded;
  };

  const saveState = async (sessionID: string, state: OnlineCompactState): Promise<void> => {
    states.set(sessionID, state);
    try {
      await store.save(sessionID, state);
    } catch (error) {
      log("warn", `occ: state save fail-open: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** Last user message carries the session's current model (SDK UserMessage.model). */
  const resolveModel = async (sessionID: string): Promise<SessionModel | undefined> => {
    try {
      const response = await input.client.session.messages({ path: { id: sessionID } });
      const messages = response.data;
      if (!Array.isArray(messages)) return undefined;
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const info = messages[i]?.info as { role?: string; model?: SessionModel } | undefined;
        if (info?.role === "user" && info.model?.providerID && info.model?.modelID) {
          return { providerID: info.model.providerID, modelID: info.model.modelID };
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
  };

  const resolveContextWindow = async (model: SessionModel): Promise<number | null> => {
    const key = `${model.providerID}/${model.modelID}`;
    if (windowCache.has(key)) return windowCache.get(key) ?? null;
    try {
      const response = await input.client.provider.list();
      const providers = (
        response.data as { providers?: readonly { id: string; models?: Record<string, { limit?: { context?: number } }> }[] } | undefined
      )?.providers;
      const context = providers?.find((p) => p.id === model.providerID)?.models?.[model.modelID]?.limit?.context;
      const value = typeof context === "number" && context > 0 ? context : null;
      windowCache.set(key, value);
      return value;
    } catch {
      return null;
    }
  };

  const evaluate = async (sessionID: string): Promise<void> => {
    if (compactInFlight.has(sessionID)) return;
    const state = await loadState(sessionID);
    const model = await resolveModel(sessionID);
    if (!model) {
      log("debug", "occ: model not resolvable, skipping compaction", { sessionID });
      return;
    }
    const contextWindowTokens = await resolveContextWindow(model);
    const contextTokens = state.lastContextTokens ?? 0;
    const remainingBoundaries = Math.max(1, state.plan.filter((step) => step.status !== "completed").length);
    const decision = decideCompaction({
      boundaryRequestCounts: state.completedBoundaryRequestCounts,
      remainingBoundaries,
      contextTokens,
      contextWindowTokens,
      averageContextTokenIncrement: averageContextTokenIncrement(state),
      archiveTokens: contextTokens,
      memoTokens: MEMO_TOKEN_ESTIMATE,
      priorCompactionCount: state.compactionCount,
      requestsSinceLastCompaction: requestsSinceLastCompaction(state),
      cacheWriteReadRatio: config.cacheWriteReadRatio,
      config: {
        windowReserveTokens: config.windowReserveTokens,
        minRequestsBetween: config.minRequestsBetween,
        subsequentCompactionMargin: config.subsequentCompactionMargin,
      },
    });
    log("debug", `occ: decision ${decision.reason} compact=${String(decision.compact)}`, {
      sessionID,
      expectedSavings: decision.expectedSavings,
      rewriteCost: decision.rewriteCost,
    });
    if (!decision.compact) return;
    compactInFlight.add(sessionID);
    try {
      await input.client.session.summarize({
        path: { id: sessionID },
        body: { providerID: model.providerID, modelID: model.modelID },
      });
      log("info", "occ: triggered session.summarize", { sessionID });
    } catch (error) {
      compactInFlight.delete(sessionID);
      log("warn", `occ: summarize fail-open: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return {
    event: async ({ event }) => {
      try {
        const properties = (event as { properties?: Record<string, unknown> }).properties;
        const sessionID = typeof properties?.sessionID === "string" ? properties.sessionID : undefined;

        switch (event.type) {
          case "message.part.updated": {
            const part = (event as { properties?: { part?: { type?: string; tokens?: Record<string, unknown> } } }).properties?.part;
            if (!sessionID || part?.type !== "step-finish" || !part.tokens) return;
            const cache = (part.tokens.cache ?? {}) as { read?: number; write?: number };
            const contextTokens =
              Number(part.tokens.input ?? 0) +
              Number(part.tokens.output ?? 0) +
              Number(part.tokens.reasoning ?? 0) +
              Number(cache.read ?? 0) +
              Number(cache.write ?? 0);
            await saveState(sessionID, recordRequest(await loadState(sessionID), contextTokens));
            return;
          }
          case "todo.updated": {
            const todos = properties?.todos as
              | readonly { id: string; content: string; status: string }[]
              | undefined;
            if (!sessionID || !Array.isArray(todos)) return;
            const state = await loadState(sessionID);
            const plan = todosToPlanSteps(todos);
            const transition = analyzePlanTransition(state.plan, plan);
            if (transition.completedSteps.length > 0) {
              await saveState(sessionID, recordBoundary(state, plan));
              pendingCandidate.add(sessionID);
            } else {
              await saveState(sessionID, { ...state, plan });
            }
            return;
          }
          case "session.compacted": {
            if (!sessionID) return;
            compactInFlight.delete(sessionID);
            pendingCandidate.delete(sessionID);
            await saveState(sessionID, recordCompaction(await loadState(sessionID)));
            return;
          }
          case "session.idle": {
            // Quiescent firing point only — never a boundary signal by itself.
            if (!sessionID || !pendingCandidate.has(sessionID)) return;
            pendingCandidate.delete(sessionID);
            await evaluate(sessionID);
            return;
          }
          default:
            return;
        }
      } catch (error) {
        log("warn", `occ: event fail-open: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    // Bounded plan summary into the compaction prompt (mapping.md §3).
    "experimental.session.compacting": async (hookInput, output) => {
      try {
        const state = await loadState(hookInput.sessionID);
        if (state.plan.length === 0) return;
        output.context.push(formatPlanSnapshot(state.plan));
      } catch {
        // fail-open: default compaction prompt untouched
      }
    },

    // experimental.compaction.autocontinue intentionally NOT registered:
    // the 1.x default (enabled: true) injects the synthetic "Continue…"
    // turn, which is SoL-Pi's plan continuation. There is no config knob
    // to disable it in P3; leaving the hook absent keeps enabled:true.
  };
}
