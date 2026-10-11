/** Only tool results larger than this participate. */
export const THRESHOLD_BYTES = 10 * 1024;
/** Provider requests that still carry the full payload before the placeholder takes over. */
export const FULL_SENDS = 2;
/** Placeholder excerpt budget, split evenly between head and tail, whole lines only. */
export const PLACEHOLDER_EXCERPT_BYTES = 1024;

export const CHARS_PER_TOKEN = 4;

export const RECALL_MAX_BYTES = 16 * 1024;
export const RECALL_MAX_LINES = 400;
export const RECALL_HEADER_RESERVE_BYTES = 512;
export const RECALL_HEADER_LINES = 2;

export const RECALL_LIMITS = {
  maxBytes: RECALL_MAX_BYTES - RECALL_HEADER_RESERVE_BYTES,
  maxLines: RECALL_MAX_LINES - RECALL_HEADER_LINES,
};

/**
 * Receipts from the evidence-preserving reducer are already a reduction of a
 * long log. Packing them again would replace verified evidence with an excerpt.
 */
export const EVIDENCE_REDUCER_RECEIPT_PREFIX = "sol_pi_evidence_receipt_v1";

export const OBSERVATION_ID_PATTERN = /^obs_[a-f0-9]{24}$/u;

/** Name of the recall tool registered by this plugin. */
export const RECALL_TOOL_NAME = "sol_pi_recall";
