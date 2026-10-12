/**
 * Shared helpers for the opencode 2.x adapters (P5).
 *
 * Type deviations found in @opencode/plugin 2.0.26 vs docs/research:
 * - `ctx.generate.text({prompt, model?})` model shape is
 *   `{id, providerID, variant?}` — NOT v1's `{providerID, modelID}`.
 * - `tool.hook("execute.after")` event carries `status: "completed"|"error"`
 *   and a mutable `result: Tool.Result` (`{output?, content?, metadata?}`) —
 *   there is no single `output` string like in 1.x.
 * - `session.hook("context")` messages are `@opencode/ai` `Message`s
 *   (`{role, content: ContentPart[]}`); tool results are
 *   `{type:"tool-result", id, name, result: {type:"text"|"json"|"error"|"content", value}}`.
 * - There is NO `todo.updated` event in the 2.x event union; plan boundaries
 *   must be observed on the todo tool's `execute.after` instead.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { Result as ToolResult } from "@opencode/plugin/promise/tool";

/** Same layout as v1 (mapping.md question (c)); archives stay on disk in 2.x too. */
export function archiveDirFor(sessionID: string): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "opencode", "sol-pi", sessionID);
}

/** Best-effort plain-text view of a 2.x Tool.Result. */
export function resultText(result: ToolResult | undefined): string | undefined {
  if (!result) return undefined;
  if (typeof result.output === "string") return result.output;
  if (typeof result.content === "string") return result.content;
  if (Array.isArray(result.content)) {
    const texts = result.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text);
    if (texts.length > 0) return texts.join("\n");
  }
  return undefined;
}

/** Copy-on-write text replacement inside a Tool.Result (output preferred). */
export function withResultText(result: ToolResult, text: string): ToolResult {
  if (typeof result.output === "string") return { ...result, output: text };
  if (result.content !== undefined) return { ...result, content: text };
  return { ...result, output: text };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
