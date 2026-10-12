/**
 * Evidence-Preserving Reducer — v1 hooks (opencode 1.x).
 *
 * SPIKE FINDINGS (opencode v1.19.0 source, this phase):
 * 1. One-shot model call via throwaway session IS possible with the SDK client
 *    in PluginInput: client.session.create({}) → client.session.prompt({path:
 *    {id}, body:{agent, model:{providerID,modelID}, parts:[{type:"text",…}]}})
 *    → read assistant text from the returned WithParts → client.session.delete.
 *    - PromptInput carries `model` and `agent` (session/prompt.ts:1499-1521);
 *      SDK body shape matches (types.gen.d.ts SessionPromptData).
 *    - session.prompt blocks until the loop finishes and returns the last
 *      assistant message with parts (session/prompt.ts:1052-1070) — no need
 *      for a separate session.messages read.
 * 2. The 1.x `config` hook CAN register a hidden no-tools agent: the hook
 *    receives the live cached config object (plugin/index.ts:247 passes the
 *    config.get() result; config.get returns the same instance-state object,
 *    config/config.ts:620), and the Agent service builds agents from
 *    cfg.agent lazily on first use (agent/agent.ts:267) — after plugin load.
 *    Agent Info supports mode/hidden/steps/permission/prompt
 *    (agent/agent.ts:35-56), so we register "sol-pi-reducer" with
 *    mode:"subagent", hidden:true, steps:1, permission {"*":"deny"}.
 * 3. Gaps (documented, fail-open): no server-side timeout on session.prompt —
 *    bounded client-side; if the agent or model is unavailable the prompt
 *    throws and we leave the output untouched; the throwaway session shares
 *    the instance (auth reused) but is a separate session, so it cannot
 *    deadlock the parent session's loop.
 */
import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import type { ReducerRuntimeConfig } from "../core/evidence-preserving-reducer/config.js";
import { isRecord, recordValue, sha256 } from "../core/evidence-preserving-reducer/config.js";
import { archiveBody, archiveRoot, type ArchiveObject } from "../core/evidence-preserving-reducer/archive.js";
import {
  ineligibilityReason,
  reducibleToolResult,
  type AfterToolInput,
  type AfterToolOutput,
} from "../core/evidence-preserving-reducer/candidate.js";
import { createJournal, type Journal } from "../core/evidence-preserving-reducer/journal.js";
import { reducerInput, reducerInstructions } from "../core/evidence-preserving-reducer/prompt.js";
import { receiptText, validateReceipt } from "../core/evidence-preserving-reducer/receipt.js";
import { containsReducerReceipt } from "../core/observation-pack/archive.js";
import { isReplacedPlaceholder } from "../core/observation-pack/placeholder.js";
import { archiveDirFor } from "./observation-pack.js";

export const REDUCER_AGENT_NAME = "sol-pi-reducer";

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

/** Injectable one-shot model call; the default impl is the throwaway session. */
export type ReducerModelCall = (params: ReducerCallParams) => Promise<ReducerCallResult>;

/** Register the hidden no-tools reducer agent on the live config object. */
export function registerReducerAgent(config: { agent?: Record<string, unknown> }): void {
  config.agent = config.agent ?? {};
  config.agent[REDUCER_AGENT_NAME] = {
    mode: "subagent",
    hidden: true,
    steps: 1,
    permission: { "*": "deny" },
    prompt: reducerInstructions(),
  };
}

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

function assistantText(data: unknown): string {
  const parts = recordValue(data, "parts");
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((part): part is { type: string; text: string } => isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function usageTokens(data: unknown): number {
  const info = recordValue(data, "info");
  const tokens = recordValue(info, "tokens");
  if (!isRecord(tokens)) return 0;
  const cache = isRecord(tokens.cache) ? tokens.cache : {};
  const sum = [tokens.input, tokens.output, tokens.reasoning, cache.read, cache.write]
    .filter((v): v is number => typeof v === "number")
    .reduce((a, b) => a + b, 0);
  return sum;
}

/** Default ReducerModelCall: throwaway session via the SDK client (spike 1+2). */
export function createThrowawaySessionReducer(input: PluginInput): ReducerModelCall {
  return async ({ command, isError, archive, body, config }) => {
    if (!config.providerID || !config.modelID) {
      throw new Error("reducer providerID/modelID are not configured");
    }
    const created = await withTimeout(input.client.session.create({}), config.timeoutMs);
    const sessionID = created.data?.id;
    if (!sessionID) throw new Error("session.create returned no session id");
    try {
      const response = await withTimeout(
        input.client.session.prompt({
          path: { id: sessionID },
          body: {
            agent: REDUCER_AGENT_NAME,
            model: { providerID: config.providerID, modelID: config.modelID },
            parts: [{ type: "text", text: reducerInput(command, isError, archive, body) }],
          },
        }),
        config.timeoutMs,
      );
      const data = response.data;
      const info = recordValue(data, "info");
      const error = recordValue(info, "error");
      return {
        ok: error === undefined,
        outputText: assistantText(data),
        provider: typeof recordValue(info, "providerID") === "string" ? String(recordValue(info, "providerID")) : config.providerID,
        model: typeof recordValue(info, "modelID") === "string" ? String(recordValue(info, "modelID")) : config.modelID,
        totalTokens: usageTokens(data),
        errorMessage: error === undefined ? undefined : JSON.stringify(error),
      };
    } finally {
      // Throwaway: always clean up, never let cleanup failure mask the result.
      await input.client.session.delete({ path: { id: sessionID } }).catch(() => undefined);
    }
  };
}

export function createEvidencePreservingReducerHooks(
  input: PluginInput,
  config: ReducerRuntimeConfig,
  callReducer?: ReducerModelCall,
): Hooks {
  const call = callReducer ?? createThrowawaySessionReducer(input);
  const journals = new Map<string, Journal>();
  const reducedCallIDs = new Set<string>();

  const journalFor = (sessionID: string): Journal => {
    let journal = journals.get(sessionID);
    if (!journal) {
      journal = createJournal(archiveDirFor(input, sessionID), sessionID);
      journals.set(sessionID, journal);
    }
    return journal;
  };

  return {
    // Spike finding 2: register the hidden no-tools agent on the live config.
    config: async (cfg) => {
      registerReducerAgent(cfg as unknown as { agent?: Record<string, unknown> });
    },

    "tool.execute.after": async (hookInput, output) => {
      const journal = journalFor(hookInput.sessionID);
      try {
        if (reducedCallIDs.has(hookInput.callID)) return;
        // Never touch outputs that already carry our markers.
        if (containsReducerReceipt(output.output) || isReplacedPlaceholder(output.output)) return;

        const reducible = await reducibleToolResult(
          { tool: hookInput.tool, args: hookInput.args } satisfies AfterToolInput,
          { output: output.output, metadata: output.metadata } satisfies AfterToolOutput,
        );
        const ineligible = ineligibilityReason(reducible, {
          minLogBytes: config.minLogBytes,
          maxChars: config.maxChars,
        });
        if (ineligible) {
          if (reducible && ineligible !== "not-a-candidate") {
            journal.log("ineligible", { callID: hookInput.callID, reason: ineligible });
          }
          return;
        }
        // Narrowed by the ineligible check above.
        const candidate = reducible!;

        const archive = await archiveBody(archiveRoot(archiveDirFor(input, hookInput.sessionID)), candidate.body);
        journal.log("candidate", {
          callID: hookInput.callID,
          commandSha256: sha256(candidate.command),
          isError: candidate.isError,
          sourceSha256: archive.hash,
          sourceBytes: archive.bytes,
          sourceLines: archive.lines,
          sourcePath: archive.path,
        });

        let provider: ReducerCallResult;
        try {
          provider = await call({ command: candidate.command, isError: candidate.isError, archive, body: candidate.body, config });
        } catch (error) {
          journal.log("fallback", {
            callID: hookInput.callID,
            sourceSha256: archive.hash,
            reason: "model-call-exception",
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        journal.log("provider_response", {
          callID: hookInput.callID,
          sourceSha256: archive.hash,
          provider: provider.provider,
          model: provider.model,
          ok: provider.ok,
          errorMessage: provider.errorMessage,
          totalTokens: provider.totalTokens,
        });
        if (!provider.ok) {
          journal.log("fallback", {
            callID: hookInput.callID,
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
          journal.log("fallback", { callID: hookInput.callID, sourceSha256: archive.hash, reason: checked.reason });
          return;
        }
        const receipt = receiptText(candidate.command, archive, checked.value, provider);
        const receiptBytes = Buffer.byteLength(receipt, "utf8");
        if (receiptBytes >= archive.bytes) {
          journal.log("fallback", {
            callID: hookInput.callID,
            sourceSha256: archive.hash,
            reason: "receipt-not-smaller",
            receiptBytes,
            sourceBytes: archive.bytes,
          });
          return;
        }
        journal.log("applied", {
          callID: hookInput.callID,
          commandSha256: sha256(candidate.command),
          sourceSha256: archive.hash,
          sourceBytes: archive.bytes,
          receiptSha256: sha256(receipt),
          receiptBytes,
          evidenceCount: checked.value.evidence.length,
          uncertain: checked.value.uncertain,
        });
        reducedCallIDs.add(hookInput.callID);
        // Replace in place: the after-hook's rewritten output reaches both the
        // provider request and storage (research Q3/Q5). The receipt's first
        // line is the marker ObservationPack skips (never re-packed).
        output.output = candidate.projectReceipt(receipt);
      } catch (error) {
        // Fail-open: any unexpected error leaves the original output untouched.
        journal.log("fallback", {
          callID: hookInput.callID,
          reason: "hook-exception",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
