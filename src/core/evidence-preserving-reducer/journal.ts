/**
 * Append-only audit journal for reducer decisions. Session-scoped file
 * (injectable dir), one JSON object per line. Entries never enter the LLM
 * context; they record which results were candidates, which were delegated,
 * and why each fallback happened.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { REDUCER_RECEIPT_SCHEMA, sha256 } from "./config.js";

export interface Journal {
  log: (kind: string, data?: Record<string, unknown>) => void;
  /** Await all queued writes (used by tests; production code fire-and-forgets). */
  flush: () => Promise<void>;
}

export function journalPath(dir: string, sessionID: string): string {
  return join(dir, `reducer-journal-${sha256(sessionID).slice(0, 16)}.jsonl`);
}

export function createJournal(dir: string, sessionID: string): Journal {
  const path = journalPath(dir, sessionID);
  let queue: Promise<void> = Promise.resolve();
  return {
    log: (kind, data = {}) => {
      const line = `${JSON.stringify({ schema: REDUCER_RECEIPT_SCHEMA, kind, at: new Date().toISOString(), ...data })}\n`;
      // Serialize appends; journal failures must never break the mechanism.
      queue = queue
        .then(async () => {
          await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          await appendFile(path, line, "utf8");
        })
        .catch(() => undefined);
    },
    flush: () => queue,
  };
}
