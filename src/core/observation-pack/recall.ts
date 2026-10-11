import { constants } from "node:fs";
import { open } from "node:fs/promises";

const READ_OBJECT_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;

export interface RecallPage {
  readonly text: string;
  readonly bytes: number;
  readonly lines: number;
  readonly nextOffset: number;
  readonly eof: boolean;
}

export interface RecallLimits {
  readonly maxBytes: number;
  readonly maxLines: number;
}

function countBufferLines(buffer: Buffer): number {
  if (buffer.length === 0) return 0;
  let lines = buffer[buffer.length - 1] === 0x0a ? 0 : 1;
  for (const byte of buffer) {
    if (byte === 0x0a) lines += 1;
  }
  return lines;
}

function trimUtf8End(buffer: Buffer, limit: number): number {
  let end = limit;
  while (end > 0 && end < buffer.length && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return end;
}

/**
 * Read an exact byte page from an archived observation. Never splits a UTF-8
 * character; stops at a whole line when maxLines is reached.
 */
export async function readRecallPage(path: string, offset: number, limits: RecallLimits): Promise<RecallPage> {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(`invalid offset: ${offset}`);
  }
  const handle = await open(path, READ_OBJECT_FLAGS);
  try {
    const fileStats = await handle.stat();
    if (!fileStats.isFile()) throw new Error("stored observation is not a regular file");
    if (offset > fileStats.size) throw new Error(`offset ${offset} exceeds observation size ${fileStats.size}`);

    const available = Math.max(0, fileStats.size - offset);
    const buffer = Buffer.alloc(Math.min(available, limits.maxBytes + 4));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    let end = Math.min(bytesRead, limits.maxBytes);
    let newlineCount = 0;

    for (let index = 0; index < end; index += 1) {
      if (buffer[index] !== 0x0a) continue;
      newlineCount += 1;
      if (newlineCount === limits.maxLines) {
        end = index + 1;
        break;
      }
    }

    end = trimUtf8End(buffer, end);
    const chunk = buffer.subarray(0, end);
    const nextOffset = offset + chunk.length;
    return {
      text: chunk.toString("utf8"),
      bytes: chunk.length,
      lines: countBufferLines(chunk),
      nextOffset,
      eof: nextOffset >= fileStats.size,
    };
  } finally {
    await handle.close();
  }
}

export function formatRecallResult(handle: string, offset: number, page: RecallPage): string {
  const header = [
    `[sol_pi_recall handle=${handle} offset=${offset} next_offset=${page.nextOffset} eof=${page.eof}]`,
    `[chunk_bytes=${page.bytes} chunk_lines=${page.lines}; use next_offset to continue]`,
  ].join("\n");
  return `${header}\n${page.text}`;
}
