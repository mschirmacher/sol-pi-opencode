# opencode v1.19.0 internals — source-level spike

Source: sparse clone at `_refs/opencode-v1.19.0` (tag v1.19.0, commit 733b2c6), paths below relative to `packages/opencode/src/`.

## TL;DR

| # | Question | Answer |
|---|----------|--------|
| Q1 | `experimental.chat.messages.transform` — copy or live reference? | **Projected fresh copy** loaded from storage per loop iteration; in-place mutation is allowed and only affects the next provider request. Never written back. (FACT) |
| Q2 | Truncation before `tool.execute.after`? Limits? | **Yes, truncated before the hook.** Generic ceiling: 2000 lines / 50 KB (config-overridable). Effective after-hook ceiling ≈ 50 KB + hint text, but the hook may inflate `output.output` beyond it — no re-truncation after the hook. (FACT) |
| Q3 | Is the after-hook's rewritten `output.output` what the model sees? | **Yes.** execute → truncate → after-hook (mutates in place) → returned to AI SDK → provider request + persistence both use the post-hook value. (FACT) |
| Q4 | `client.session.summarize` handler | `POST /session/:id/summarize` → cleanup revert, insert compaction part (`Compaction.create`), then `prompt.loop` → compaction runs and **session continues** (synthetic "Continue…" user msg unless `experimental.compaction.autocontinue` disabled). Params: `providerID`, `modelID`, `auto?`. (FACT) |
| Q5 | Persist tool output before or after after-hook? | **After.** Storage receives the post-hook value. (FACT) |

## Q1 — `experimental.chat.messages.transform`

Invocation sites (only two):

- `session/prompt.ts:1255` — main loop, right before building the provider request.
- `session/compaction.ts:379` — during compaction, on `structuredClone(selected.head)` (explicit clone).

Main-loop data flow (`session/prompt.ts`):
- `1092`: `let msgs = yield* MessageV2.filterCompactedEffect(sessionID)` — fresh read from storage each iteration; `filterCompacted` (`session/message-v2.ts:534-585`) builds a **new array** (`const result = []`, reordered for model consumption: `[compaction-user, summary, ...tail...]`).
- `1180`: `msgs = yield* SessionReminders.apply({ messages: msgs, ... })`.
- `1255`: `plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })` — `msgs` passed **by reference**; plugins may splice/mutate in place.
- `1262`: `MessageV2.toModelMessagesEffect(msgs, model)` converts the (possibly mutated) array into model messages; `1281`: passed to `handle.process({ messages: ... })`.

`msgs` is never persisted back to storage after the transform. **FACT**: it is a projected copy (fresh deserialization + new filtered array), not a live reference into stored history. In-place mutation is the intended mechanism (the third trigger arg is a mutable output bag). INFERENCE: storage reads deserialize per call, so cross-call aliasing is not possible.

## Q2 — Tool output truncation vs `tool.execute.after`

Generic truncator: `tool/truncate.ts`
- `12-13`: `MAX_LINES = 2000`, `MAX_BYTES = 50 * 1024`.
- `76-80`: overridable via config `tool_output.max_lines` / `tool_output.max_bytes`.
- `85-135`: if over limits → full text saved to truncation dir (7-day retention), content replaced by head/tail preview + `...N lines/bytes truncated...` + hint pointing at the saved file.

Where truncation happens **before** the after-hook:
- Built-in tools: `tool/tool.ts:128-142` — every registered tool's `execute` is wrapped; `truncate.output(result.output, {}, agent)` at `:135`, **skipped only if the tool already set `metadata.truncated`** (self-truncating tools).
- Plugin-defined tools: `tool/registry.ts:159`.
- MCP resource / code-mode wrappers: `session/tools.ts:196, 279, 354, 464` — truncate, then trigger `tool.execute.after` (`:209, 292, 374, 421`).
- Main registry path: `session/tools.ts:104-127` — `item.execute` (already truncated via the tool.ts wrapper) → `tool.execute.after` at `:122`.

Per-tool specifics:
- `read`: `tool/read.ts:14-17` — `MAX_LINE_LENGTH = 2000` chars/line, `MAX_BYTES = 50 KB`; sets `metadata.truncated` itself (`:343-373`).
- `shell` (bash): `tool/shell.ts:569` — `tail(raw, limits.maxLines, limits.maxBytes)` (same 2000/50 KB via `Truncate.limits`), tail direction; `MAX_METADATA_LENGTH = 30_000` (`:27`) caps metadata only.
- `glob`/`grep`: result-count limits with "Results truncated" notices (`tool/glob.ts:51-60`, `tool/grep.ts:81-101`).

**Effective ceiling of `output.output` in the after-hook**: ≤ 2000 lines and ≤ 50 KB of preview plus a few hundred bytes of truncation hint (default config). INFERENCE/FACT: nothing re-truncates after the hook — `session/tools.ts` returns the hook-mutated `output` verbatim — so a plugin may set arbitrarily large `output.output` and it flows through unclamped.

## Q3 — Does the after-hook rewrite reach the model?

Order (registry tools, `session/tools.ts:104-131`):
1. `tool.execute.before` (`:106`)
2. `item.execute(args, ctx)` (`:111`) — output already truncated by `tool/tool.ts:135` wrapper
3. `tool.execute.after` (`:122`) — hook mutates the `output` object **in place** (same reference)
4. `return output` (`:128`) — the AI SDK uses this returned value as the tool result for the next provider request in the same multi-step loop
5. Processor stream: `session/processor.ts:383-412` `case "tool-result"` → `toolResultOutput(value)` (value from the SDK stream = the returned post-hook object) → `completeToolCall` (`:160-184`) → `session.updatePart` persists `output.output` verbatim.

So: execute → truncate → after-hook → (provider request AND persistence) both see the post-hook value. **FACT**. The only post-hook modification is image-attachment normalization (`processor.ts:391-409`, appends an "images omitted" note if resizing fails).

## Q4 — `client.session.summarize`

- Route: `server/routes/instance/httpapi/groups/session.ts:94` (`POST /session/:sessionID/summarize`), endpoint def `:303-311`, OpenAPI identifier `session.summarize`, description: "Generate a concise summary of the session using AI compaction to preserve key information."
- Payload (`groups/session.ts:65-69`): `{ providerID, modelID, auto? }`.
- Handler (`server/routes/instance/httpapi/handlers/session.ts:273-293`):
  1. `revert.cleanup(session)`
  2. `compactSvc.create({ sessionID, agent: currentAgent, model, auto })` — inserts a new **user message with a `compaction` part** (`session/compaction.ts:559-583`); no summarization happens here.
  3. `promptSvc.loop({ sessionID })` — the loop picks up the compaction part and runs `SessionCompaction.process` (`compaction.ts:319+`): selects head vs retained tail by token budget (`select`, `:223-268`), fires `experimental.session.compacting` (`:374`) and `experimental.chat.messages.transform` on a `structuredClone` (`:379`), then runs the `compaction` agent to produce a summary assistant message.
- **Abort or continue?** It does not abort — it *continues*: after compaction, unless a replay is needed, opencode fires `experimental.compaction.autocontinue` (`compaction.ts:501-520`) with bag `{ enabled: true }` and context `{ sessionID, agent, model, provider, message, overflow }`; if still enabled it injects a synthetic user message "Continue if you have next steps, or stop and ask for clarification…" (`:521-540`, marked `metadata.compaction_continue: true`). So semantics ≈ Pi's `compact()` **with autocontinue on by default**; a plugin can veto continuation by setting `enabled: false`. INFERENCE: the handler never interrupts an in-flight generation; `loop` serializes on the session.

Related: compaction also prunes old tool outputs when `compaction.prune` config is on (`compaction.ts:273-317`, `PRUNE_MINIMUM = 20_000`, `PRUNE_PROTECT = 40_000`, `TOOL_OUTPUT_MAX_CHARS = 2_000` at `:28-30`).

## Q5 — Persist before or after the after-hook?

**After.** For registry tools the part is persisted by `processor.completeToolCall` (`session/processor.ts:412 → 171`) from the post-hook returned output. For the task tool, `session/prompt.ts:390` triggers `tool.execute.after` on `result`, then `:400-415` persists `result.output` into the ToolPart. On abort, `session/tools.ts:124-126` persists the post-hook output directly. Stored history therefore always contains the post-hook value; mutating stored history is not a concern for after-hooks in 1.x — the hook runs before persistence.

## Implications for sol-pi-opencode

- **P1 (messages.transform)**: mutating the array in place is safe and idiomatic — it's a per-request projection; stored history is untouched. Do not rely on the array order being chronological (filterCompacted reorders, `message-v2.ts:591-594` comment).
- **P2 (after-hook output rewrite)**: rewriting `output.output` in the after-hook is the correct interception point — it lands in both the provider request and storage. If we want to *shrink* stored tool output we can; if we enlarge it, nothing clamps it (we own the budget).
- **Invariant "never mutate stored history"**: holds naturally — hooks see pre-persistence values, and messages.transform sees a fresh projection. No defensive copying needed on our side, but our hooks must not assume the output object is reused (it isn't persisted twice).
- **Compaction**: to emulate Pi's `compact()` we can call `session.summarize` with `{providerID, modelID, auto:false}`; control continuation via `experimental.compaction.autocontinue` (set `enabled:false` to stop the synthetic continue message).
- **Truncation config**: if we pipe large tool outputs through, remember opencode pre-truncates at 2000 lines / 50 KB (`tool_output.max_lines/max_bytes`) *before* our after-hook sees them — anything beyond that is only available via the saved file in the truncation dir (`metadata.outputPath`).
