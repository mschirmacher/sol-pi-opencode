import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  CHARS_PER_TOKEN,
  EVIDENCE_REDUCER_RECEIPT_PREFIX,
  OBSERVATION_ID_PATTERN,
  THRESHOLD_BYTES,
} from "./constants.js";

const READ_OBJECT_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const CREATE_OBJECT_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

export interface Observation {
  readonly id: string;
  readonly contentHash: string;
  readonly filePath: string;
  readonly toolName: string;
  readonly text: string;
  readonly bytes: number;
  readonly lines: number;
  readonly tokens: number;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = text.endsWith("\n") ? 0 : 1;
  for (const character of text) {
    if (character === "\n") lines += 1;
  }
  return lines;
}

export function isObservationId(id: string): boolean {
  return OBSERVATION_ID_PATTERN.test(id);
}

export function observationPath(dir: string, id: string): string {
  return join(dir, `${id}.txt`);
}

export function containsReducerReceipt(text: string): boolean {
  return text.split("\n").some((line) => line === EVIDENCE_REDUCER_RECEIPT_PREFIX);
}

/**
 * Content-addressed observation id, stable across processes: derived from
 * tool name + call id + payload hash.
 */
export function observationId(toolName: string, callID: string, contentHash: string): string {
  return `obs_${sha256(`${toolName}\0${callID}\0${contentHash}`).slice(0, 24)}`;
}

/**
 * Build an Observation for a tool result text, or undefined when it does not
 * participate (below threshold, reducer receipt, empty).
 */
export function createObservation(params: {
  toolName: string;
  callID: string;
  text: string;
  dir: string;
  thresholdBytes?: number;
}): Observation | undefined {
  const { toolName, callID, text, dir } = params;
  const threshold = params.thresholdBytes ?? THRESHOLD_BYTES;
  if (containsReducerReceipt(text)) return undefined;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= threshold) return undefined;
  if (!dir) throw new Error("observation archive directory is unavailable");

  const contentHash = sha256(text);
  const id = observationId(toolName, callID, contentHash);
  return {
    id,
    contentHash,
    filePath: observationPath(dir, id),
    toolName,
    text,
    bytes,
    lines: countLines(text),
    tokens: estimateTokens(text),
  };
}

/**
 * Write the payload to its content-addressed path, refusing symlinks and
 * verifying an existing object byte for byte before reusing it.
 */
export async function ensureStored(observation: Observation): Promise<void> {
  const directoryPath = dirname(observation.filePath);
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const directoryStats = await lstat(directoryPath);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new Error(`observation directory is not a regular directory for ${observation.id}`);
  }

  let handle: FileHandle | undefined;
  try {
    handle = await open(observation.filePath, CREATE_OBJECT_FLAGS, 0o600);
    await handle.writeFile(observation.text, { encoding: "utf8" });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    const existingHandle = await open(observation.filePath, READ_OBJECT_FLAGS);
    try {
      const existing = await existingHandle.stat();
      if (!existing.isFile()) {
        throw new Error(`content-addressed observation is not a regular file for ${observation.id}`);
      }
      if (existing.size !== observation.bytes) {
        throw new Error(`content-addressed observation size mismatch for ${observation.id}`);
      }
      const existingContent = await existingHandle.readFile();
      if (sha256(existingContent) !== observation.contentHash) {
        throw new Error(`content-addressed observation hash mismatch for ${observation.id}`);
      }
    } finally {
      await existingHandle.close();
    }
  } finally {
    await handle?.close();
  }
}
