/**
 * Break-even economics gate ported from SoL-Pi online-context-compact/
 * economics.ts (the core gate at economics.ts:16-23 + decideCompaction).
 * Simplified to the config surface of this plugin; pure + deterministic.
 *
 * Model: compaction replaces `archiveTokens` of history with a `memoTokens`
 * summary. The saving is repaid over future provider requests, but the
 * rewrite invalidates the prompt cache from the replacement offset onward —
 * charged as a one-time discontinuity of postCompactionTokens *
 * (cacheWriteReadRatio - 1) token-equivalents (mapping.md question (d)).
 */

export interface EconomicsConfig {
  /** Tokens kept free of compaction pressure near the window edge. */
  windowReserveTokens: number;
  /** Minimum provider requests since the last compaction before compacting again. */
  minRequestsBetween: number;
  /** Extra break-even margin applied on the 2nd+ compaction. */
  subsequentCompactionMargin: number;
  /** Lower bound = mean - stddevK * stddev of requests-per-boundary history. */
  stddevK: number;
  /** Horizon scale for the first compaction (SoL-Pi firstCompactionRequestScale). */
  firstCompactionRequestScale: number;
}

export const DEFAULT_ECONOMICS_CONFIG: EconomicsConfig = Object.freeze({
  windowReserveTokens: 16_384,
  minRequestsBetween: 2,
  subsequentCompactionMargin: 1.5,
  stddevK: 1,
  firstCompactionRequestScale: 2,
});

export type CompactionReason =
  | "economic"
  | "window_protection"
  | "deferred_economic"
  | "deferred_subsequent_margin"
  | "deferred_post_compaction_cooldown"
  | "horizon_unavailable"
  | "non_positive_saving";

export interface EconomicsInput {
  /** Requests observed between each pair of completed-step boundaries. */
  boundaryRequestCounts: readonly number[];
  /** Plan steps still open (>= 1 while a task runs). */
  remainingBoundaries: number;
  contextTokens: number;
  contextWindowTokens: number | null;
  /** Mean positive per-request context growth; null when unobserved. */
  averageContextTokenIncrement: number | null;
  /** Tokens of history the compaction replaces. */
  archiveTokens: number;
  /** Tokens of the replacement summary. */
  memoTokens: number;
  priorCompactionCount: number;
  /** Provider requests since the last compaction; null when never compacted. */
  requestsSinceLastCompaction: number | null;
  cacheWriteReadRatio: number;
  config?: Partial<EconomicsConfig>;
}

export interface EconomicsDecision {
  readonly compact: boolean;
  readonly reason: CompactionReason;
  /** Tokens saved per future request (archiveTokens - memoTokens). */
  readonly expectedSavings: number;
  /** One-time cache-discontinuity charge in token-equivalents. */
  readonly rewriteCost: number;
  readonly breakevenRequests: number | null;
  readonly expectedRemainingRequests: number | null;
  readonly requestsPerBoundaryLowerBound: number | null;
  readonly windowProtection: boolean;
}

const MINIMUM_VARIANCE_SAMPLES = 3;
const SMALL_SAMPLE_SCALE = 0.5;

export function requestsPerBoundaryLowerBound(
  counts: readonly number[],
  stddevK: number,
): { mean: number; lowerBound: number } {
  const mean = counts.reduce((total, count) => total + count, 0) / Math.max(1, counts.length);
  let lowerBound = mean;
  if (stddevK !== 0) {
    if (counts.length < MINIMUM_VARIANCE_SAMPLES) {
      lowerBound *= SMALL_SAMPLE_SCALE;
    } else {
      const variance = counts.reduce((total, count) => total + (count - mean) ** 2, 0);
      const deviation = Math.sqrt(variance / (counts.length - 1));
      lowerBound = Math.max(0, mean - stddevK * deviation);
    }
  }
  return { mean, lowerBound };
}

export function decideCompaction(input: EconomicsInput): EconomicsDecision {
  const config = { ...DEFAULT_ECONOMICS_CONFIG, ...(input.config ?? {}) };
  const { lowerBound } = requestsPerBoundaryLowerBound(input.boundaryRequestCounts, config.stddevK);

  const unboundedExpectedRemaining = 1 + Math.floor(lowerBound * Math.max(0, input.remainingBoundaries));
  const windowRequestUpperBound =
    input.contextWindowTokens === null ||
    input.averageContextTokenIncrement === null ||
    input.averageContextTokenIncrement <= 0
      ? null
      : Math.max(0, Math.floor((input.contextWindowTokens - input.contextTokens) / input.averageContextTokenIncrement));
  const expectedRemainingRequests =
    windowRequestUpperBound === null
      ? unboundedExpectedRemaining
      : Math.min(unboundedExpectedRemaining, windowRequestUpperBound);

  const expectedSavings = input.archiveTokens - input.memoTokens;
  const postCompactionTokens = Math.max(0, input.contextTokens - expectedSavings);
  const incrementalCacheCostRatio = Math.max(0, input.cacheWriteReadRatio - 1);
  const rewriteCost = postCompactionTokens * incrementalCacheCostRatio;
  const breakevenRequests = expectedSavings > 0 ? rewriteCost / expectedSavings : null;

  const firstCompaction = input.priorCompactionCount === 0;
  const effectiveHorizonRequests = firstCompaction
    ? Math.min(expectedRemainingRequests * config.firstCompactionRequestScale, windowRequestUpperBound ?? Number.POSITIVE_INFINITY)
    : expectedRemainingRequests;

  const windowProtection =
    input.contextWindowTokens !== null &&
    input.contextTokens >= input.contextWindowTokens - config.windowReserveTokens;

  const baseEconomic = breakevenRequests !== null && breakevenRequests <= expectedRemainingRequests;
  const firstEconomic = breakevenRequests !== null && breakevenRequests <= effectiveHorizonRequests;
  const subsequentMarginOpen =
    breakevenRequests !== null && breakevenRequests * config.subsequentCompactionMargin <= expectedRemainingRequests;
  const economic = firstCompaction ? firstEconomic : baseEconomic && subsequentMarginOpen;

  const cooldownActive =
    input.requestsSinceLastCompaction !== null &&
    input.requestsSinceLastCompaction < config.minRequestsBetween;

  // Window protection stays absolute: near the context limit, compact even in cooldown.
  const compressible = expectedSavings > 0;
  const compact = compressible && (windowProtection || (economic && !cooldownActive));

  const reason: CompactionReason = !compressible
    ? "non_positive_saving"
    : windowProtection
      ? "window_protection"
      : economic && cooldownActive
        ? "deferred_post_compaction_cooldown"
        : economic
          ? "economic"
          : !firstCompaction && baseEconomic && !subsequentMarginOpen
            ? "deferred_subsequent_margin"
            : "deferred_economic";

  return {
    compact,
    reason,
    expectedSavings,
    rewriteCost,
    breakevenRequests,
    expectedRemainingRequests,
    requestsPerBoundaryLowerBound: lowerBound,
    windowProtection,
  };
}
