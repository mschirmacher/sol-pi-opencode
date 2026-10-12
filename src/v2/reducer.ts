/**
 * Evidence-Preserving Reducer — opencode 2.x adapter (mapping.md §4 "2.x sketch").
 *
 * `ctx.generate.text({prompt, model})` replaces the v1 throwaway-session hack:
 * it is the first-class one-shot primitive. TYPE DEVIATION vs v1 config:
 * the 2.x model ref is `{id, providerID, variant?}` (not `{providerID, modelID}`),
 * so config.modelID maps to `model.id`.
 *
 * Flow (same core logic as v1): `ctx.tool.hook("execute.after")` candidate →
 * archive → generate → validateReceipt → replace the mutable `event.result`
 * ONLY if the receipt verifies (marker `sol_pi_evidence_receipt_v1`).
 * Fail-open everywhere: any error leaves the original result untouched.
 * No hidden reducer agent is registered — 2.x generate.text needs none.
 */
import type { Plugin } from "@opencode/plugin";
import type { ReducerConfig } from "../core/config.js";
import type { ReducerRuntimeConfig } from "../core/evidence-preserving-reducer/config.js";
import { sha256 } from "../core/evidence-preserving-reducer/config.js";
import { archiveBody, archiveRoot, type ArchiveObject } from "../core/evidence-preserving-reducer/archive.js";
import {
  ineligibilityReason,
  reducibleToolResult,
  type AfterToolInput,
  type AfterToolOutput,
} from "../core/evidence-preserving-reducer/candidate.js";
import { createJournal, type Journal } from "../core/evidence-preserving-reducer/journal.js";
import { reducerInput } from "../core/evidence-preserving-reducer/prompt.js";
import { receiptText, validateReceipt } from "../core/evidence-preserving-reducer/receipt.js";
import { containsReducerReceipt } from "../core/observation-pack/archive.js";
import { isReplacedPlaceholder } from "../core/observation-pack/placeholder.js";
import { archiveDirFor, resultText, withResultText } from "./shared.js";

export type ReducerContext = Pick<Plugin.Context, "tool" | "generate">;

export interface ReducerCallParams {
  command: string;
  isError: boolean;
  archive: ArchiveObject;
  body: string;
  config: ReducerRuntimeConfig;
}

export interface ReducerCallResult {
  ok: boolean;
  outputText: string;
  provider: string;
  model: string;
  totalTokens: number;
  errorMessage?: string;
}

export type ReducerModelCall = (params: ReducerCallParams) => Promise<ReducerCallResult>;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`reducer model call timed out after ${ms}ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Default one-shot model call via ctx.generate.text (2.x native primitive). */
export function createGenerateTextReducer(ctx: ReducerContext): ReducerModelCall {
  return async ({ command, isError, archive, body, config }) => {
    if (!config.providerID || !config.modelID) {
      throw new Error("reducer providerID/modelID are not configured");
    }
    const response = await withTimeout(
      ctx.generate.text({
        prompt: reducerInput(command, isError, archive, body),
        model: { id: config.modelID, providerID: config.providerID },
      }),
      config.timeoutMs,
    );
    return {
      ok: true,
      outputText: response.text,
      provider: config.providerID,
      model: config.modelID,
      totalTokens: 0,
    };
  };
}

export async function registerEvidencePreservingReducer(
  ctx: ReducerContext,
  config: ReducerConfig,
  callReducer?: ReducerModelCall,
): Promise<Plugin.Cleanup> {
  if (!config.enabled) return () => {};

  const runtime: ReducerRuntimeConfig = { ...config };
  const call = callReducer ?? createGenerateTextReducer(ctx);
  const journals = new Map<string, Journal>();
  const reducedCallIDs = new Set<string>();

  const journalFor = (sessionID: string): Journal => {
    let journal = journals.get(sessionID);
    if (!journal) {
      journal = createJournal(archiveDirFor(sessionID), sessionID);
      journals.set(sessionID, journal);
    }
    return journal;
  };

  const registration = await ctx.tool.hook("execute.after", async (event) => {
    const journal = journalFor(event.sessionID);
    try {
      if (reducedCallIDs.has(event.id)) return;
      if (event.status !== "completed" || !event.result) return;
      const text = resultText(event.result);
      if (typeof text !== "string") return;
      if (containsReducerReceipt(text) || isReplacedPlaceholder(text)) return;

      const reducible = await reducibleToolResult(
        { tool: event.tool, args: event.input } satisfies AfterToolInput,
        { output: text, metadata: event.result.metadata } satisfies AfterToolOutput,
      );
      const ineligible = ineligibilityReason(reducible, {
        minLogBytes: config.minLogBytes,
        maxChars: config.maxChars,
      });
      if (ineligible) {
        if (reducible && ineligible !== "not-a-candidate") {
          journal.log("ineligible", { callID: event.id, reason: ineligible });
        }
        return;
      }
      const candidate = reducible!;

      const archive = await archiveBody(archiveRoot(archiveDirFor(event.sessionID)), candidate.body);
      journal.log("candidate", {
        callID: event.id,
        commandSha256: sha256(candidate.command),
        isError: candidate.isError,
        sourceSha256: archive.hash,
        sourceBytes: archive.bytes,
        sourceLines: archive.lines,
        sourcePath: archive.path,
      });

      let provider: ReducerCallResult;
      try {
        provider = await call({ command: candidate.command, isError: candidate.isError, archive, body: candidate.body, config: runtime });
      } catch (error) {
        journal.log("fallback", {
          callID: event.id,
          sourceSha256: archive.hash,
          reason: "model-call-exception",
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      journal.log("provider_response", {
        callID: event.id,
        sourceSha256: archive.hash,
        provider: provider.provider,
        model: provider.model,
        ok: provider.ok,
        errorMessage: provider.errorMessage,
        totalTokens: provider.totalTokens,
      });
      if (!provider.ok) {
        journal.log("fallback", {
          callID: event.id,
          sourceSha256: archive.hash,
          reason: "model-response-error",
          errorMessage: provider.errorMessage,
        });
        return;
      }

      const checked = validateReceipt(provider.outputText, archive, candidate.body, candidate.isError, {
        maxEvidenceItems: config.maxEvidenceItems,
        maxQuoteChars: config.maxQuoteChars,
      });
      if (!checked.ok) {
        journal.log("fallback", { callID: event.id, sourceSha256: archive.hash, reason: checked.reason });
        return;
      }
      const receipt = receiptText(candidate.command, archive, checked.value, provider);
      const receiptBytes = Buffer.byteLength(receipt, "utf8");
      if (receiptBytes >= archive.bytes) {
        journal.log("fallback", {
          callID: event.id,
          sourceSha256: archive.hash,
          reason: "receipt-not-smaller",
          receiptBytes,
          sourceBytes: archive.bytes,
        });
        return;
      }
      journal.log("applied", {
        callID: event.id,
        commandSha256: sha256(candidate.command),
        sourceSha256: archive.hash,
        sourceBytes: archive.bytes,
        receiptSha256: sha256(receipt),
        receiptBytes,
        evidenceCount: checked.value.evidence.length,
        uncertain: checked.value.uncertain,
      });
      reducedCallIDs.add(event.id);
      // Replace only the mutable event result — never stored history.
      event.result = withResultText(event.result, candidate.projectReceipt(receipt));
    } catch (error) {
      journal.log("fallback", {
        callID: event.id,
        reason: "hook-exception",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return () => registration.dispose();
}
