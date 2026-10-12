/**
 * Online Context Compact — opencode 2.x adapter (mapping.md §3 "2.x sketch").
 *
 * Event clock (real 2.0.26 event names, mirroring the v1 signals):
 * - `session.step.ended` (data.tokens) replaces v1 `message.part.updated`
 *   step-finish: per-request context-token accounting.
 * - `session.idle` replaces v1 `session.idle`: quiescent firing point only.
 * - `session.compaction.ended` replaces v1 `session.compacted`: reconcile.
 * DEVIATION: the 2.x event union has NO `todo.updated` event. Plan
 * boundaries are observed on the built-in todo tool's
 * `ctx.tool.hook("execute.after")` instead (tool name matching /todo/i);
 * same limitation as v1: no todos → no boundaries → OCC never fires.
 *
 * Trigger: `ctx.session.compact({sessionID})` (first-class in 2.x).
 * Summary shaping: `ctx.session.hook("compaction")` pushes the plan snapshot
 * into `event.system` (v1 pushed into `output.context`).
 * State: `ctx.storage` (plugin-id-scoped JSON) replaces the v1 file store.
 */
import type { Plugin } from "@opencode/plugin";
import type { Registration } from "@opencode/plugin/promise/registration";
import type { OnlineContextCompactConfig } from "../core/config.js";
import { analyzePlanTransition, formatPlanSnapshot, todosToPlanSteps, type PlanStep } from "../core/online-context-compact/plan.js";
import { decideCompaction } from "../core/online-context-compact/economics.js";
import {
  averageContextTokenIncrement,
  initialState,
  parseState,
  recordBoundary,
  recordCompaction,
  recordRequest,
  requestsSinceLastCompaction,
  type OnlineCompactState,
} from "../core/online-context-compact/state.js";
import { isRecord, resultText } from "./shared.js";

export type OnlineContextCompactContext = Pick<Plugin.Context, "event" | "session" | "tool" | "storage">;

const MEMO_TOKEN_ESTIMATE = 2_048;
const STATE_KEY_PREFIX = "occ/state/";

function parseTodos(text: string | undefined): readonly { id: string; content: string; status: string }[] | undefined {
  if (!text) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  const list = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.todos)
      ? parsed.todos
      : undefined;
  if (!list) return undefined;
  const todos = list.filter(
    (item): item is { content: string; status: string } =>
      isRecord(item) && typeof item.content === "string" && typeof item.status === "string",
  );
  return todos.map((item, index) => ({ id: String(index), content: item.content, status: item.status }));
}

export async function registerOnlineContextCompact(
  ctx: OnlineContextCompactContext,
  config: OnlineContextCompactConfig,
): Promise<Plugin.Cleanup> {
  if (!config.enabled) return () => {};

  const states = new Map<string, OnlineCompactState>();
  const pendingCandidate = new Set<string>();
  const compactInFlight = new Set<string>();

  const loadState = async (sessionID: string): Promise<OnlineCompactState> => {
    const cached = states.get(sessionID);
    if (cached) return cached;
    const stored = await ctx.storage.get(`${STATE_KEY_PREFIX}${sessionID}`).catch(() => undefined);
    const loaded = parseState(stored) ?? initialState();
    states.set(sessionID, loaded);
    return loaded;
  };

  const saveState = async (sessionID: string, state: OnlineCompactState): Promise<void> => {
    states.set(sessionID, state);
    try {
      await ctx.storage.set(`${STATE_KEY_PREFIX}${sessionID}`, state as never);
    } catch {
      // fail-open: state persistence must never break the session
    }
  };

  const evaluate = async (sessionID: string): Promise<void> => {
    if (compactInFlight.has(sessionID)) return;
    const state = await loadState(sessionID);
    const contextTokens = state.lastContextTokens ?? 0;
    const remainingBoundaries = Math.max(1, state.plan.filter((step) => step.status !== "completed").length);
    const decision = decideCompaction({
      boundaryRequestCounts: state.completedBoundaryRequestCounts,
      remainingBoundaries,
      contextTokens,
      contextWindowTokens: null, // 2.x: window size not resolved here; economics fall back to request-based bound
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
    if (!decision.compact) return;
    compactInFlight.add(sessionID);
    try {
      await ctx.session.compact({ sessionID });
    } catch {
      compactInFlight.delete(sessionID);
      // fail-open: leave the session untouched
    }
  };

  const registrations: Array<Promise<Registration>> = [];

  // Plan boundary candidate: completed step in the built-in todo tool output.
  registrations.push(
    ctx.tool.hook("execute.after", async (event) => {
      try {
        if (!/todo/i.test(event.tool)) return;
        if (event.status !== "completed") return;
        const todos = parseTodos(resultText(event.result));
        if (!todos) return;
        const state = await loadState(event.sessionID);
        const plan = todosToPlanSteps(todos);
        const transition = analyzePlanTransition(state.plan, plan);
        if (transition.completedSteps.length > 0) {
          await saveState(event.sessionID, recordBoundary(state, plan));
          pendingCandidate.add(event.sessionID);
        } else {
          await saveState(event.sessionID, { ...state, plan });
        }
      } catch {
        // fail-open
      }
    }),
  );

  // Plan snapshot into the compaction summary prompt.
  registrations.push(
    ctx.session.hook("compaction", async (event) => {
      try {
        const state = await loadState(event.sessionID);
        if (state.plan.length === 0) return;
        event.system.push({ type: "text", text: formatPlanSnapshot(state.plan) });
      } catch {
        // fail-open: default compaction prompt untouched
      }
    }),
  );

  // Event clock.
  const abort = new AbortController();
  const loop = (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
        try {
          if (event.type === "session.step.ended") {
            const tokens = event.data.tokens;
            const contextTokens =
              tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write;
            const sessionID = event.data.sessionID;
            await saveState(sessionID, recordRequest(await loadState(sessionID), contextTokens));
          } else if (event.type === "session.compaction.ended") {
            const sessionID = event.data.sessionID;
            compactInFlight.delete(sessionID);
            pendingCandidate.delete(sessionID);
            await saveState(sessionID, recordCompaction(await loadState(sessionID)));
          } else if (event.type === "session.idle") {
            // Quiescent firing point only — never a boundary signal by itself.
            const sessionID = event.data.sessionID;
            if (pendingCandidate.has(sessionID)) {
              pendingCandidate.delete(sessionID);
              await evaluate(sessionID);
            }
          }
        } catch {
          // fail-open: one bad event never stops the clock
        }
      }
    } catch {
      // subscription ended (abort or transport error)
    }
  })();
  void loop;

  const settled = await Promise.allSettled(registrations);
  const disposers = settled
    .filter((r): r is PromiseFulfilledResult<Registration> => r.status === "fulfilled")
    .map((r) => r.value.dispose);

  return async () => {
    abort.abort();
    for (const dispose of disposers) await dispose().catch(() => undefined);
  };
}
