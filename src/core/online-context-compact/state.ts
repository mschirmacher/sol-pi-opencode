/**
 * Per-session OCC state with an injectable JSON store. Mirrors the
 * ObservationPack archive approach: XDG cache dir keyed by sessionID.
 * State transitions are pure functions; persistence is pluggable so the
 * logic stays testable without the filesystem.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parsePlanSteps, type PlanStep } from "./plan.js";

export const ONLINE_STATE_VERSION = 1;

export interface OnlineCompactState {
  readonly version: 1;
  readonly plan: readonly PlanStep[];
  readonly requestCount: number;
  /** requestCount when the last compaction ran; null before the first compaction. */
  readonly lastCompactionRequestCount: number | null;
  readonly lastBoundaryRequestCount: number;
  readonly completedBoundaryRequestCounts: readonly number[];
  readonly lastContextTokens: number | null;
  readonly positiveContextDeltaTotal: number;
  readonly positiveContextDeltaCount: number;
  readonly compactionCount: number;
}

export function initialState(): OnlineCompactState {
  return {
    version: ONLINE_STATE_VERSION,
    plan: [],
    requestCount: 0,
    lastCompactionRequestCount: null,
    lastBoundaryRequestCount: 0,
    completedBoundaryRequestCounts: [],
    lastContextTokens: null,
    positiveContextDeltaTotal: 0,
    positiveContextDeltaCount: 0,
    compactionCount: 0,
  };
}

export function parseState(value: unknown): OnlineCompactState | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const r = value as Record<string, unknown>;
  const plan = parsePlanSteps(r.plan);
  const counts = Array.isArray(r.completedBoundaryRequestCounts) ? r.completedBoundaryRequestCounts : undefined;
  const nonNeg = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (
    r.version !== ONLINE_STATE_VERSION ||
    !plan ||
    !counts ||
    !counts.every(nonNeg) ||
    !nonNeg(r.requestCount) ||
    !(r.lastCompactionRequestCount === null || nonNeg(r.lastCompactionRequestCount)) ||
    !nonNeg(r.lastBoundaryRequestCount) ||
    r.lastBoundaryRequestCount > r.requestCount ||
    !(r.lastContextTokens === null || nonNeg(r.lastContextTokens)) ||
    !finite(r.positiveContextDeltaTotal) ||
    !nonNeg(r.positiveContextDeltaCount) ||
    !nonNeg(r.compactionCount)
  ) {
    return;
  }
  return {
    version: ONLINE_STATE_VERSION,
    plan,
    requestCount: r.requestCount,
    lastCompactionRequestCount: r.lastCompactionRequestCount ?? null,
    lastBoundaryRequestCount: r.lastBoundaryRequestCount,
    completedBoundaryRequestCounts: counts as readonly number[],
    lastContextTokens: r.lastContextTokens,
    positiveContextDeltaTotal: r.positiveContextDeltaTotal,
    positiveContextDeltaCount: r.positiveContextDeltaCount,
    compactionCount: r.compactionCount,
  };
}

/** One provider request observed (contextTokens = estimated prompt size). */
export function recordRequest(state: OnlineCompactState, contextTokens: number): OnlineCompactState {
  const delta = state.lastContextTokens === null ? 0 : contextTokens - state.lastContextTokens;
  return {
    ...state,
    requestCount: state.requestCount + 1,
    lastContextTokens: contextTokens,
    positiveContextDeltaTotal: state.positiveContextDeltaTotal + Math.max(0, delta),
    positiveContextDeltaCount: state.positiveContextDeltaCount + (delta > 0 ? 1 : 0),
  };
}

/** A completed-step boundary was detected; records the requests-per-boundary sample. */
export function recordBoundary(state: OnlineCompactState, plan: readonly PlanStep[]): OnlineCompactState {
  const interval = Math.max(0, state.requestCount - state.lastBoundaryRequestCount);
  return {
    ...state,
    plan: [...plan],
    lastBoundaryRequestCount: state.requestCount,
    completedBoundaryRequestCounts: [...state.completedBoundaryRequestCounts, interval],
  };
}

/** A compaction ran (ours or opencode's native one). */
export function recordCompaction(state: OnlineCompactState): OnlineCompactState {
  return {
    ...state,
    // Preserve the plan: compaction changes the context representation,
    // not which steps have completed.
    plan: [...state.plan],
    lastCompactionRequestCount: state.requestCount,
    // Do not compare context sizes across the replacement summary.
    lastContextTokens: null,
    compactionCount: state.compactionCount + 1,
  };
}

export function averageContextTokenIncrement(state: OnlineCompactState): number | null {
  return state.positiveContextDeltaCount > 0
    ? state.positiveContextDeltaTotal / state.positiveContextDeltaCount
    : null;
}

export function requestsSinceLastCompaction(state: OnlineCompactState): number | null {
  return state.lastCompactionRequestCount === null ? null : state.requestCount - state.lastCompactionRequestCount;
}

export interface StateStore {
  load(sessionID: string): Promise<OnlineCompactState | undefined>;
  save(sessionID: string, state: OnlineCompactState): Promise<void>;
}

/** JSON file per session under `dir` (atomic write via rename). */
export function createFileStore(dir: string): StateStore {
  const pathFor = (sessionID: string): string => join(dir, `${sessionID.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
  return {
    async load(sessionID) {
      try {
        return parseState(JSON.parse(await readFile(pathFor(sessionID), "utf8")) as unknown);
      } catch {
        return undefined;
      }
    },
    async save(sessionID, state) {
      const path = pathFor(sessionID);
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(state), "utf8");
      await rename(tmp, path);
    },
  };
}

/** In-memory store (tests, fallback). */
export function createMemoryStore(): StateStore {
  const map = new Map<string, string>();
  return {
    async load(sessionID) {
      const raw = map.get(sessionID);
      return raw === undefined ? undefined : parseState(JSON.parse(raw) as unknown);
    },
    async save(sessionID, state) {
      map.set(sessionID, JSON.stringify(state));
    },
  };
}
