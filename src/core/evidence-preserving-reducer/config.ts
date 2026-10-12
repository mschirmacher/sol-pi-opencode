/**
 * Constants and helpers for the Evidence-Preserving Reducer, ported from
 * SoL-Pi extensions/evidence-preserving-reducer/config.ts. Thresholds are
 * SoL-Pi defaults.
 */
import { createHash } from "node:crypto";

/**
 * Receipt marker line. MUST stay identical to the ObservationPack constant
 * EVIDENCE_REDUCER_RECEIPT_PREFIX: ObservationPack's createObservation skips
 * any text containing a line equal to this value, so reducer receipts are
 * never re-packed (the exclusion already exists in
 * src/core/observation-pack/archive.ts containsReducerReceipt()).
 */
export const REDUCER_RECEIPT_PREFIX = "sol_pi_evidence_receipt_v1";
export const REDUCER_RECEIPT_SCHEMA = "sol-pi-evidence-receipt/1";

export const MAX_EVIDENCE_ITEMS = 12;
export const MAX_QUOTE_CHARS = 600;

export const DEFAULT_MIN_LOG_BYTES = 4_096;
export const DEFAULT_MAX_CHARS = 600_000;
export const DEFAULT_TIMEOUT_MS = 90_000;

/** SoL-Pi DIAGNOSTIC_COMMAND: only build/test-like commands are candidates. */
export const DIAGNOSTIC_COMMAND =
  /(?:^|[;&|()\s])(?:lake\s+build|lake\s+env\s+lean|lean|coq|cargo(?:\s+(?:build|test|check))?|zig\s+build|pytest|python(?:3)?\s+-m\s+(?:pytest|unittest|py_compile)|ctest|cmake\s+--build|ninja|make|npm\s+test|pnpm\s+test|yarn\s+test|go\s+test|bazel\s+test)(?:\s|$)/i;

export const FAILURE_SIGNAL = /error|failed|failure|fatal|exception|panic|timeout|unsolved|type mismatch|assert/i;
export const LIKELY_SECRET = /(?:api[_-]?key|authorization|bearer|access[_-]?token|secret)[^\n]{0,32}[=:][^\n]+/i;

export interface ReducerRuntimeConfig {
  maxEvidenceItems: number;
  maxQuoteChars: number;
  minLogBytes: number;
  maxChars: number;
  timeoutMs: number;
  providerID?: string;
  modelID?: string;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function recordValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}
