# OpenCode Extension/Plugin Surface — Fact Sheet (1.x & 2.x)

Research date: 2026-10-11. FACTS carry a source URL; items marked *(INFERENCE)* are derived, not directly documented.

## TL;DR

- OpenCode = github.com/sst/opencode → **moved to github.com/anomalyco/opencode** (GitHub API 301, repo id 975734319). Docs: `opencode.ai/docs` (v1) and `opencode.ai/v2/docs` (v2).
- npm `opencode-ai` **latest = 1.19.0**; there is **no 2.x on npm** (ETARGET for `>=2.0.0`), but GitHub tags `v2.0.5…v2.0.9` exist and the v2 plugin package `@opencode/plugin` is at **2.0.26** on npm. The v1 plugin package is `@opencode-ai/plugin` (1.19.0).
- **1.x plugin API**: module exports plugin functions `(input, options) => Hooks`; string-keyed hooks (`chat.message`, `chat.params`, `chat.headers`, `permission.ask`, `tool.execute.before/after`, `tool.definition`, `shell.env`, `command.execute.before`, `event`, `config`, `auth`, `provider`, `dispose`, plus `experimental.*` hooks incl. `experimental.session.compacting`).
- **2.x plugin API is a full rewrite**: `export default Plugin.define({ id, setup(ctx) })` from `@opencode/plugin`; hooks are registered per-domain (`ctx.session.hook("context"|"compaction"|"prompt"|…)`, `ctx.tool.hook("execute.before"|"execute.after")`, `ctx.permission.hook("evaluate")`, `ctx.shell.hook("create.before")`) plus replayable `transform()` editors. **V1 plugin implementations do not run in V2.**
- Dual-version support is officially documented: one default export with both a V1 `server()` function and a V2 `setup()`; V1 object entrypoints require **opencode-ai ≥ 1.18.29**.

## Version Landscape

FACTS:
- npm dist-tags for `opencode-ai` (2026-10-11): `latest: 1.19.0`, `latest-1: 1.1.4`, `latest-0: 1.0.142`, plus `next/beta/dev` = `0.0.0-*` snapshot builds. No `2.x` versions in the npm version list; `npm view "opencode-ai@>=2.0.0"` → npm ERR (ETARGET). (npm registry query)
- GitHub tags include `v2.0.5 … v2.0.9`; `package.json` at tag `v2.0.9` has `"version": "2.0.9"`. GitHub *releases* list tops out at `v1.19.0` (no v2 GitHub release objects found). (api.github.com/repos/anomalyco/opencode)
- Plugin packages on npm: `@opencode-ai/plugin` (v1 API) = 1.19.0; `@opencode/plugin` (v2 API) = 2.0.26. (npm registry query)
- Docs banner: "New OpenCode v2 is now available →" (https://opencode.ai/v2). v1 docs remain at https://opencode.ai/docs/.
- 1.x→2.x boundary = the OpenCode v2 release line: new plugin runtime (`@opencode/plugin`, `Plugin.define`), config key `plugin` → `plugins`, new client/SDK packages (`packages/sdk`, `packages/client`, `packages/plugin` restructured with `effect/` + `promise/` entrypoints). (v2 docs + repo tree at tag v2.0.9)

*(INFERENCE)* The v2 CLI is likely distributed outside the plain `opencode-ai@latest` npm tag (installer/desktop/beta channels); how end users install 2.x was not verified — see Open Questions.

## 1.x Extension Surface (verified against tag v1.19.0)

Source of truth: `packages/plugin/src/index.ts` at tag v1.19.0 (saved copy: `/home/thana/_private-projekte/_refs/plugin-index-v1.19.0.ts`) + https://opencode.ai/docs/plugins/ , /docs/custom-tools/ , /docs/agents/.

### Loading
- Local: `.opencode/plugins/` (project), `~/.config/opencode/plugins/` (global) — auto-loaded. Older 1.x/0.x used `.opencode/plugin/`; the v2 migration guide says V2 discovers **both** `plugin/` and `plugins/`. *(INFERENCE: both work on late 1.x too.)*
- npm: config `"plugin": ["pkg", ["./local.ts", {options}]]` (tuple = plugin options; `Config.plugin?: Array<string | [string, PluginOptions]>` in v1.19.0 source). Installed with Bun at startup, cached in `~/.cache/opencode/node_modules/`.
- Load order: global config → project config → global plugin dir → project plugin dir.

### Structure
```ts
// .opencode/plugins/example.ts  (1.x)
import type { Plugin } from "@opencode-ai/plugin"
export const MyPlugin: Plugin = async ({ client, project, directory, worktree, serverUrl, $ }) => {
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool === "read" && output.args.filePath.includes(".env"))
        throw new Error("Do not read .env files")
    },
  }
}
```
- `Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>`.
- `PluginModule = { id?: string, server: Plugin, tui?: never }` — object entrypoint with `server()` supported since **1.18.29** (migration guide).
- Context: `client` (opencode SDK client, e.g. `client.app.log({body:{…}})`), `project`, `directory`, `worktree`, `serverUrl`, `$` (Bun shell), `experimental_workspace.register`.

### Full Hooks interface (v1.19.0 source, verbatim names)
`dispose`, `event`, `config`, `tool` (map of ToolDefinition), `auth` (AuthHook), `provider` (ProviderHook),
`chat.message`, `chat.params`, `chat.headers`, `permission.ask`, `command.execute.before`,
`tool.execute.before`, `tool.execute.after`, `shell.env`, `tool.definition`,
`experimental.chat.messages.transform`, `experimental.chat.system.transform`, `experimental.provider.small_model`,
`experimental.session.compacting`, `experimental.compaction.autocontinue`, `experimental.text.complete`.

Signatures (abridged, from source):
- `chat.message(input:{sessionID,agent?,model?,messageID?,variant?}, output:{message,parts})`
- `chat.params(input:{sessionID,agent,model,provider,message}, output:{temperature,topP,topK,maxOutputTokens,options})`
- `chat.headers(…, output:{headers})`
- `permission.ask(input: Permission, output:{status:"ask"|"deny"|"allow"})`
- `tool.execute.before(input:{tool,sessionID,callID}, output:{args})` — throw to block
- `tool.execute.after(input:{tool,sessionID,callID,args}, output:{title,output,metadata})` — rewrite output (truncation point)
- `tool.definition(input:{toolID}, output:{description,parameters})`
- `experimental.chat.messages.transform(_, output:{messages:{info,parts}[]})`
- `experimental.chat.system.transform(input:{sessionID?,model}, output:{system:string[]})`
- `experimental.session.compacting(input:{sessionID}, output:{context:string[], prompt?})`
- `experimental.compaction.autocontinue(…, output:{enabled})`
- `shell.env(input:{cwd,sessionID?,callID?}, output:{env})`

### Event bus (`event` hook receives `{event}`; documented event types)
`command.executed`, `file.edited`, `file.watcher.updated`, `installation.updated`, `lsp.client.diagnostics`, `lsp.updated`, `message.part.removed/updated`, `message.removed/updated`, `permission.asked`, `permission.replied`, `server.connected`, `session.created/compacted/deleted/diff/error/idle/status/updated`, `tui.prompt.append`, `tui.command.execute`, `tui.toast.show`. (docs/plugins — note: docs list `shell.env` and `tool.execute.*` under "events" but they are hooks in the source.)

### Custom tools (1.x)
- Files in `.opencode/tools/` (project) or `~/.config/opencode/tools/` (global); **filename = tool name**; named exports → `<file>_<export>` (e.g. `math_add`).
- `tool()` helper from `@opencode-ai/plugin`; `args` are Zod (`tool.schema`); `execute(args, context{agent,sessionID,messageID,directory,worktree})`; return string.
- Same-name custom tool **overrides built-in**. Also addable via plugin `tool: { name: tool({...}) }` map.

### Agents & permissions (config-level, 1.x)
- `agent` in `opencode.json` or `.opencode/agents/*.md` (frontmatter). Options: `mode` (primary/subagent/all), `model` (`provider/model-id`), `prompt`, `temperature`, `top_p`, `steps` (max agentic iterations; `maxSteps` deprecated), `permission`, `hidden`, `color`, extra keys passed through as provider options (e.g. `reasoningEffort`).
- Permission keys: `read, edit, glob, grep, list, bash, task, external_directory, webfetch, websearch, lsp, skill, question, doom_loop`; glob patterns per tool incl. MCP (`mymcp_*`); `permission.task` gates subagents via Task tool (last matching rule wins).
- Built-ins: primary `build`, `plan`; subagents `general`, `explore`, `scout`; hidden system agents `compaction`, `title`, `summary`.

## 2.x Extension Surface (verified against v2 docs, 2026-10-11)

Sources: https://opencode.ai/v2/docs/plugins/ , /v2/docs/build/plugins/ , /v2/docs/build/plugins/migrate-v1/ ; repo tree at tag v2.0.9 (`packages/plugin/src/{app,host,options,rpc,source,storage,worktree}.ts`, `effect/`, `promise/`, `tui/`).

### Loading/config
- Config key renamed **`plugin` → `plugins`**; entries: bare name, `pkg@1.2.0`, scoped, local dir/file paths, `file://` URLs, or `{ "package": …, "options": {…} }`. Arrays merge across config files (lowest→highest precedence); `-id` / `*` / `.*` disable/re-enable; built-ins `opencode.config.policy` and `opencode.provider.opencode` cannot be removed.
- Auto-discovery: direct `.ts`/`.js` files + immediate package dirs under every `.opencode/plugins/` (and `.opencode/plugin/`); global `~/.config/opencode/plugins/`.
- CLI management: `opencode plugin add|list|check|update|remove` (npm names, ranges, `github:owner/repo#ref::path:sub`, git+ssh). Hot reload of watched config dirs. CLI-only (TUI) plugins configured in `cli.json`.

### Structure
```ts
// .opencode/plugins/example/index.ts  (2.x)
import { Plugin } from "@opencode/plugin"
export default Plugin.define({
  id: "example",                       // stable id: storage scope + diagnostics
  async setup(ctx) {
    await ctx.tool.hook("execute.before", (event) => { /* one mutable event */ })
    return () => { /* cleanup on unload */ }
  },
})
```
- `ctx` = full server client + plugin API, grouped by domain: `agent, command, event, generate, integration, location, mcp, model, options, permission, plugin, provider, reference, session, shell, skill, storage, tool, vcs, websearch, worktree, app`.
- **Transforms** (replayable state edits): `ctx.<domain>.transform(editor => …)` + `reload()`; editors support `list/get/add/update/remove/default`.
- **Hooks** (intercept live ops; registration object with `dispose()`; later hooks see earlier changes):
  - `ctx.session.hook(name, cb, {providerID?})` with names: `prompt` (admission; edit text/files/agents/skills/delivery/metadata), `context` (agent-loop model request: `event.system`, `event.messages`, `event.tools`, `event.options` incl. `maxTokens`, `temperature`, provider semantic options), `compaction` (edit or set `event.result = {summary}` to skip the model call), `generate`, `title`, `model.request` (headers/settings), `http.request`, `http.response`, `retry` (`event.decision = {retry, delay}`), experimental `experimental.ws.handshake|send|receive`.
  - `ctx.tool.hook("execute.before" | "execute.after")` — after-hook sees `status: "completed"|"error"`, can rewrite `event.result`.
  - `ctx.permission.hook("evaluate")` — runs for allow/ask (configured deny is final); set `event.effect`/`event.message`.
  - `ctx.shell.hook("create.before")` — edit `command, cwd, timeout, shell, env`.
- Events: `for await (const event of ctx.event.subscribe({ signal }))`.
- Storage: `ctx.storage.get/set/remove/scan` (JSON, plugin-id-scoped). Options: `ctx.options`. Version: `ctx.app.version`.
- Sessions: `ctx.session.create/get/context/prompt/generate/command/synthetic/compact/interrupt/wait/switchAgent/switchModel`; `ctx.session.compact({sessionID})` requests compaction.
- `ctx.generate.text({model, prompt})` — one-shot LLM call outside sessions.

### Custom tools (2.x)
- Via `ctx.tool.transform(editor => editor.add({ name, description, input: <JSON Schema>, options: {namespace, codemode}, execute(input, context) }))`; return `{ content }` (Tool.Content: text/file parts); `context.signal` (AbortSignal), `context.progress()`. Namespaces → effective name `ns_tool` (dots → `_`). `editor.update/remove`, `registration.dispose()`. No Zod, no `tool()` helper, no `.opencode/tools/` file convention documented for v2. *(INFERENCE: v2 tool files are registered through transforms, not filename magic.)*

## Breaking Changes 1.x → 2.x (from official migrate-v1 guide)

| Area | 1.x | 2.x |
|---|---|---|
| Config key | `plugin` (string or `[name, options]` tuple) | `plugins` (string/object/path; merge + disable syntax) |
| Plugin shape | exported function `(input, options) => Hooks` | `export default Plugin.define({ id, setup(ctx) })` |
| Package | `@opencode-ai/plugin` | `@opencode/plugin` |
| Hook style | returned object, string keys, `(input, output)` | `ctx.<domain>.hook(name, cb)`, single mutable event |
| `event` hook | returned `event` callback | `ctx.event.subscribe()` async iterable |
| `dispose` hook | returned `dispose()` | cleanup fn returned by `setup` |
| `config` hook | mutate config object | per-domain `transform(...)` (no global config object) |
| `tool` map / `tool()`+Zod | `tool: { name: tool({args: zod}) }` | `ctx.tool.transform` + JSON Schema, `{content}` result |
| `chat.message` | hook | `ctx.session.hook("prompt")` |
| `chat.params` | hook | `ctx.session.hook("context")` → `event.options` |
| `chat.headers` | hook | `ctx.session.hook("model.request")` / `"http.request"` |
| `permission.ask` | hook | `ctx.permission.hook("evaluate")` |
| `command.execute.before` | hook | `ctx.command.transform` or prompt hook (no 1:1) |
| `tool.execute.before/after` | hooks | `ctx.tool.hook("execute.before"/"execute.after")` |
| `shell.env` | hook | `ctx.shell.hook("create.before")` |
| `tool.definition` | hook | `ctx.tool.transform` (update description/schema) |
| `experimental.chat.system.transform` | hook | `session.hook("context")` → `event.system` |
| `experimental.chat.messages.transform` | hook | `session.hook("context")` → `event.messages` |
| `experimental.session.compacting` | hook | `session.hook("compaction")` |
| `experimental.compaction.autocontinue`, `experimental.provider.small_model`, `experimental.text.complete` | exist | **no direct equivalent** — re-evaluate vs session/provider/model/event APIs |
| `auth` / `provider` hooks | AuthHook / ProviderHook | `ctx.integration.transform` / `ctx.provider.transform` + `ctx.model.transform` |
| `$` Bun shell in context | provided | removed — manage process API yourself |
| V1 code in V2 | — | **does not run** (warning in migration guide) |

## Efficiency-Relevant Hooks/Points

1.x (priority):
- **Params/model override**: `chat.params` (temperature/topP/topK/maxOutputTokens/options), `chat.headers`; `experimental.provider.small_model` (swap auxiliary small model).
- **Context/message manipulation**: `experimental.chat.messages.transform` (prune/rewrite whole transcript before send), `experimental.chat.system.transform` (system prompt injection), `chat.message` (rewrite user message/parts).
- **Tool output truncation**: `tool.execute.after` — mutate `output.output` (string) post-execution; `tool.definition` — shrink tool descriptions/schemas sent to LLM.
- **Compaction**: `experimental.session.compacting` (inject `output.context` or replace `output.prompt`), `experimental.compaction.autocontinue` (skip synthetic continue), `session.compacted` event.
- **Agents**: per-agent `model`, `steps` cap, `permission` (incl. `task` gating of subagents), `hidden` subagents; config-only, no plugin needed.
- **Logging**: `client.app.log({body:{service,level,message,extra}})` levels debug/info/warn/error.

2.x equivalents: `session.hook("context")` (system/messages/tools/options incl. `maxTokens`), `session.hook("compaction")` (or fully own it via `event.result`), `session.hook("prompt")`, `tool.hook("execute.after")` (rewrite `event.result`), `tool.transform` (descriptions), `model.transform` (context limits/enabled), `agent.transform` (model per agent, default), `ctx.session.compact()`, `ctx.generate.text()`, `permission.hook("evaluate")` + `ctx.permission.rules()`.

## Strategy to Support Both Versions

Officially documented pattern (migrate-v1 "Support V1 and V2 from one package"):
```ts
import { Plugin } from "@opencode/plugin"
export default {
  ...Plugin.define({ id: "sol-pi", async setup(ctx) { /* V2 registrations */ } }),
  async server(input, options) { return { /* V1 hooks object */ } },
}
```
- V1 calls `server()`, V2 calls `setup()`; APIs stay separate — no automatic translation.
- **V1 object entrypoints require opencode-ai ≥ 1.18.29.** For older 1.x, ship separate package versions/entrypoints.
- Runtime detection: shape of the call — V1 invokes the exported function with `PluginInput` (`client`, `directory`, `$`); V2 invokes `setup(ctx)` where `ctx.session`/`ctx.tool`/`ctx.location` exist. *(INFERENCE: `ctx.app.version` exists in V2; V1 has no documented version accessor — feature-detect instead.)*
- Config compatibility: 1.x reads `plugin`, 2.x reads `plugins` — document both keys; 2.x ignores `plugin`? *(INFERENCE, unverified.)*
- Keep shared logic (pure functions) outside the API surface; map each behavior twice (V1 hook object ↔ V2 domain hook registration).

## Open Questions

- How is the 2.x **CLI** installed? npm `opencode-ai` has no 2.x; GitHub has v2.0.x tags but no v2 GitHub release. Check `opencode.ai/v2` install instructions / desktop app / `beta` channel.
- Exact v2 event-stream type names (`V2EventEncoded`) — not enumerated in fetched docs; see /v2/api schema page.
- Whether `.opencode/plugin/` (singular) still loads on all 1.x versions; current 1.x docs only show `plugins/`.
- v2 equivalent of v1 `experimental.text.complete`, `experimental.compaction.autocontinue`, `experimental.provider.small_model` — docs say none.
- Whether 2.x still honors the legacy `plugin` config key (auto-normalization claim: "Plugin configuration can be normalized automatically").
- v2 TUI/CLI plugin API (`/build/plugins/cli`) and Effect entrypoint (`/build/plugins/effect`) not yet reviewed.

## Sources

- https://opencode.ai/docs/plugins/ (1.x plugins; fetched 2026-10-11)
- https://opencode.ai/docs/custom-tools/ (1.x custom tools)
- https://opencode.ai/docs/agents/ (1.x agents/permissions)
- https://opencode.ai/v2/docs/plugins/ (2.x plugin config/management)
- https://opencode.ai/v2/docs/build/plugins/ (2.x full plugin API: transforms, hooks, tools, storage, events)
- https://opencode.ai/v2/docs/build/plugins/migrate-v1/ (official V1→V2 migration + dual-support)
- https://raw.githubusercontent.com/anomalyco/opencode/v1.19.0/packages/plugin/src/index.ts (local copy: `/home/thana/_private-projekte/_refs/plugin-index-v1.19.0.ts`)
- GitHub API: repo 301 sst→anomalyco; releases (top v1.19.0); tags (v2.0.9); package.json@v2.0.9; packages tree@v2.0.9
- npm registry: `opencode-ai` dist-tags/versions; `@opencode-ai/plugin` 1.19.0; `@opencode/plugin` 2.0.26
