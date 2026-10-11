/**
 * Combined-observation formatting for Action Fusion. One tool result reaches
 * the model: the original edit/write output plus a tagged then_run section
 * (tags per SoL-Pi: [then_run:succeeded|failed|skipped]). stdout/stderr are
 * bounded to a byte tail so the fused observation cannot blow up context.
 */

import type { CommandResult } from "./runner.js";

export const THEN_RUN_SUCCEEDED = "[then_run:succeeded]";
export const THEN_RUN_FAILED = "[then_run:failed]";
export const THEN_RUN_SKIPPED = "[then_run:skipped]";

export const TAIL_BYTES = 8 * 1024;

export function tail(text: string, maxBytes: number = TAIL_BYTES): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return text;
  // Slice bytes, then drop a possibly partial leading UTF-8 sequence.
  return Buffer.from(buf.subarray(buf.byteLength - maxBytes)).toString("utf8").replace(/^[^\n]*\n/, "");
}

export function succeededNote(result: CommandResult): string {
  const out = tail(result.stdout).trimEnd();
  const err = tail(result.stderr).trimEnd();
  const parts = [THEN_RUN_SUCCEEDED];
  if (out) parts.push(out);
  if (err) parts.push(`[stderr]\n${err}`);
  return parts.join("\n");
}

export function failedNote(result: CommandResult): string {
  const parts = [
    result.timedOut
      ? `${THEN_RUN_FAILED} command timed out (exit ${result.exitCode})`
      : `${THEN_RUN_FAILED} command exited with code ${result.exitCode}`,
  ];
  const out = tail(result.stdout).trimEnd();
  const err = tail(result.stderr).trimEnd();
  if (out) parts.push(out);
  if (err) parts.push(`[stderr]\n${err}`);
  return parts.join("\n");
}

export function skippedNote(reason: string): string {
  return `${THEN_RUN_SKIPPED} ${reason}; the command was not run.`;
}

/** Append a then_run section to the original tool output (single observation). */
export function combineObservation(original: string, note: string): string {
  return original ? `${original}\n\n${note}` : note;
}
