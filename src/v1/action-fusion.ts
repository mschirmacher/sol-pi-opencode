import { resolve } from "node:path";
import { Schema } from "effect";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import type { ActionFusionConfig } from "../core/config.js";
import { fuseThenRun, type ThenRunEntry } from "../core/action-fusion/fusion.js";
import { withFileQueue } from "../core/action-fusion/queue.js";
import { createNodeRunner } from "../core/action-fusion/runner.js";
import { combineObservation, skippedNote } from "../core/action-fusion/result.js";
import {
  appendGuidance,
  extendParametersSchema,
  THEN_RUN_PROPERTY,
  type ThenRunInput,
} from "../core/action-fusion/schema.js";

/**
 * Action Fusion for opencode 1.x (mapping.md §2).
 *
 * SECURITY NOTE (mapping.md §2 risks): fused commands bypass the `bash`
 * tool's permission flow entirely — they are spawned directly from this
 * plugin. Mitigations: mechanism is default-off; optional
 * `actionFusion.allowList` (regex sources) gates commands when non-empty;
 * the per-file sha256 guard skips on concurrent change; everything is
 * fail-open so the edit/write observation is never corrupted.
 *
 * Verified against v1.19.0 source (_refs/opencode-v1.19.0):
 * - `tool.execute.before` receives the SAME `args` object that is passed to
 *   `item.execute` (session/tools.ts:106-111), so deleting `thenRun` here
 *   hides it from the built-in executor.
 * - The built-in executor decodes args with Effect `Schema.Struct` via the
 *   wrapper in tool/tool.ts:110-127, which STRIPS excess properties — the
 *   built-in tolerates unknown keys. We still strip `thenRun` so behavior is
 *   version-independent and the after-hook can recover it via the pending map.
 * - `tool.definition` (tool/registry.ts:313-321): the runtime output bag also
 *   carries `jsonSchema` (absent from the declared plugin type). For built-in
 *   tools `parameters` is an Effect Schema and `jsonSchema` is undefined; the
 *   registry uses `output.jsonSchema` whenever it was changed while
 *   `parameters` stayed referentially equal. So we convert the Effect Schema
 *   to JSON Schema, extend it, and set `jsonSchema` — the model-facing schema
 *   changes while the executor's decode schema stays untouched.
 * - `tool.execute.after` rewrites of `output.output` are what the model sees
 *   AND what gets persisted (docs/research/opencode-v1-internals.md Q3/Q5) →
 *   the single combined observation is validated.
 */

const FUSION_TOOLS = new Set(["edit", "write"]);
const PENDING_TTL_MS = 10 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strip `{type:"null"}` branches that optional Effect fields compile into. */
function simplifyJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(simplifyJsonSchema);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "additionalProperties" && item === true) continue;
    out[key] = simplifyJsonSchema(item);
  }
  if (Array.isArray(out.anyOf)) {
    const kept = out.anyOf.filter((branch) => !(isRecord(branch) && branch.type === "null"));
    if (kept.length !== out.anyOf.length) {
      delete out.anyOf;
      if (kept.length === 1) return { ...out, ...(isRecord(kept[0]) ? kept[0] : { type: kept[0] }) };
      out.anyOf = kept;
    }
  }
  return out;
}

function toJsonSchema(parameters: unknown, existing: unknown): Record<string, unknown> | undefined {
  if (isRecord(existing) && (typeof existing.type === "string" || isRecord(existing.properties))) return existing;
  if (isRecord(parameters) && (typeof parameters.type === "string" || isRecord(parameters.properties))) {
    return parameters;
  }
  if (isRecord(parameters) && "ast" in parameters) {
    const doc = Schema.toJsonSchemaDocument(parameters as never, { additionalProperties: true });
    const schema = simplifyJsonSchema(doc.schema);
    return isRecord(schema) ? schema : undefined;
  }
  return undefined;
}

export function createActionFusionHooks(input: PluginInput, config: ActionFusionConfig): Hooks {
  if (!config.enabled) return {};

  const runner = createNodeRunner();
  const cwd = input.worktree || input.directory;
  const pending = new Map<string, { entry: ThenRunEntry; at: number }>();

  const sweep = (): void => {
    const now = Date.now();
    for (const [callID, item] of pending) {
      if (now - item.at > PENDING_TTL_MS) pending.delete(callID);
    }
  };

  return {
    "tool.definition": async (hookInput, output) => {
      if (!FUSION_TOOLS.has(hookInput.toolID)) return;
      output.description = appendGuidance(output.description, hookInput.toolID);
      try {
        const bag = output as unknown as { parameters?: unknown; jsonSchema?: unknown };
        const base = toJsonSchema(bag.parameters, bag.jsonSchema);
        if (!base) return;
        bag.jsonSchema = extendParametersSchema(base);
      } catch {
        // fail-open: guidance-only extension
      }
    },

    "tool.execute.before": async (hookInput, output) => {
      if (!FUSION_TOOLS.has(hookInput.tool)) return;
      sweep();
      const args = output.args;
      if (!isRecord(args)) return;
      const thenRun = args[THEN_RUN_PROPERTY];
      if (!isRecord(thenRun) || typeof thenRun.command !== "string" || thenRun.command.length === 0) return;
      if (typeof args.filePath !== "string" || args.filePath.length === 0) return;
      // Strip before execution so the built-in tool never sees the key.
      delete args[THEN_RUN_PROPERTY];
      pending.set(hookInput.callID, {
        entry: {
          path: resolve(input.directory, args.filePath),
          thenRun: { command: thenRun.command, timeout: typeof thenRun.timeout === "number" ? thenRun.timeout : undefined },
        },
        at: Date.now(),
      });
    },

    "tool.execute.after": async (hookInput, output) => {
      if (!FUSION_TOOLS.has(hookInput.tool)) return;
      const pendingEntry = pending.get(hookInput.callID);
      if (!pendingEntry) return;
      pending.delete(hookInput.callID);
      try {
        const note = await withFileQueue(pendingEntry.entry.path, () =>
          fuseThenRun(pendingEntry.entry, {
            runner,
            cwd,
            commandTimeoutMs: config.commandTimeoutMs,
            allowList: config.allowList,
          }),
        );
        if (typeof output.output === "string") {
          output.output = combineObservation(output.output, note);
        }
      } catch (error) {
        // fail-open: keep the edit result, note the skip
        if (typeof output.output === "string") {
          output.output = combineObservation(
            output.output,
            skippedNote(`action-fusion error: ${error instanceof Error ? error.message : String(error)}`),
          );
        }
      }
    },
  };
}
