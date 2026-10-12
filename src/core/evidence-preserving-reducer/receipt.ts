/**
 * Receipt schema + verifier, ported from SoL-Pi receipt.ts with identical
 * validation semantics (validateReceipt at SoL-Pi receipt.ts:82-120).
 *
 * SAFETY PROPERTY: a receipt is accepted only when every claim in it can be
 * checked against the archived log — right schema, right source hash, status
 * matching the observed exit, and quotes that appear byte for byte in the
 * archive. Any failure → invalid → the original log passes through untouched.
 * Never weaken this to make tests pass.
 */
import type { ArchiveObject } from "./archive.js";
import {
  FAILURE_SIGNAL,
  isRecord,
  LIKELY_SECRET,
  MAX_EVIDENCE_ITEMS,
  MAX_QUOTE_CHARS,
  REDUCER_RECEIPT_PREFIX,
  REDUCER_RECEIPT_SCHEMA,
  recordValue,
  sha256,
} from "./config.js";

export type EvidenceKind = "fatal" | "failure" | "warning" | "target" | "summary";

export interface VerifiedEvidence {
  readonly kind: EvidenceKind;
  readonly line: number | undefined;
  readonly quote: string;
  readonly quoteSha256: string;
}

export interface ValidatedReceipt {
  readonly status: "success" | "failure";
  readonly uncertain: boolean;
  readonly evidence: readonly VerifiedEvidence[];
}

export type ReceiptValidation =
  | { readonly ok: true; readonly value: ValidatedReceipt }
  | { readonly ok: false; readonly reason: string };

export interface ReceiptLimits {
  readonly maxEvidenceItems?: number;
  readonly maxQuoteChars?: number;
}

function lineNumberOf(body: string, quote: string): number | undefined {
  const index = body.indexOf(quote);
  if (index < 0) return undefined;
  let line = 1;
  for (let cursor = 0; cursor < index; cursor++) {
    if (body.charCodeAt(cursor) === 10) line++;
  }
  return line;
}

/**
 * Accept a receipt only when every claim in it can be checked against the
 * archived log: right schema, right source hash, status that matches the
 * observed exit, and quotes that appear byte for byte in the archive.
 */
export function validateReceipt(
  raw: string,
  archive: ArchiveObject,
  body: string,
  isError: boolean,
  limits: ReceiptLimits = {},
): ReceiptValidation {
  const maxEvidenceItems = limits.maxEvidenceItems ?? MAX_EVIDENCE_ITEMS;
  const maxQuoteChars = limits.maxQuoteChars ?? MAX_QUOTE_CHARS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, reason: "invalid-json" };
  }
  const evidenceValue = recordValue(parsed, "evidence");
  const expectedStatus = isError ? "failure" : "success";
  if (
    !isRecord(parsed) ||
    parsed.schema !== REDUCER_RECEIPT_SCHEMA ||
    parsed.source_sha256 !== archive.hash ||
    parsed.status !== expectedStatus ||
    typeof parsed.uncertain !== "boolean" ||
    !Array.isArray(evidenceValue) ||
    evidenceValue.length > maxEvidenceItems
  ) {
    return { ok: false, reason: "schema-mismatch" };
  }
  const allowedKinds = new Set<EvidenceKind>(["fatal", "failure", "warning", "target", "summary"]);
  const evidence: VerifiedEvidence[] = [];
  const seen = new Set<string>();
  for (const item of evidenceValue) {
    const kind = recordValue(item, "kind");
    const quote = recordValue(item, "quote");
    if (
      typeof kind !== "string" ||
      !allowedKinds.has(kind as EvidenceKind) ||
      typeof quote !== "string" ||
      quote.length < 1 ||
      quote.length > maxQuoteChars ||
      !body.includes(quote)
    ) {
      return { ok: false, reason: "unverifiable-quote" };
    }
    // Likely-secret gate: a receipt must not launder a secret into a smaller,
    // quotable form. SoL-Pi gates secrets before the model call; we also gate
    // the verified quotes themselves.
    if (LIKELY_SECRET.test(quote)) {
      return { ok: false, reason: "likely-secret-quote" };
    }
    const evidenceKind = kind as EvidenceKind;
    const key = `${evidenceKind}\0${quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    evidence.push({
      kind: evidenceKind,
      line: lineNumberOf(body, quote),
      quote,
      quoteSha256: sha256(quote),
    });
  }
  // A failing log that reads as a failure must carry failure evidence, or the
  // receipt would let a real failure through as a clean summary.
  if (
    isError &&
    FAILURE_SIGNAL.test(body) &&
    !evidence.some((item) => item.kind === "fatal" || item.kind === "failure")
  ) {
    return { ok: false, reason: "missing-failure-evidence" };
  }
  return { ok: true, value: { status: expectedStatus, uncertain: parsed.uncertain, evidence } };
}

/**
 * Render a validated receipt. The first line is the receipt marker
 * (REDUCER_RECEIPT_PREFIX) — ObservationPack's containsReducerReceipt() skips
 * any text carrying this exact line, so receipts are never re-packed.
 */
export function receiptText(
  command: string,
  archive: ArchiveObject,
  validated: ValidatedReceipt,
  provider: { provider: string; model: string; totalTokens: number },
): string {
  const lines = [
    REDUCER_RECEIPT_PREFIX,
    `status=${validated.status}`,
    `uncertain=${validated.uncertain}`,
    `command_sha256=${sha256(command)}`,
    `source_sha256=${archive.hash}`,
    `source_bytes=${archive.bytes}`,
    `source_lines=${archive.lines}`,
    `source_artifact=${archive.path}`,
    `reducer_provider=${provider.provider}`,
    `reducer_model=${provider.model}`,
    `reducer_total_tokens=${provider.totalTokens}`,
    "verified_evidence:",
  ];
  for (const item of validated.evidence) {
    lines.push(
      `- kind=${item.kind} line=${item.line} quote_sha256=${item.quoteSha256} quote=${JSON.stringify(item.quote)}`,
    );
  }
  if (validated.evidence.length === 0) lines.push("- none");
  lines.push(
    "authority=agent retains diagnosis, repair, rerun, and pass/fail adjudication",
    "readback=use bash with an explicit byte or line range on source_artifact when exact context is needed",
  );
  return lines.join("\n");
}
