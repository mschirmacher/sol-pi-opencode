import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * Deterministic safety guards for Action Fusion (mapping.md §2).
 * The sha256 re-check immediately before launching the fused command detects
 * a concurrent change to the target file while the per-file queue was held;
 * any mismatch → skip with [then_run:skipped] (SoL-Pi behavior).
 */

export type FileHasher = (path: string) => Promise<string>;

export async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export type GuardOutcome = { ok: true } | { ok: false; reason: string };

/**
 * Double-hash around a yield point: if the file content changes across the
 * yield (another writer interleaved), the fused command must not run.
 * Mirrors SoL-Pi's assertUnchangedBeforeCommand.
 */
export async function checkUnchanged(
  path: string,
  hashFile: FileHasher = sha256File,
  yieldForInterference: () => Promise<void> = () => new Promise<void>((resolve) => setImmediate(resolve)),
): Promise<GuardOutcome> {
  try {
    const mutationHash = await hashFile(path);
    await yieldForInterference();
    const commandHash = await hashFile(path);
    if (mutationHash !== commandHash) {
      return { ok: false, reason: "target content changed after the fused mutation" };
    }
    return { ok: true };
  } catch (error) {
    const code = (error as { code?: string })?.code;
    const detail = code === "ENOENT" ? `target file not found: ${path}` : error instanceof Error ? error.message : String(error);
    return { ok: false, reason: detail };
  }
}

/**
 * Security gate (mapping.md §2 risks): fused commands bypass the bash tool's
 * permission flow. When `allowList` (regex source strings) is non-empty, a
 * command must match at least one pattern or it is skipped. Invalid regex
 * patterns never match (fail-closed for the pattern, fail-open for the flow).
 */
export function isCommandAllowed(command: string, allowList: readonly string[]): boolean {
  if (allowList.length === 0) return true;
  for (const source of allowList) {
    try {
      if (new RegExp(source).test(command)) return true;
    } catch {
      // invalid pattern: ignore it
    }
  }
  return false;
}
