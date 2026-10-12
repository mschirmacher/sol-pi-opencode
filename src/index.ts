import { Plugin as V2Plugin } from "@opencode/plugin";
import type { Hooks, Plugin as V1Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin";
import { loadConfig } from "./core/config.js";
import { createActionFusionHooks } from "./v1/action-fusion.js";
import { createObservationPackHooks } from "./v1/observation-pack.js";
import { createOnlineContextCompactHooks } from "./v1/online-context-compact.js";
import { createEvidencePreservingReducerHooks } from "./v1/evidence-preserving-reducer.js";
import { registerObservationPack } from "./v2/observation-pack.js";
import { registerActionFusion } from "./v2/action-fusion.js";
import { registerOnlineContextCompact } from "./v2/online-context-compact.js";
import { registerEvidencePreservingReducer } from "./v2/reducer.js";

/** Compose two hook objects; shared hooks run in order (a before b). */
function mergeHooks(a: Hooks, b: Hooks): Hooks {
  const out: Record<string, unknown> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    const prev = out[key];
    if (typeof prev === "function" && typeof value === "function") {
      const first = prev as (...args: unknown[]) => Promise<void>;
      const second = value as (...args: unknown[]) => Promise<void>;
      out[key] = async (...args: unknown[]) => {
        await first(...args);
        await second(...args);
      };
    } else if (
      prev && value &&
      typeof prev === "object" && !Array.isArray(prev) &&
      typeof value === "object" && !Array.isArray(value)
    ) {
      out[key] = { ...prev, ...value };
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as Hooks;
}

/** V1 object-entrypoint server (opencode-ai >= 1.18.29). */
export async function server(input: PluginInput, options?: PluginOptions): Promise<Hooks> {
  const config = await loadConfig(input.directory);
  let hooks = createActionFusionHooks(input, config.actionFusion);
  // Reducer runs after Action Fusion (so fused then_run outputs are visible)
  // and before ObservationPack (so its receipt marker excludes it from
  // re-packing; ObservationPack already skips receipt-marked text).
  if (config.evidencePreservingReducer.enabled) {
    hooks = mergeHooks(hooks, createEvidencePreservingReducerHooks(input, {
      maxEvidenceItems: config.evidencePreservingReducer.maxEvidenceItems,
      maxQuoteChars: config.evidencePreservingReducer.maxQuoteChars,
      minLogBytes: config.evidencePreservingReducer.minLogBytes,
      maxChars: config.evidencePreservingReducer.maxChars,
      timeoutMs: config.evidencePreservingReducer.timeoutMs,
      providerID: config.evidencePreservingReducer.providerID,
      modelID: config.evidencePreservingReducer.modelID,
    }));
  }
  hooks = mergeHooks(hooks, createObservationPackHooks(input, config.observationPack));
  hooks = mergeHooks(hooks, createOnlineContextCompactHooks(input, config.onlineContextCompact));
  return hooks;
}

/** Legacy function entry for opencode-ai < 1.18.29. */
export const SolPiOpenCodePlugin: V1Plugin = server;

// Official dual-entry pattern (migrate-v1 "Support V1 and V2 from one package").
export default {
  ...V2Plugin.define({
    id: "sol-pi-opencode",
    async setup(ctx) {
      const config = await loadConfig(ctx.location.directory);
      const cleanups: Array<() => Promise<void> | void> = [];
      if (config.observationPack.enabled) {
        cleanups.push(await registerObservationPack(ctx, config.observationPack));
      }
      if (config.actionFusion.enabled) {
        cleanups.push(await registerActionFusion(ctx, config.actionFusion));
      }
      if (config.onlineContextCompact.enabled) {
        cleanups.push(await registerOnlineContextCompact(ctx, config.onlineContextCompact));
      }
      if (config.evidencePreservingReducer.enabled) {
        cleanups.push(await registerEvidencePreservingReducer(ctx, config.evidencePreservingReducer));
      }
      return async () => {
        for (const cleanup of cleanups) await cleanup();
      };
    },
  }),
  server,
};
