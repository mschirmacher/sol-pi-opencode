import { Plugin as V2Plugin } from "@opencode/plugin";
import type { Hooks, Plugin as V1Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin";
import { loadConfig } from "./core/config.js";
import { createActionFusionHooks } from "./v1/action-fusion.js";
import { createObservationPackHooks } from "./v1/observation-pack.js";

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
  hooks = mergeHooks(hooks, createObservationPackHooks(input, config.observationPack));
  return hooks;
}

/** Legacy function entry for opencode-ai < 1.18.29. */
export const SolPiOpenCodePlugin: V1Plugin = server;

// Official dual-entry pattern (migrate-v1 "Support V1 and V2 from one package").
export default {
  ...V2Plugin.define({
    id: "sol-pi-opencode",
    async setup(ctx) {
      // TODO(P5): v2 adapter — register ObservationPack via
      // ctx.tool.hook("execute.after") (archive), ctx.session.hook("context")
      // (projection), ctx.tool.transform (sol_pi_recall), ctx.storage (ledger).
      // Config is already read here so P5 only adds registrations.
      const directory = (ctx as { location?: { directory?: string } }).location?.directory ?? process.cwd();
      await loadConfig(directory);
    },
  }),
  server,
};
