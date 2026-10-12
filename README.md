# sol-pi-opencode

opencode plugin porting the four token-efficiency mechanisms of
[NVlabs/SoL-Pi](https://github.com/NVlabs/SoL-Pi) to opencode — for opencode
**1.x** and **2.x** from one package. Research and per-mechanism design:
[`docs/research/`](docs/research/) and [`docs/plan/mapping.md`](docs/plan/mapping.md).
Phase status: [`STATUS.md`](STATUS.md).

All four mechanisms are **opt-in (default off)** and **fail-open**: any
internal error leaves the session exactly as opencode would have handled it.

## Install

**opencode 1.x** (≥ 1.18.29 for the object entrypoint) — `opencode.json`:

```json
{ "plugin": ["sol-pi-opencode"] }
```

or drop the package (or a `.ts`/`.js` file re-exporting it) into
`.opencode/plugins/`.

**opencode 2.x** — `opencode.json`:

```json
{ "plugins": ["sol-pi-opencode"] }
```

One package, dual entry: 1.x calls the exported `server()`, 2.x calls
`Plugin.define({ id, setup })`.

## Configuration

`.opencode/sol-pi.json` (project) or `~/.config/opencode/sol-pi.json` (global).
First file found wins; all flags default to `false`:

```json
{
  "observationPack": { "enabled": true, "thresholdBytes": 10240, "fullSends": 2, "excerptBytes": 1024 },
  "actionFusion": { "enabled": true, "commandTimeoutMs": 60000, "allowList": [] },
  "onlineContextCompact": { "enabled": true, "windowReserveTokens": 16384, "cacheWriteReadRatio": 12.5, "minRequestsBetween": 2, "subsequentCompactionMargin": 1.5 },
  "evidencePreservingReducer": { "enabled": true, "providerID": "anthropic", "modelID": "claude-haiku-...", "maxEvidenceItems": 12, "maxQuoteChars": 600, "minLogBytes": 4096, "maxChars": 600000, "timeoutMs": 90000 },
  "cacheWriteReadRatio": 12.5
}
```

## Mechanisms

**ObservationPack** — tool results above `thresholdBytes` are archived to disk
(`$XDG_CACHE_HOME/opencode/sol-pi/<sessionID>/`). After `fullSends` provider
requests carrying the full payload, projected copies are replaced by a
byte-stable placeholder with a head/tail excerpt; an added `sol_pi_recall`
tool pages the exact bytes back on demand. Stored history is never mutated.
Details: `docs/plan/mapping.md` §1.

**Action Fusion** — adds an optional `thenRun: {command, timeout}` to the
edit/write tool schema; after a successful edit the follow-up command runs in
the *same* tool call and the model gets one tagged combined observation
(`[then_run:succeeded|failed|skipped]`). A per-file sha256 guard skips on
concurrent change; optional `allowList` regexes gate commands. Fused commands
bypass the bash tool's permission flow — keep the allowList in hostile repos.
Details: `docs/plan/mapping.md` §2.

**Online Context Compact** — watches the built-in todo list; a step
transitioning to *completed* is a compaction boundary candidate. Whether to
compact is an economics decision (requests-per-boundary history, window
headroom, cache-write/read ratio 12.5, minimum spacing). Triggered at
quiescent points via the native compaction API; the plan snapshot is injected
into the compaction prompt. If the model never uses todos, it never fires.
Details: `docs/plan/mapping.md` §3.

**Evidence-Preserving Reducer** — long diagnostic logs (build/test output)
are reduced by a one-shot cheaper-model call into a receipt whose every
evidence quote is verified byte-for-byte against the archived log (schema,
source sha256, status, secret gates). Only a fully valid receipt replaces the
log; the original stays available on disk. Marker: `sol_pi_evidence_receipt_v1`.
Details: `docs/plan/mapping.md` §4.

## Version notes

- 1.x wiring: `src/v1/*` (hooks object). 2.x wiring: `src/v2/*`
  (`ctx.tool.hook/transform`, `ctx.session.hook("context"/"compaction")`,
  `ctx.storage`, `ctx.event.subscribe`, `ctx.generate.text`).
- 2.x deviations from the docs (followed the real `@opencode/plugin` 2.0.26
  types): `generate.text` model ref is `{id, providerID}`; there is no
  `todo.updated` event (plan boundaries come from the todo tool's
  `execute.after`); `Message.content` is readonly, so projection replaces the
  message entry copy-on-write.

## Development

```bash
npm run typecheck   # tsc against real @opencode-ai/plugin 1.19 + @opencode/plugin 2.0.26 types
npm test            # node --test + tsx; pure-logic + wiring tests (no live opencode needed)
```
