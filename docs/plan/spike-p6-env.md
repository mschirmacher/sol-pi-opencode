# Spike: P6 environment feasibility (sandbox)

Date: 2026-10-12. Read-only spike. All paths/line refs verified in this sandbox and in
`/home/thana/_private-projekte/_refs/opencode-v1.19.0`.

## TL;DR feasibility

| # | Question | Verdict |
|---|----------|---------|
| a | Mine EXISTING local sessions for headroom? | **YES** — 14 sessions / 317 messages / 1374 parts in SQLite `~/.local/share/opencode/opencode.db` (13 MB), 2026-10-11T19:22 → 2026-10-12T06:37, 12 sessions with non-zero tokens. These are this project's own P0–P5 build sessions (cwd `/home/thana/_private-projekte`). |
| b | E2E plugin-load smoke via `opencode serve`? | **YES** — `opencode` 1.19.0 installed globally (`/usr/local/share/npm-global/bin/opencode`, platform binary `opencode-linux-x64` present, `opencode --version` = 1.19.0). Plugin loading from config/directory works (`_refs/.../src/plugin/index.ts:184–231`). |
| c | Full mechanism E2E via mock provider (no key)? | **LIKELY YES** — config-defined provider with `npm: "@ai-sdk/openai-compatible"` + `options.baseURL: http://localhost:PORT` is a first-class path; no real credential required (dummy `apiKey` in options). See citations below. Requires writing a small mock OpenAI-compatible server (not yet written). |
| d | Real A/B runs — which key slots are empty? | **NONE empty**: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `XAI_API_KEY` all set in env; `~/.local/share/opencode/auth.json` exists (66 B). Outbound is firewall-permitted: `api.openrouter.ai` → 200, `api.openai.com`/`api.anthropic.com` → 401 (reachable, unauthenticated probe). **Key validity unverified** (values never printed) — user must confirm which are real, or A/B can run against the sandbox's own `devbox-ai` proxy provider (cost fields are 0 there, so bill comparisons would be token-only). |

## Session storage schema (for `scripts/measure.mjs`)

opencode 1.19.0 stores sessions in **SQLite**, not JSON files. The legacy JSON dir
`~/.local/share/opencode/storage/` contains only `migration` and one empty
`session_diff/ses_*.json` (`[]`). Do NOT parse JSON files; open the DB read-only
(Node 22 `node:sqlite` works: `new DatabaseSync(path, {readOnly:true})`).

DB: `~/.local/share/opencode/opencode.db`

Relevant tables (counts here): `session` (14), `message` (317), `part` (1374),
`project` (1). Also `session_message`/`session_input` (0 rows here — newer queue tables).

### `session` columns (flat, directly usable)
`id, project_id, workspace_id, parent_id, slug, directory, path, title, version,
share_url, summary_additions, summary_deletions, summary_files, summary_diffs,
metadata, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read,
tokens_cache_write, revert, permission, agent, model, time_created, time_updated,
time_compacting, time_archived`

### `message.data` (JSON string) — assistant example (redacted/truncated)
```json
{"parentID":"msg_12c6…","role":"assistant","mode":"orchestrator","agent":"orchestrator",
 "path":{"cwd":"/home/thana/_private-projekte","root":"/"},
 "cost":0,
 "tokens":{"total":12283,"input":199,"output":2883,"reasoning":0,"cache":{"write":0,"read":9201}},
 "modelID":"qwen3.8-flash-next-iq3_xxs","providerID":"devbox-ai",
 "time":{"created":1791746841695,"completed":1791746883332},
 "finish":"tool-calls"}
```

### `part.data` (JSON string) — type distribution in this dataset
`text:54, step-start:301, reasoning:301, tool:426, step-finish:296`

Tool part shape (args/output redacted/truncated):
```json
{"type":"tool","tool":"todowrite","callID":"call_77a5…",
 "state":{"status":"completed","input":{"todos":[{"content":"Research SoL-Pi repo…","status":"in_progress",…}]},"output":"…"}}
```
- Tool name = `part.tool`; args = `state.input`; result = `state.output` (string).
- Large outputs are **offloaded** to `~/.local/share/opencode/tool-output/<callID>` files
  (1 such file present here); max inline `part.data` length observed: 53,958 B.
  measure.mjs must check both inline output and the tool-output dir for replay-byte measurement.

Step-finish part (per-step bill/tokens — this is the per-request unit):
```json
{"reason":"tool-calls","type":"step-finish",
 "tokens":{"total":12283,"input":199,"output":2883,"reasoning":0,"cache":{"write":0,"read":9201}},
 "cost":0}
```

### Compaction
No dedicated compaction part type exists in this dataset; `session.time_compacting` is NULL
for all 14 sessions (no compaction occurred). The 253 `LIKE '%compact%'` part hits are tool
*output text*, not compaction markers. measure.mjs must treat compaction as optional:
detect via `session.time_compacting` and/or a compaction part type if present in exported
sessions from other machines.

## Mock-provider feasibility (citations, `_refs/opencode-v1.19.0`)

- `packages/opencode/src/provider/provider.ts:158` — `"@ai-sdk/openai-compatible"` is a
  **bundled** provider SDK (`BUNDLED_PROVIDERS` → `createOpenAICompatible`); no npm install needed.
- `provider.ts:1540–1542` — providers declared in `opencode.json` `provider` block get
  `source: "config"` and their `models` are parsed (`:1329` default npm is
  `@ai-sdk/openai-compatible`).
- `provider.ts:1698–1706` — config `provider.options` are merged into provider options.
- `provider.ts:1757–1760` — a config provider stays enabled as long as it has ≥1 model;
  **no key check** at this stage.
- `provider.ts:1818–1831` — `options.baseURL` overrides the model API URL;
  `apiKey` is only injected from stored auth **if present** (`:1829`) — with no auth,
  set a dummy `apiKey` in options so the ai-sdk factory is satisfied.
- `provider.ts:777` — when `baseURL` is configured, provider autoload/env-detection is skipped.

Working config shape (for a mock at localhost:8787):
```json
{
  "provider": {
    "mock": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Mock",
      "options": { "baseURL": "http://localhost:8787/v1", "apiKey": "mock" },
      "models": { "mock-model": { "name": "Mock", "limit": { "context": 200000, "output": 8192 } } }
    }
  },
  "model": "mock/mock-model"
}
```
Caveat: the mock server must speak the OpenAI chat-completions protocol (SSE stream,
`tool_calls`, and `usage` in the final chunk — `includeUsage` is forced true for
openai-compatible at `provider.ts:1806–1808`).

## Install feasibility

- npm registry reachable: `npm view opencode-ai@1.19.0 version` → `1.19.0`.
- Platform packages (optionalDependencies): `opencode-linux-x64`, `opencode-linux-arm64`,
  `opencode-linux-x64-musl`, `opencode-darwin-*`, `opencode-windows-*`, `*-baseline` variants —
  the matching `opencode-linux-x64` binary is already installed here. No install needed in-sandbox.

## Recommended P6 execution plan

1. **[in-sandbox, now]** Write `scripts/measure.mjs` against the SQLite schema above
   (node:sqlite, readOnly). Metrics: edit→run adjacency (edit/write/bash tool parts),
   large-output replay bytes (inline `state.output` + `tool-output/` files), step-finish
   token/cost series per session.
2. **[in-sandbox, now]** Mine the 14 existing sessions as the "mechanisms OFF" baseline
   (they predate sol-pi-opencode activation; provider `devbox-ai`, cost=0 → token-only metrics).
3. **[in-sandbox]** Plugin-load smoke: `opencode serve` with `plugin` entry pointing at
   repo `src/index.ts`; assert plugin hooks register (log line / config echo).
4. **[in-sandbox]** Mechanism E2E: mock OpenAI-compatible server on localhost + config above;
   drive scripted sessions through `opencode serve` HTTP API; measure mechanisms ON.
5. **[needs user]** Real A/B (bill + tokens + response counts, same model, paired runs):
   confirm which env keys are real (or authorize using the `devbox-ai` proxy provider —
   tokens only, no bill). Alternatively user exports richer sessions (with compaction)
   from their host `~/.local/share/opencode/opencode.db` for offline mining.
6. **[in-sandbox]** Produce `docs/plan/measurement-report.md` with per-mechanism
   go/no-go vs SoL-Pi reported deltas; flag small-n noise explicitly.
