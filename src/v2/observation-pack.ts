/**
 * ObservationPack — opencode 2.x adapter (mapping.md §1 "2.x sketch").
 *
 * - `ctx.tool.hook("execute.after")`: archive large tool results; NO result
 *   replacement here — the first `fullSends` requests still carry the payload.
 * - `ctx.session.hook("context")`: the stable projection point (replaces
 *   `experimental.chat.messages.transform`). Edits `event.messages`
 *   copy-on-write at part level; stored history is never touched.
 * - Recall tool via `ctx.tool.transform(editor.add)` — JSON Schema input,
 *   `{content}` result (no Zod / `tool()` helper in 2.x).
 * - Ledger persisted via `ctx.storage` (plugin-id-scoped JSON); raw archives
 *   stay on disk (storage is JSON-only).
 */
import type { Plugin } from "@opencode/plugin";
import type { Registration } from "@opencode/plugin/promise/registration";
import type { ObservationPackConfig } from "../core/config.js";
import {
  createObservation,
  ensureStored,
  isObservationId,
  observationPath,
} from "../core/observation-pack/archive.js";
import { RECALL_LIMITS, RECALL_MAX_BYTES, RECALL_TOOL_NAME } from "../core/observation-pack/constants.js";
import { Ledger, type LedgerEntry } from "../core/observation-pack/ledger.js";
import { planProjection, type ProjectionMessageShape, type ProjectionPartShape } from "../core/observation-pack/projection.js";
import { formatRecallResult, readRecallPage } from "../core/observation-pack/recall.js";
import { archiveDirFor, isRecord, resultText } from "./shared.js";

export type ObservationPackContext = Pick<Plugin.Context, "tool" | "session" | "storage">;

const LEDGER_KEY = "observation-pack/ledger";

/** Structural view of a 2.x tool-result ContentPart (subset we rely on). */
interface ToolResultPartView {
  type: "tool-result";
  id: string;
  name: string;
  result: { type: string; value: unknown };
}

function isToolResultPart(part: unknown): part is ToolResultPartView {
  if (!isRecord(part) || part.type !== "tool-result") return false;
  return (
    typeof part.id === "string" &&
    typeof part.name === "string" &&
    isRecord(part.result) &&
    typeof part.result.type === "string"
  );
}

function toolResultText(part: ToolResultPartView): string | undefined {
  if (part.result.type === "text" && typeof part.result.value === "string") return part.result.value;
  if (part.result.type === "content" && Array.isArray(part.result.value)) {
    const texts = (part.result.value as readonly { type?: string; text?: string }[])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string);
    if (texts.length > 0) return texts.join("\n");
  }
  return undefined;
}

export async function registerObservationPack(
  ctx: ObservationPackContext,
  config: ObservationPackConfig,
): Promise<Plugin.Cleanup> {
  if (!config.enabled) return () => {};

  const ledger = new Ledger();
  const sends = new Map<string, LedgerEntry>();

  const persistLedger = (): void => {
    const snapshot: Record<string, { sha256: string; size: number; sends: number }> = {};
    for (const [callID, entry] of sends) snapshot[callID] = { sha256: entry.sha256, size: entry.size, sends: entry.sends };
    void ctx.storage.set(LEDGER_KEY, snapshot).catch(() => undefined);
  };

  const restored = await ctx.storage.get(LEDGER_KEY).catch(() => undefined);
  if (isRecord(restored)) {
    for (const [callID, entry] of Object.entries(restored)) {
      if (
        isRecord(entry) &&
        typeof entry.sha256 === "string" &&
        typeof entry.size === "number" &&
        typeof entry.sends === "number"
      ) {
        const value = { sha256: entry.sha256, size: entry.size, sends: entry.sends };
        ledger.record(callID, value);
        sends.set(callID, value);
      }
    }
  }

  const registrations: Array<Promise<Registration>> = [];

  // Archive only — no result rewrite (fullSends semantics).
  registrations.push(
    ctx.tool.hook("execute.after", (event) => {
      try {
        if (event.tool === RECALL_TOOL_NAME) return;
        if (event.status !== "completed") return;
        const text = resultText(event.result);
        if (!text) return;
        const observation = createObservation({
          toolName: event.tool,
          callID: event.id,
          text,
          dir: archiveDirFor(event.sessionID),
          thresholdBytes: config.thresholdBytes,
        });
        if (!observation) return;
        void ensureStored(observation).then(() => {
          const entry = { sha256: observation.contentHash, size: observation.bytes, sends: 0 };
          ledger.record(event.id, entry);
          sends.set(event.id, entry);
          persistLedger();
        });
      } catch {
        // fail-open: archiving must never break the tool result
      }
    }),
  );

  // Projection: count sends, replace after fullSends, copy-on-write.
  registrations.push(
    ctx.session.hook("context", (event) => {
      try {
        const views: Array<Array<{ index: number }>> = [];
        const shapes: ProjectionMessageShape[] = [];
        for (const message of event.messages) {
          const parts: ProjectionPartShape[] = [];
          const view: Array<{ index: number }> = [];
          for (let i = 0; i < message.content.length; i += 1) {
            const part = message.content[i];
            if (!isToolResultPart(part)) continue;
            const output = toolResultText(part);
            if (output === undefined) continue;
            parts.push({ type: "tool", tool: part.name, callID: part.id, state: { status: "completed", output } });
            view.push({ index: i });
          }
          views.push(view);
          shapes.push({ parts });
        }

        const plan = planProjection(shapes, ledger, config);
        for (const callID of plan.sendIncrements) {
          ledger.incrementSends(callID);
          const entry = sends.get(callID);
          if (entry) entry.sends += 1;
        }
        for (const replacement of plan.replacements) {
          const partIndex = views[replacement.messageIndex]?.[replacement.partIndex]?.index;
          if (partIndex === undefined) continue;
          const message = event.messages[replacement.messageIndex];
          if (!message) continue;
          const part = message.content[partIndex];
          if (!isToolResultPart(part)) continue;
          // Copy-on-write: 2.x Message.content is readonly, so the message is
          // replaced with a new content array; stored history is never touched.
          const nextContent = message.content.slice();
          nextContent[partIndex] = { ...part, result: { type: "text", value: replacement.placeholder } };
          event.messages[replacement.messageIndex] = { ...message, content: nextContent };
          ledger.incrementSends(replacement.callID);
          const entry = sends.get(replacement.callID);
          if (entry) entry.sends += 1;
        }
        if (plan.sendIncrements.length > 0 || plan.replacements.length > 0) persistLedger();
      } catch {
        // fail-open: the request goes out unmodified
      }
    }),
  );

  // Recall tool via transform(editor.add).
  registrations.push(
    ctx.tool.transform((editor) => {
      editor.add({
        name: RECALL_TOOL_NAME,
        description:
          "Read an exact byte page from a stored large tool result. Use the handle from a placeholder line; continue with the returned next_offset until eof=true.",
        input: {
          type: "object",
          properties: {
            handle: { type: "string", description: "Observation handle from a placeholder, obs_<24 hex chars>" },
            offset: { type: "integer", minimum: 0, description: "Byte offset into the archived payload, default 0" },
            limit: { type: "integer", minimum: 1, maximum: RECALL_MAX_BYTES, description: "Maximum bytes to return" },
          },
          required: ["handle"],
        },
        async execute(raw, context) {
          try {
            const args = isRecord(raw) ? raw : {};
            const handle = typeof args.handle === "string" ? args.handle : "";
            if (!isObservationId(handle)) return { content: `unknown observation handle: ${handle}` };
            const path = observationPath(archiveDirFor(context.sessionID), handle);
            const offset = typeof args.offset === "number" ? args.offset : 0;
            const page = await readRecallPage(path, offset, {
              maxBytes: typeof args.limit === "number" ? args.limit : RECALL_LIMITS.maxBytes,
              maxLines: RECALL_LIMITS.maxLines,
            });
            return { content: formatRecallResult(handle, offset, page) };
          } catch (error) {
            const code = (error as { code?: string })?.code;
            if (code === "ENOENT") return { content: "unknown observation handle" };
            return { content: `sol_pi_recall failed: ${error instanceof Error ? error.message : String(error)}` };
          }
        },
      });
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
