# Mechanism mapping: SoL-Pi → opencode plugin

Core design doc. Each mechanism: SoL-Pi recap → opencode 1.x sketch (priority) →
2.x sketch → risks/feasibility/open questions. Hook names are verbatim from
`docs/research/opencode-extensions.md` and `_refs/plugin-index-v1.19.0.ts`.

Resolved design questions (a)–(d) are inline in the relevant mechanism and
summarized at the bottom.

---

## 1. ObservationPack — PRIORITY #1

**Feasibility: High.** Pure projection logic; proven −23.58% provider bill in
SoL-Pi's paired EdgeBench A/B (score +22.92%, responses +0.20%).

### SoL-Pi behavior

Intercepts the **projected** message list (Pi `context` event); stored history
stays intact. Pure-text tool results > **10 KiB** (`THRESHOLD_BYTES`) are
archived to content-addressed local files `obs_<24-hex>.txt`. The payload is
sent **in full for the first 2 provider requests** (`FULL_SENDS`), then replaced
by a placeholder with a bounded head/tail excerpt (code default
`PLACEHOLDER_EXCERPT_BYTES = 1024`, split evenly head/tail; blog's sweep config
differs — verify before shipping). A registered **recall tool** re-reads exact
pages by byte offset. Token estimate 4 chars/token. Fail-open: any packing
error leaves the observation untouched. Reducer receipts are never re-packed.

### opencode 1.x sketch

- **Archive:** `tool.execute.after` (`input:{tool,sessionID,callID,args}`,
  `output:{title,output,metadata}`): if `output.output` is text > 10 KiB, write
  exact bytes to the archive dir (see question (c)), record in a ledger
  (`callID → {sha256, size, sends: 0}`). Do **not** replace here — first sends
  must be full.
- **Projection:** `experimental.chat.messages.transform(_, output:{messages})`:
  walk projected messages for tool-result parts matching ledger entries;
  increment send count per request; after `FULL_SENDS = 2`, replace the part
  text with a byte-stable placeholder: head/tail excerpt + `obs_<hash>` handle
  + recall instructions. Idempotent per request; never rewrite an already
  replaced part.
- **Recall tool:** plugin `tool` map — `tool({ description, args: z.object({handle, offset, limit}), execute })`
  returning the exact byte page from the archive. (Same-name override not needed;
  new name e.g. `sol_pi_recall`.)
- **Pi gap:** Pi's `context` event has no stable 1.x equivalent —
  `experimental.chat.messages.transform` is the only whole-transcript projection
  point and is *experimental*. Verify at P1 that the transform receives a
  projected copy, not a live reference into stored history (must not mutate
  history). If it mutates history, fall back to copy-on-write inside the hook.

### opencode 2.x sketch

- `ctx.tool.hook("execute.after")` → archive (same logic; rewrite nothing).
- `ctx.session.hook("context")` → edit `event.messages` (the stable projection
  point; replaces `experimental.chat.messages.transform`).
- Recall tool via `ctx.tool.transform(editor => editor.add({name, description,
  input: <JSON Schema>, execute}))`.
- Ledger via `ctx.storage` (plugin-id-scoped JSON); raw archives stay on disk
  (`ctx.storage` is JSON-only).

### Risks / open questions

- Experimental-hook churn in 1.x (`messages.transform`); pin tested versions.
- Does 1.x truncate tool output before `tool.execute.after` sees it? If opencode
  truncates first, the archive is incomplete — P1 spike must measure the real
  `output.output` size ceiling and archive from the source (re-read file /
  re-run capture) if truncated.
- Prompt-cache stability: see question (d).

---

## 2. Action Fusion — PRIORITY #2

**Feasibility: High.** Simple, local; SoL-Pi counterfactual −10.8% turns /
−11.5% tokens (trajectory-derived, not rerun).

### SoL-Pi behavior

Adds optional `then_run: {command, timeout}` to edit/write tool definitions.
Harness applies the mutation and runs the command **inside one tool call**,
returning one combined observation — "removing the middle model decision."
Safety: per-file queue serializes fused ops; target file's **sha256 re-checked
immediately before launching the command**; if changed → skip with
`[then_run:skipped]`. Tags: `[then_run:succeeded|failed|skipped]`.

### opencode 1.x sketch

- **Schema:** `tool.definition(input:{toolID}, output:{description, parameters})`
  for built-in `edit` and `write`: append optional `thenRun: {command, timeout}`
  to the JSON schema + description guidance (SoL-Pi's prompt search reached 100%
  trigger rate — copy its wording).
- **Hash capture:** `tool.execute.before` — record target file path + pre-state;
  enqueue per-file mutex (plugin-memory queue keyed by absolute path).
- **Fused run:** `tool.execute.after` — after the edit completed: re-hash the
  file; if it differs from the post-edit expectation (concurrent change while
  queued) → append `[then_run:skipped]`; else run the command via `$` (Bun shell
  from PluginInput) or `node:child_process`, append tagged stdout/stderr to
  `output.output`. One tool result reaches the model → same "one observation"
  effect.
- **Pi gap:** opencode has no way to extend the *built-in tool executor* itself;
  the after-hook is the closest in-call execution point. Acceptable because the
  after-hook result is what the model sees as the single observation. Risk:
  if 1.x streams/persists the tool output before the after-hook rewrite, the
  combined observation may not be atomic — verify at P2.

### opencode 2.x sketch

- `ctx.tool.transform(editor => editor.update(...))` to add `thenRun` to
  edit/write input JSON Schema (replaces `tool.definition`).
- `ctx.tool.hook("execute.before")` hash capture; `ctx.tool.hook("execute.after")`
  fused run + rewrite `event.result` (after-hook sees `status`).
- No `$` Bun shell in V2 — spawn the process ourselves.

### Risks

- Schema additions may confuse models on small providers — keep optional and
  documented; mechanism is opt-in anyway.
- Command sandboxing/permissions: the fused command bypasses the `bash` tool's
  permission flow. **Mitigation:** route fused commands through
  `client`-side permission checks if reachable, else restrict to allow-listed
  prefixes from config; default-off.

---

## 3. Online Context Compact (OCC) — PRIORITY #3

**Feasibility: Medium.** Economics math is pure/portable; trigger plumbing is
the uncertain part (now narrowed — see (b)).

### SoL-Pi behavior

Pi's native compaction is late (window pressure). OCC keeps a plan
(`{id, goal, status: pending|in_progress|completed}`); a step → `completed` is a
**compaction boundary candidate**. Whether to compact is an economics decision:
estimate remaining requests from requests-per-boundary history (stddev lower
bound) + window headroom (`windowReserveTokens: 16_384`); break-even vs rewrite
cost; charge cache discontinuity at `cacheWriteReadRatio` (default **12.5**);
require ≥ 2 requests since last compaction; `subsequentCompactionMargin: 1.5`
for repeats. Continuation: Pi's `compact()` aborts the agent, so OCC saves
state, aborts, compacts from `agent_settled`, then sends a hidden message with
`triggerTurn: true`.

### opencode 1.x sketch

- **Plan state:** piggyback opencode's built-in todo list via
  `client.session.todo({sessionID})` (SDK has it — verified in
  `@opencode-ai/sdk@1.19.0`); optionally a small `sol_pi_plan` tool in the
  plugin `tool` map for boundary metadata.
- **Trigger (RESOLVED, see (b)):** `client.session.summarize({sessionID})`
  exists in the 1.x SDK ("Summarize the session") — the on-demand compaction
  endpoint. Economics gate computed in core; on YES, call `summarize`.
- **Compaction shaping:** `experimental.session.compacting(input:{sessionID},
  output:{context, prompt})` — inject completed-step boundaries into the
  compaction prompt.
- **Continuation:** `experimental.compaction.autocontinue` defaults to
  `enabled: true` — the synthetic user "continue" turn is opencode's equivalent
  of Pi's `triggerTurn: true` hidden message. Keep default; use the
  `session.compacted` event to update ledger/last-compaction state.
- **Pi gap:** no `agent_settled` event; nearest is `session.idle` /
  `session.status` on the `event` bus. Choose safe trigger points (see risks).

### opencode 2.x sketch

- `ctx.session.compact({sessionID})` — first-class on-demand trigger.
- `ctx.session.hook("compaction")` — shape the summary, or fully own it via
  `event.result = {summary}` (skip the model call entirely).
- Plan state: `ctx.session` todo surface / plugin storage; economics unchanged.

### Risks / open questions

- **Mid-turn races:** calling `summarize` while the agent loop is active may
  conflict with 1.x's internal pressure-triggered compaction. Mitigation: fire
  only at quiescent points (`session.idle` event, or immediately after a
  tool-result boundary), guarded by a re-entrancy flag; listen for
  `session.compacted` to reconcile.
- Does 1.x `summarize` respect `experimental.session.compacting`? Verify at P3.
- Usage/token accounting: Pi's `getContextUsage()` has no documented 1.x plugin
  equivalent — derive token estimates from message parts (4 chars/token like
  SoL-Pi) or from `message.updated` token metadata; P3 spike.

---

## 4. Evidence-Preserving Reducer — PRIORITY #4

**Feasibility: Medium.** The verifier is trivially portable; the one-shot model
call is the only missing primitive in 1.x (see (a)).

### SoL-Pi behavior

Long diagnostic logs (build/test output) are delegated to a cheaper reducer
model. It must return a JSON receipt where every `evidence` item is an **exact
contiguous byte-for-byte quote** from the log. `validateReceipt()` accepts only
if: schema matches, `source_sha256` matches the archive, status matches the
observed exit (`is_error`), ≤ max evidence items, each quote ≤ max chars, and
`body.includes(quote)` for every quote. Any failure → original log passes
through unchanged. Reducer prompt treats the log as untrusted data; forbids
diagnosing fixes / claiming absence of failures; `uncertain=true` when
ambiguous; likely-secret checks gate reduction.

### opencode 1.x sketch

- **Eligibility + archive:** `tool.execute.after` on bash/edit outputs that look
  like long build/test logs; archive exact bytes + sha256 (same archive dir as
  ObservationPack).
- **Model call (RESOLVED as decision, see (a)):** throwaway session via the SDK:
  `client.session.create(...)` → `client.session.prompt({sessionID, model:
  {providerID, modelID}, parts:[reducer prompt + log]})` → read reply via
  `client.session.messages(...)` → `client.session.delete(...)`. Harden with a
  hidden config agent (`mode:"subagent"`, `hidden:true`, `steps:1`, all
  mutating permissions `deny`) so the throwaway run can't use tools.
- **Verify:** pure `validateReceipt()` in core (byte-exact `includes` + sha256 +
  status match). On success replace `output.output` with the receipt (tagged so
  ObservationPack excludes it from re-packing); on any failure fail-open.
- **Pi gap:** Pi has `.model` + `.modelRegistry` + Pi-managed auth for direct
  calls; 1.x plugins have no documented one-shot completion API
  (`experimental.text.complete` is bound to a session message part — not a
  general LLM call). Hence the throwaway-session workaround.

### opencode 2.x sketch

- `ctx.generate.text({model, prompt})` — exactly the needed one-shot primitive.
- `ctx.tool.hook("execute.after")` for eligibility/archive/replacement;
  `ctx.model.transform` / config for reducer model selection.

### Risks

- Throwaway-session path is heavyweight (extra session lifecycle, latency) and
  depends on undocumented prompt-parts shapes — P4 spike decides between it and
  a direct provider call (via `provider` hook config + provider SDK); defer if
  neither is clean.
- Prompt-injection: reducer prompt must copy SoL-Pi's untrusted-data framing.

---

## Resolved cross-cutting design questions

**(a) 1.x one-shot model call for the Reducer.** Options: (1) throwaway session
via `client.session.create/prompt/messages/delete` + hidden no-tools agent —
works with existing auth, heavyweight; (2) direct provider call using the
`provider` hook's config + provider SDK — lighter but auth access is
undocumented/fragile; (3) defer. **Decision:** option (1) as the design, with a
P4 spike; option (2) as fallback; mechanism stays default-off. V2 has
`ctx.generate.text` — no issue.

**(b) 1.x on-demand compaction trigger.** **RESOLVED:** `@opencode-ai/sdk`
(1.19.0, the `client` in PluginInput) exposes `session.summarize` (POST
`/session/:id/summarize`) plus `session.abort`, `session.prompt`,
`session.todo`. Trigger only at quiescent points; reconcile via
`session.compacted` event.

**(c) 1.x archive location (no `ctx.storage`).** Plugin-managed dir:
`$XDG_CACHE_HOME/opencode/sol-pi/<sessionID>/obs_<24-hex>.txt` (fallback
`os.tmpdir()/opencode-sol-pi/...`), keyed by sessionID, content-addressed
filenames; ledger JSON alongside (`ledger.json`). Cleanup on `session.deleted`
event + TTL sweep at plugin load. V2: ledger in `ctx.storage`, raw archives
still on disk (JSON-only storage).

**(d) Prompt-cache prefix stability when rewriting projected messages.** Any
replacement is a cache discontinuity from the replaced offset onward — this is
why SoL-Pi sends full payloads twice first. Port the same discipline:
`FULL_SENDS = 2` warm-up; **batch** replacements so discontinuities cluster in
as few requests as possible; placeholders byte-stable across requests (never
re-render); never rewrite an already-replaced or older-than-boundary message;
count each discontinuity in OCC economics via `cacheWriteReadRatio = 12.5`.
Open sub-question: whether 1.x `messages.transform` runs before per-provider
cache breakpoints are computed — assume yes (it is pre-request), verify at P1.

## Priority order (with justification)

1. **ObservationPack** — proven −23.58% bill; pure projection logic; no model
   calls; no compaction plumbing.
2. **Action Fusion** — simple schema+after-hook work; −11.5% tokens
   counterfactual; local-only side effects.
3. **OCC** — economics is pure/portable, but trigger/continuation plumbing is
   the least certain (mid-turn races, usage accounting).
4. **Reducer** — needs the one-shot model-call primitive; safety verifier is
   easy, plumbing is the risk; benefits compound with ObservationPack archives.

## Cross-cutting invariants (copied from SoL-Pi)

- **Opt-in, default-off:** config file `sol-pi.json` (search order:
  `.opencode/sol-pi.json` project-trusted, else
  `~/.config/opencode/sol-pi.json`; no merge; keys `actionFusion`,
  `observationPack`, `evidencePreservingReducer(+Provider/+Model)`,
  `onlineContextCompact`, `cacheWriteReadRatio: 12.5`).
- **Fail-open:** any mechanism error → original observation/flow untouched.
- **Never mutate stored history** — project only.
- **Exact local archives** for every reduction → recall/verification is lossless.
- **Deterministic verification** (byte-exact quotes, sha256 guards, per-file
  queues) — safety checks are string matching, not another LLM.

## Addendum — spike findings (2026-10-11)

Source-level facts from `docs/research/opencode-v1-internals.md` (v1.19.0):

1. **ObservationPack archive exactness:** opencode pre-truncates tool output at
   2000 lines / 50 KB *before* `tool.execute.after` fires (Q2), so the archive
   is exact with respect to the post-truncation observation the model receives;
   bytes beyond the ceiling exist only in opencode's own truncation file
   (`metadata.outputPath`).
2. **Action Fusion validated:** the after-hook's rewritten `output.output` is
   both what the model sees and what gets persisted (Q3/Q5) — the fused
   single-observation design works as sketched. Consequence: ObservationPack
   must stay **projection-only** (rewrite only `messages.transform` copies);
   after-hook rewrites already reach storage.
3. **OCC continuation:** `client.session.summarize` does not abort — it inserts
   a compaction part and continues the loop with a synthetic "Continue…" user
   message (`experimental.compaction.autocontinue`, default on) (Q4). No
   Pi-style save-state/abort/`agent_settled` dance needed in 1.x.
