/**
 * Per-file mutex keyed by absolute path (promise chain), ported from SoL-Pi's
 * file-queue.ts. Serializes fused operations for one file so another fused
 * mutation of the same file cannot interleave with the guard check + command.
 * opencode's built-in edit/write keep their own internal locks; the two
 * queues are intentionally not nested.
 */

const queueTails = new Map<string, Promise<void>>();

export async function withFileQueue<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = queueTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const owned = new Promise<void>((resolveOwned) => {
    release = resolveOwned;
  });
  const tail = previous.then(() => owned);
  queueTails.set(key, tail);

  await previous;
  try {
    return await work();
  } finally {
    release();
    if (queueTails.get(key) === tail) queueTails.delete(key);
  }
}
