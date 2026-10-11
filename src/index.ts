import { Plugin as V2Plugin } from "@opencode/plugin";
import type { Hooks, Plugin as V1Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin";
import { loadConfig } from "./core/config.js";
import { createObservationPackHooks } from "./v1/observation-pack.js";

/** V1 object-entrypoint server (opencode-ai >= 1.18.29). */
export async function server(input: PluginInput, options?: PluginOptions): Promise<Hooks> {
  const config = await loadConfig(input.directory);
  return createObservationPackHooks(input, config.observationPack);
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
