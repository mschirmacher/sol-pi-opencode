import { homedir } from "node:os";
import { join } from "node:path";
import { tool, type Hooks, type PluginInput } from "@opencode-ai/plugin";
import type { ObservationPackConfig } from "../core/config.js";
import { createObservation, ensureStored, isObservationId, observationPath } from "../core/observation-pack/archive.js";
import { RECALL_LIMITS, RECALL_MAX_BYTES, RECALL_TOOL_NAME } from "../core/observation-pack/constants.js";
import { Ledger } from "../core/observation-pack/ledger.js";
import { planProjection, type ProjectionPartShape } from "../core/observation-pack/projection.js";
import { formatRecallResult, readRecallPage } from "../core/observation-pack/recall.js";

/**
 * Archive location (mapping.md question (c)): XDG cache keyed by sessionID,
 * falling back to the OS temp dir.
 */
export function archiveDirFor(input: PluginInput, sessionID: string): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "opencode", "sol-pi", sessionID);
}

interface MutablePart extends ProjectionPartShape {
  [key: string]: unknown;
}

export function createObservationPackHooks(input: PluginInput, config: ObservationPackConfig): Hooks {
  if (!config.enabled) return {};

  const ledger = new Ledger();

  const log = (level: "debug" | "info" | "warn" | "error", message: string, extra?: unknown): void => {
    try {
      const app = (input.client as unknown as { app?: { log?: (arg: { body: unknown }) => unknown } })?.app;
      void app?.log?.({ body: { service: "sol-pi", level, message, extra } });
    } catch {
      // logging must never break the mechanism
    }
  };

  return {
    // Archive large tool results; do NOT replace here — the first
    // fullSends provider requests must still carry the full payload.
    "tool.execute.after": async (hookInput, output) => {
      try {
        if (hookInput.tool === RECALL_TOOL_NAME) return;
        const text = output.output;
        if (typeof text !== "string" || text.length === 0) return;
        const observation = createObservation({
          toolName: hookInput.tool,
          callID: hookInput.callID,
          text,
          dir: archiveDirFor(input, hookInput.sessionID),
          thresholdBytes: config.thresholdBytes,
        });
        if (!observation) return;
        await ensureStored(observation);
        ledger.record(hookInput.callID, { sha256: observation.contentHash, size: observation.bytes, sends: 0 });
      } catch (error) {
        log("warn", `observation-pack: archive fail-open: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    // Projection point: rewrite only the projected copy, never stored history.
    "experimental.chat.messages.transform": async (_hookInput, output) => {
      try {
        const plan = planProjection(
          output.messages as unknown as { parts?: readonly ProjectionPartShape[] }[],
          ledger,
          config,
        );
        for (const callID of plan.sendIncrements) ledger.incrementSends(callID);
        for (const replacement of plan.replacements) {
          const parts = output.messages[replacement.messageIndex]?.parts as MutablePart[] | undefined;
          const part = parts?.[replacement.partIndex];
          if (!parts || !part?.state) continue;
          // Copy-on-write: new part + state objects; the original objects are
          // never mutated in case they are live references into history.
          parts[replacement.partIndex] = {
            ...part,
            state: { ...part.state, output: replacement.placeholder },
          };
          ledger.incrementSends(replacement.callID);
        }
      } catch (error) {
        log("warn", `observation-pack: projection fail-open: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    tool: {
      [RECALL_TOOL_NAME]: tool({
        description:
          "Read an exact byte page from a stored large tool result. Use the handle from a placeholder line; continue with the returned next_offset until eof=true.",
        args: {
          handle: tool.schema.string().describe("Observation handle from a placeholder, obs_<24 hex chars>"),
          offset: tool.schema.number().int().min(0).optional().describe("Byte offset into the archived payload, default 0"),
          limit: tool.schema.number().int().min(1).max(RECALL_MAX_BYTES).optional().describe("Maximum bytes to return"),
        },
        async execute(args, context) {
          try {
            if (!isObservationId(args.handle)) return `unknown observation handle: ${args.handle}`;
            const path = observationPath(archiveDirFor(input, context.sessionID), args.handle);
            const page = await readRecallPage(path, args.offset ?? 0, {
              maxBytes: args.limit ?? RECALL_LIMITS.maxBytes,
              maxLines: RECALL_LIMITS.maxLines,
            });
            return formatRecallResult(args.handle, args.offset ?? 0, page);
          } catch (error) {
            const code = (error as { code?: string })?.code;
            if (code === "ENOENT") return `unknown observation handle: ${args.handle}`;
            return `sol_pi_recall failed: ${error instanceof Error ? error.message : String(error)}`;
          }
        },
      }),
    },
  };
}
