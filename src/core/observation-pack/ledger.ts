/**
 * In-memory ledger: callID -> what was archived and how many provider
 * requests the full payload has already been part of.
 */
export interface LedgerEntry {
  sha256: string;
  size: number;
  sends: number;
}

export class Ledger {
  private readonly entries = new Map<string, LedgerEntry>();

  record(callID: string, entry: LedgerEntry): void {
    this.entries.set(callID, { ...entry });
  }

  get(callID: string): LedgerEntry | undefined {
    const entry = this.entries.get(callID);
    return entry ? { ...entry } : undefined;
  }

  has(callID: string): boolean {
    return this.entries.has(callID);
  }

  /** Returns the new send count, or undefined when the callID is unknown. */
  incrementSends(callID: string): number | undefined {
    const entry = this.entries.get(callID);
    if (!entry) return undefined;
    entry.sends += 1;
    return entry.sends;
  }

  get size(): number {
    return this.entries.size;
  }
}
