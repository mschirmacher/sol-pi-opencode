# Spike P6b: end-to-end mechanism validation against real opencode 1.19.0

Date: 2026-10-12. Harness: `scripts/e2e/mock.mjs` + `scripts/e2e/run.mjs`.
All four scenarios PASS against the real `opencode` 1.19.0 binary with a local
OpenAI-compatible mock provider (no API keys). **No plugin bugs found — `src/` untouched.**

## Working invocation (exact)

```
opencode run --auto --model mock/test "<goal>"     # cwd = scenario dir (git init'd)
```

Provider config in the scenario's `opencode.json` (per spike-p6-env.md):
`provider.mock = { npm:"@ai-sdk/openai-compatible", options:{ baseURL:"http://127.0.0.1:8787/v1", apiKey:"dummy" }, models:{ test:{ limit:{context,output} } } }`.
No key check fires for config providers — confirmed empirically.

## Plugin loading method chosen

Auto-discovered shim file `.opencode/plugins/sol-pi.ts` in the scenario project:

```ts
export { server, SolPiOpenCodePlugin } from "<repo>/src/index.ts";
export { default } from "<repo>/src/index.ts";
```

The 1.19.0 binary embeds Bun, so TypeScript loads directly — no `dist` build needed.
Module resolution walks up from the repo path, so the repo's `node_modules`
(`@opencode-ai/plugin`, `effect`) resolve correctly. The V1 object entrypoint
(`default.server`) is picked up; the plugin's `tool` map (`sol_pi_recall`) appears
in every main request's tool schemas.

## Harness facts (pitfalls that cost iterations)

- Scenario dir MUST be `git init`-ed, else opencode resolves the project root to
  the enclosing repo and the scenario config/provider is not seen.
- `PWD` env var is honored for project resolution — the harness must set `PWD`
  (and `OPENCODE_CONFIG_DIR` isolation + fresh `XDG_{DATA,CACHE,CONFIG}_HOME`
  per scenario) when spawning, otherwise the parent opencode session's cwd leaks in.
- The hidden `title` agent issues its own chat request BEFORE the main loop and
  its prompt embeds the user goal — the mock must special-case it
  (`"title generator"` in system) or it consumes a scripted response.
- Built-in tool names exposed to the provider (verified in captured bodies):
  `bash, edit, glob, grep, read, skill, task, todowrite, webfetch, write` (+ `sol_pi_recall`).
  `bash` is the shell tool id (`tool/shell/id.ts`: `ToolID = "bash"`).
- Mock must emit SSE with a final `usage` chunk (includeUsage forced for
  openai-compatible) — OCC economics read step-finish tokens from it.

## Per-scenario results

| Scenario | Result | Evidence asserted |
|---|---|---|
| S1 observation-pack | PASS (5 reqs) | 30 KB `cat big.txt` output archived under `$XDG_CACHE_HOME/opencode/sol-pi/<session>/`; exactly 2 provider requests carry the full output (fullSends=2), later requests carry `PLACEHOLDER_MARKER` + `id: obs_…` handle and no middle bytes; `sol_pi_recall` in later tool schemas; SQLite `part` table still holds the full output (projection never touches stored history). |
| S2 action-fusion | PASS (3 reqs) | `thenRun` present in the model-facing `edit` JSON Schema (tool.definition jsonSchema swap works on 1.19.0); built-in edit applied on disk; single combined observation contains `[then_run:succeeded]` + `FUSED_OK` stdout; `thenRun` stripped before execution. |
| S3 reducer | PASS (5 reqs) | `make -s` build log ≥ minLogBytes archived under `…/reducer/objects/…`; throwaway reducer session issued a real model call (system = reducer instructions); mock returned a valid receipt (byte-exact quotes, sha256 of the exact `make -s` stdout); final tool output replaced by `sol_pi_evidence_receipt_v1` marker; journal shows `applied`; throwaway session deleted (DB has exactly 1 session). |
| S4 occ | PASS (4 reqs) | `todowrite` completion → `todo.updated` boundary (OCC state file under `…/sol-pi/_occ/`); on `session.idle` economics fired (windowReserveTokens=1, model limit.context=8000, usage 7000+500 → window_protection); `client.session.summarize` ran a compaction model call; DB `session.time_compacting` set; run continued and exited 0. No serve+SDK needed — run-mode headless works. |

## Plugin bugs found

None. All four mechanisms fired end-to-end as designed on the first working
harness configuration. (Harness bugs fixed along the way: missing `git init`,
`PWD` leak, title-agent request stealing, mock crash on relative receipt path —
all in `scripts/e2e/`, not the plugin.)

## Commits

- `eb48911` P6b: mock provider + harness skeleton
- `1fecc3d` P6b: S1 observation-pack E2E
- `9b8a4e9` P6b: S2 action-fusion E2E
- `92c849d` P6b: S3 reducer E2E
- `e5b21dc` P6b: S4 online-context-compact E2E

Unit tests unchanged: 78/78 pass; `tsc --noEmit` clean.

## Reproduce

```
node scripts/e2e/run.mjs s1|s2|s3|s4   # artifacts under .e2e/<scenario>/
```
