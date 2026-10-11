import { RECALL_TOOL_NAME } from "./constants.js";
import type { Observation } from "./archive.js";

/**
 * First line of every placeholder. Its presence marks a part as already
 * replaced, which makes the projection idempotent: an already-replaced part
 * is never re-wrapped.
 */
export const PLACEHOLDER_MARKER = "[large tool result replaced by sol-pi observation-pack]";

const HANDLE_LINE_PATTERN = /^id: (obs_[a-f0-9]{24})$/mu;

export function isReplacedPlaceholder(text: string): boolean {
  return text.startsWith(PLACEHOLDER_MARKER);
}

export function placeholderHandle(text: string): string | undefined {
  return HANDLE_LINE_PATTERN.exec(text)?.[1];
}

function completeLineExcerpt(text: string, budgetBytes: number, fromEnd: boolean): string {
  const lines = text.split(/(?<=\n)/);
  const selected: string[] = [];
  let selectedBytes = 0;
  let index = fromEnd ? lines.length - 1 : 0;

  while (index >= 0 && index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (selectedBytes + lineBytes > budgetBytes) break;
    if (fromEnd) selected.unshift(line);
    else selected.push(line);
    selectedBytes += lineBytes;
    index += fromEnd ? -1 : 1;
  }

  return selected.join("");
}

/**
 * Byte-stable placeholder: identical input always renders identical output,
 * so the prompt-cache prefix stays stable across requests once replaced.
 */
export function placeholderFor(observation: Observation, excerptBytes: number): string {
  const headBudget = Math.floor(excerptBytes / 2);
  const tailBudget = excerptBytes - headBudget;
  const head = completeLineExcerpt(observation.text, headBudget, false);
  const tail = completeLineExcerpt(observation.text, tailBudget, true);
  return [
    PLACEHOLDER_MARKER,
    `id: ${observation.id}`,
    `tool: ${observation.toolName}`,
    `original_bytes: ${observation.bytes}`,
    `original_lines: ${observation.lines}`,
    `estimated_tokens: ${observation.tokens}`,
    `retrieve: call ${RECALL_TOOL_NAME} with {"handle":"${observation.id}","offset":0}; continue with returned next_offset`,
    `[first complete lines, up to ${headBudget} bytes]`,
    head,
    `[middle omitted; last complete lines, up to ${tailBudget} bytes]`,
    tail,
    `[${observation.bytes} original bytes omitted]`,
  ].join("\n");
}
