import { checkUnchanged, isCommandAllowed, type FileHasher } from "./guard.js";
import type { CommandRunner } from "./runner.js";
import { failedNote, skippedNote, succeededNote } from "./result.js";
import type { ThenRunInput } from "./schema.js";

/**
 * Pure orchestration of one fused operation: allow-list gate → sha256
 * unchanged-guard → command run → tagged observation note.
 * Fail-open: any error yields a [then_run:skipped] note; the edit/write
 * result itself is never touched.
 */

export interface ThenRunEntry {
  /** Absolute path of the mutated target file. */
  path: string;
  thenRun: ThenRunInput;
}

export interface FusionDeps {
  runner: CommandRunner;
  cwd: string;
  commandTimeoutMs: number;
  allowList: readonly string[];
  hashFile?: FileHasher;
}

export async function fuseThenRun(entry: ThenRunEntry, deps: FusionDeps): Promise<string> {
  const command = entry.thenRun.command;
  try {
    if (!isCommandAllowed(command, deps.allowList)) {
      return skippedNote(`command not on actionFusion.allowList: ${command}`);
    }
    const guard = await checkUnchanged(entry.path, deps.hashFile);
    if (!guard.ok) return skippedNote(guard.reason);
    const timeoutMs =
      typeof entry.thenRun.timeout === "number" && entry.thenRun.timeout > 0
        ? Math.min(entry.thenRun.timeout * 1000, deps.commandTimeoutMs)
        : deps.commandTimeoutMs;
    const result = await deps.runner.run(command, deps.cwd, timeoutMs);
    return result.exitCode === 0 && !result.timedOut ? succeededNote(result) : failedNote(result);
  } catch (error) {
    return skippedNote(`action-fusion error: ${error instanceof Error ? error.message : String(error)}`);
  }
}
