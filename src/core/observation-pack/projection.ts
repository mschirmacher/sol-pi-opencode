import { countLines, estimateTokens, observationId, sha256 } from "./archive.js";
import type { Ledger } from "./ledger.js";
import { isReplacedPlaceholder, placeholderFor } from "./placeholder.js";
import type { Observation } from "./archive.js";

export interface ProjectionConfig {
  thresholdBytes: number;
  fullSends: number;
  excerptBytes: number;
}

/** Minimal structural shape of an opencode message part (tool result). */
export interface ProjectionPartShape {
  type?: string;
  tool?: string;
  callID?: string;
  state?: { status?: string; output?: string };
}

export interface ProjectionMessageShape {
  parts?: readonly ProjectionPartShape[];
}

export interface ProjectionReplacement {
  messageIndex: number;
  partIndex: number;
  callID: string;
  id: string;
  placeholder: string;
  removedTokens: number;
}

export interface ProjectionPlan {
  /** callIDs that still go out in full this request. */
  sendIncrements: string[];
  /** parts to replace with a placeholder this request. */
  replacements: ProjectionReplacement[];
}

const EMPTY_PLAN: ProjectionPlan = { sendIncrements: [], replacements: [] };

/**
 * Pure projection decision: given the projected messages and the ledger,
 * decide which tool-result parts still go out in full and which get replaced
 * by a byte-stable placeholder. Fail-open: any error yields an empty plan,
 * leaving every observation untouched.
 */
export function planProjection<M extends ProjectionMessageShape>(
  messages: readonly M[],
  ledger: Ledger,
  config: ProjectionConfig,
): ProjectionPlan {
  try {
    const sendIncrements: string[] = [];
    const replacements: ProjectionReplacement[] = [];

    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
      const parts = messages[messageIndex]?.parts;
      if (!parts) continue;

      for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
        const part = parts[partIndex];
        if (!part || part.type !== "tool") continue;
        if (part.state?.status !== "completed") continue;
        const output = part.state.output;
        if (typeof output !== "string" || output.length === 0) continue;
        const callID = part.callID;
        if (!callID) continue;

        const entry = ledger.get(callID);
        if (!entry) continue;

        // Idempotent: never re-wrap an already-replaced part.
        if (isReplacedPlaceholder(output)) continue;

        // Fail-open guard: if the projected text no longer matches the
        // archived bytes (e.g. opencode truncated it), leave it alone.
        if (sha256(output) !== entry.sha256) continue;

        if (entry.sends < config.fullSends) {
          sendIncrements.push(callID);
          continue;
        }

        const toolName = part.tool ?? "unknown";
        const id = observationId(toolName, callID, entry.sha256);
        const observation: Observation = {
          id,
          contentHash: entry.sha256,
          filePath: "",
          toolName,
          text: output,
          bytes: entry.size,
          lines: countLines(output),
          tokens: estimateTokens(output),
        };
        const placeholder = placeholderFor(observation, config.excerptBytes);
        replacements.push({
          messageIndex,
          partIndex,
          callID,
          id,
          placeholder,
          removedTokens: Math.max(0, observation.tokens - estimateTokens(placeholder)),
        });
      }
    }

    return { sendIncrements, replacements };
  } catch {
    return { ...EMPTY_PLAN, sendIncrements: [], replacements: [] };
  }
}
