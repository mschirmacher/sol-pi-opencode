/**
 * Candidate identification + eligibility for the Evidence-Preserving Reducer,
 * ported from SoL-Pi candidate.ts to the opencode 1.x tool.execute.after
 * surface (input:{tool,sessionID,callID,args}, output:{title,output,metadata}).
 *
 * opencode differences from Pi:
 * - No isError flag on the after-hook: the bash/shell tool reports the exit
 *   code in output.metadata.exit (tool/shell.ts:589), so isError = exit !== 0.
 * - Large outputs are truncated BEFORE the after-hook (research Q2); the exact
 *   bytes are in the file named by metadata.outputPath when metadata.truncated
 *   is set — read them from there so quotes are verified against the real log.
 * - Fused edit/write outputs carry the Action Fusion then_run tags
 *   ([then_run:succeeded|failed]) appended to the original output.
 */
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { THEN_RUN_FAILED, THEN_RUN_SUCCEEDED } from "../action-fusion/result.js";
import { DIAGNOSTIC_COMMAND, LIKELY_SECRET, recordValue } from "./config.js";

export interface AfterToolInput {
  tool: string;
  args: unknown;
}

export interface AfterToolOutput {
  output: string;
  metadata: unknown;
}

export interface ReducibleToolResult {
  readonly command: string;
  readonly body: string;
  readonly isError: boolean;
  /** Replace the log section of the output with the receipt, leaving the rest alone. */
  readonly projectReceipt: (receipt: string) => string;
}

export type IneligibilityReason =
  | "not-a-candidate"
  | "command-not-diagnostic"
  | "below-min-log-bytes"
  | "over-max-chars"
  | "likely-secret";

/**
 * Prefer the untruncated file opencode wrote for a large tool result, so
 * evidence is checked against the exact bytes the command produced rather
 * than a head/tail preview.
 */
async function exactBodyFromOutput(output: string, metadata: unknown): Promise<string> {
  if (recordValue(metadata, "truncated") !== true) return output;
  const path = recordValue(metadata, "outputPath");
  if (typeof path !== "string" || !isAbsolute(path)) return output;
  try {
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink()) return output;
    return await readFile(path, "utf8");
  } catch {
    return output;
  }
}

/** Identify the log inside a tool result, or undefined when it is not one. */
export async function reducibleToolResult(
  input: AfterToolInput,
  output: AfterToolOutput,
): Promise<ReducibleToolResult | undefined> {
  if (input.tool === "bash") {
    const command = recordValue(input.args, "command");
    if (typeof command !== "string" || !command) return undefined;
    const exit = recordValue(output.metadata, "exit");
    const isError = typeof exit === "number" && exit !== 0;
    const body = await exactBodyFromOutput(output.output, output.metadata);
    return { command, body, isError, projectReceipt: (receipt) => receipt };
  }
  if (input.tool !== "write" && input.tool !== "edit") return undefined;
  const thenRun = recordValue(input.args, "thenRun");
  const command = recordValue(thenRun, "command");
  if (typeof command !== "string" || !command) return undefined;
  const marker = output.output.includes(THEN_RUN_FAILED) ? THEN_RUN_FAILED : THEN_RUN_SUCCEEDED;
  const markerIndex = output.output.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const suffixStart = markerIndex + marker.length;
  const suffix = output.output.slice(suffixStart);
  const separator = suffix.match(/^(?:\r?\n)+/u)?.[0] ?? "\n";
  const inline = suffix.slice(separator === "\n" && !suffix.startsWith("\n") ? 0 : separator.length);
  const isError = marker === THEN_RUN_FAILED;
  const body = await exactBodyFromOutput(inline, output.metadata);
  return {
    command,
    body,
    isError,
    projectReceipt: (receipt) => `${output.output.slice(0, suffixStart)}${separator}${receipt}`,
  };
}

/** Pure eligibility gate: which tool outputs qualify for reduction. */
export function ineligibilityReason(
  reducible: ReducibleToolResult | undefined,
  limits: { minLogBytes: number; maxChars: number },
): IneligibilityReason | undefined {
  if (!reducible) return "not-a-candidate";
  if (!DIAGNOSTIC_COMMAND.test(reducible.command)) return "command-not-diagnostic";
  if (Buffer.byteLength(reducible.body, "utf8") < limits.minLogBytes) return "below-min-log-bytes";
  if (reducible.body.length > limits.maxChars) return "over-max-chars";
  if (LIKELY_SECRET.test(reducible.body)) return "likely-secret";
  return undefined;
}
