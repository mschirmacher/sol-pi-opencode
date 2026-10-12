/**
 * Action Fusion — opencode 2.x adapter (mapping.md §2 "2.x sketch").
 *
 * - `ctx.tool.transform(editor.update)` on edit/write: append description
 *   guidance; extend the input JSON Schema with `thenRun` when the built-in
 *   tool's `input` is a plain JSON Schema object.
 *   DEVIATION (types): `Tool.Info.input` is `ValueSchema` (Effect Codec |
 *   Standard Schema | JSON Schema). If a built-in tool carries an Effect
 *   Schema we cannot extend it as JSON — we then apply guidance only and the
 *   before-hook still strips/absorbs `thenRun` if the model sends it.
 * - `ctx.tool.hook("execute.before")`: the event's `input` is mutable
 *   (verified in @opencode/plugin 2.0.26 types) — capture + strip `thenRun`.
 * - `ctx.tool.hook("execute.after")`: fused run (own child_process spawn —
 *   no `$` in 2.x), tags, sha256 guard, per-file queue, allowList; rewrite
 *   the mutable `event.result`.
 */
import { resolve } from "node:path";
import type { Plugin } from "@opencode/plugin";
import type { Registration } from "@opencode/plugin/promise/registration";
import type { ActionFusionConfig } from "../core/config.js";
import { fuseThenRun, type ThenRunEntry } from "../core/action-fusion/fusion.js";
import { withFileQueue } from "../core/action-fusion/queue.js";
import { createNodeRunner } from "../core/action-fusion/runner.js";
import { combineObservation, skippedNote } from "../core/action-fusion/result.js";
import { appendGuidance, extendParametersSchema, THEN_RUN_PROPERTY } from "../core/action-fusion/schema.js";
import { isRecord, resultText, withResultText } from "./shared.js";

export type ActionFusionContext = Pick<Plugin.Context, "tool" | "location">;

const FUSION_TOOLS = new Set(["edit", "write"]);
const PENDING_TTL_MS = 10 * 60 * 1000;

function isPlainJsonSchema(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && (typeof value.type === "string" || isRecord(value.properties));
}

export async function registerActionFusion(
  ctx: ActionFusionContext,
  config: ActionFusionConfig,
): Promise<Plugin.Cleanup> {
  if (!config.enabled) return () => {};

  const runner = createNodeRunner();
  const cwd = ctx.location.directory;
  const pending = new Map<string, { entry: ThenRunEntry; at: number }>();

  const sweep = (): void => {
    const now = Date.now();
    for (const [callID, item] of pending) {
      if (now - item.at > PENDING_TTL_MS) pending.delete(callID);
    }
  };

  const registrations: Array<Promise<Registration>> = [];

  registrations.push(
    ctx.tool.transform((editor) => {
      for (const toolID of FUSION_TOOLS) {
        editor.update(toolID, (tool) => {
          tool.description = appendGuidance(tool.description, toolID);
          try {
            if (isPlainJsonSchema(tool.input)) {
              tool.input = extendParametersSchema(tool.input) as typeof tool.input;
            }
            // Effect-Schema inputs are left untouched (see header DEVIATION note).
          } catch {
            // fail-open: guidance-only extension
          }
        });
      }
    }),
  );

  registrations.push(
    ctx.tool.hook("execute.before", (event) => {
      if (!FUSION_TOOLS.has(event.tool)) return;
      sweep();
      const args = event.input;
      if (!isRecord(args)) return;
      const thenRun = args[THEN_RUN_PROPERTY];
      if (!isRecord(thenRun) || typeof thenRun.command !== "string" || thenRun.command.length === 0) return;
      if (typeof args.filePath !== "string" || args.filePath.length === 0) return;
      // Strip before execution so the built-in tool never sees the key.
      delete args[THEN_RUN_PROPERTY];
      event.input = args;
      pending.set(event.id, {
        entry: {
          path: resolve(cwd, args.filePath),
          thenRun: {
            command: thenRun.command,
            timeout: typeof thenRun.timeout === "number" ? thenRun.timeout : undefined,
          },
        },
        at: Date.now(),
      });
    }),
  );

  registrations.push(
    ctx.tool.hook("execute.after", async (event) => {
      if (!FUSION_TOOLS.has(event.tool)) return;
      const pendingEntry = pending.get(event.id);
      if (!pendingEntry) return;
      pending.delete(event.id);
      if (event.status !== "completed") return;
      try {
        const note = await withFileQueue(pendingEntry.entry.path, () =>
          fuseThenRun(pendingEntry.entry, {
            runner,
            cwd,
            commandTimeoutMs: config.commandTimeoutMs,
            allowList: config.allowList,
          }),
        );
        const text = resultText(event.result);
        if (event.result && typeof text === "string") {
          event.result = withResultText(event.result, combineObservation(text, note));
        }
      } catch (error) {
        // fail-open: keep the edit result, note the skip
        const text = resultText(event.result);
        if (event.result && typeof text === "string") {
          event.result = withResultText(
            event.result,
            combineObservation(text, skippedNote(`action-fusion error: ${error instanceof Error ? error.message : String(error)}`)),
          );
        }
      }
    }),
  );

  const settled = await Promise.allSettled(registrations);
  const disposers = settled
    .filter((r): r is PromiseFulfilledResult<Registration> => r.status === "fulfilled")
    .map((r) => r.value.dispose);

  return async () => {
    for (const dispose of disposers) await dispose().catch(() => undefined);
  };
}
