/**
 * Content-addressed archive of the exact raw log bytes, ported from SoL-Pi
 * archive.ts. Every quote in a receipt is checked against this archive, and
 * the receipt points the agent back at this path for exact readback. An
 * existing object with the same name but different bytes is an integrity
 * failure, not a cache hit.
 *
 * Lives under the same XDG-cache session dir as ObservationPack (mapping.md
 * question (c)) but in its own `reducer/objects` subtree: ObservationPack's
 * archive util is not reused because it is threshold-gated, skips reducer
 * receipts, and keys objects by tool+callID rather than by raw content hash.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord, sha256 } from "./config.js";

export interface ArchiveObject {
  readonly hash: string;
  readonly bytes: number;
  readonly chars: number;
  readonly lines: number;
  readonly path: string;
}

export function archiveRoot(dir: string): string {
  return join(dir, "reducer");
}

export async function archiveBody(root: string, body: string): Promise<ArchiveObject> {
  const hash = sha256(body);
  const objectDir = join(root, "objects", hash.slice(0, 2));
  const path = join(objectDir, `${hash}.txt`);
  await mkdir(objectDir, { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!isRecord(error) || error.code !== "EEXIST") throw error;
    const existing = await readFile(path, "utf8");
    if (existing !== body || sha256(existing) !== hash) {
      throw new Error(`Reducer archive integrity failure: ${path}`);
    }
  }
  return {
    hash,
    bytes: Buffer.byteLength(body, "utf8"),
    chars: body.length,
    lines: body.length === 0 ? 0 : body.split("\n").length,
    path,
  };
}
