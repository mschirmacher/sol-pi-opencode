# Roadmap — sol-pi-opencode

Phases are sequential; P5 may overlap P2+. All done-criteria include
`tsc --noEmit` clean (both plugin packages as devDeps) and unit tests passing
for the touched core modules. No phase ships a mechanism default-on.

## P0 — Scaffold (package + dual entry + config + core interfaces)

**Files:** `package.json` (name `sol-pi-opencode`, exports), `src/index.ts`
(dual entry: default export with V1 `server()` + V2 `Plugin.define.setup()`;
named function export kept as pre-1.18.29 legacy fallback — see ADR-001),
`src/config.ts` (`sol-pi.json` loader, search order, defaults-off),
`src/core/types.ts` (mechanism interfaces, ledger/archive contracts),
`tsconfig.json`, `test/config.test.ts`, `README` install section.

**Done:** loads as `.opencode/plugins/` local plugin on 1.19.0 (manual smoke:
log line via `client.app.log`); V2 `setup()` signature type-checks against
`@opencode/plugin`; config loader unit tests (defaults off, no merge, both
paths); `tsc --noEmit` clean.

**Risks:** dual-entry shape on early 1.18.x; both plugin packages' types
conflicting in one tsconfig (mitigate: separate `typesVersions`/paths if needed).

## P1 — ObservationPack (v1) + core unit tests

**Files:** `src/core/observation-pack/{thresholds,archive,placeholder,ledger}.ts`,
`src/v1/observation-pack.ts` (`tool.execute.after` archive,
`experimental.chat.messages.transform` projection, `tool` map recall tool),
`test/observation-pack/*.test.ts`, spike note `docs/plan/spike-p1.md`.

**Done:** unit tests for pure logic (threshold 10 KiB, FULL_SENDS=2 send
counting, placeholder byte-stability, excerpt split, fail-open); archives are
byte-exact round-trip; recall tool returns exact pages by offset; manual smoke:
a >10 KiB tool output appears full twice, then placeholder, recall works;
stored session history verified unchanged (spike result documented).

**Risks:** 1.x may pre-truncate `output.output` (spike measures ceiling);
transform may hand live references (copy-on-write fallback).

## P2 — Action Fusion (v1) + tests

**Files:** `src/core/action-fusion/{schema,queue,hash-guard,tags}.ts`,
`src/v1/action-fusion.ts` (`tool.definition`, `tool.execute.before/after`),
`test/action-fusion/*.test.ts`.

**Done:** unit tests (per-file mutex ordering, sha256 skip →
`[then_run:skipped]`, tag formats, command timeout); manual smoke: edit with
`thenRun` yields one combined observation tagged `[then_run:succeeded]`;
concurrent-edit skip verified; permission allow-list enforced.

**Risks:** after-hook rewrite not atomic w.r.t. persistence/streaming (verify);
fused commands bypassing bash permissions (allow-list default).

## P3 — Online Context Compact (v1)

**Files:** `src/core/occ/{plan,economics,state}.ts`, `src/v1/occ.ts`
(todo read via `client.session.todo`, `client.session.summarize` trigger,
`experimental.session.compacting`, `experimental.compaction.autocontinue`,
`session.compacted`/`session.idle` events), `test/occ/*.test.ts`,
`docs/plan/spike-p3.md`.

**Done:** economics unit tests (break-even, stddev lower bound,
`cacheWriteReadRatio 12.5`, ≥2-request gate, `subsequentCompactionMargin 1.5`,
`windowReserveTokens 16_384`); manual smoke: completed todo boundary at an
economically-YES point triggers summarize, autocontinue resumes, no double
compaction under pressure (re-entrancy guard); token-estimation approach
documented in spike note.

**Risks:** mid-turn `summarize` races; `compacting` hook not honored by
`summarize` path; no `getContextUsage()` equivalent (estimate from parts).

## P4 — Evidence-Preserving Reducer (v1)

**Files:** `src/core/reducer/{candidate,archive,receipt,prompt}.ts`,
`src/v1/reducer.ts` (eligibility in `tool.execute.after`, throwaway-session
model call, hidden `sol-pi-reducer` agent config), `test/reducer/*.test.ts`,
`docs/plan/spike-p4.md` (throwaway-session vs direct-provider decision).

**Done:** receipt unit tests (schema, `source_sha256`, status match, quote
`includes` byte-exact, max items/chars, fail-open on every failure mode,
secret gate); manual smoke: long build log → verified receipt replaces output,
receipt excluded from ObservationPack re-packing; throwaway session deleted.

**Risks:** throwaway-session latency/fragility; provider auth for direct-call
fallback; deferred decision allowed (keep default-off).

## P5 — v2 adapters for shipped mechanisms

**Files:** `src/v2/{observation-pack,action-fusion,occ,reducer}.ts` wired in
`setup()` (`session.hook("context"/"compaction")`,
`tool.hook("execute.before/after")`, `tool.transform`,
`ctx.tool.transform` recall tool, `ctx.storage` ledger,
`ctx.session.compact`, `ctx.generate.text`), `test/v2-adapter/*.test.ts`
(shape/registration tests).

**Done:** each mechanism registered on 2.x (manual smoke on a v2.0.x build);
core modules unchanged (adapters only); `tsc --noEmit` clean with
`@opencode/plugin`.

**Risks:** 2.x API churn (no npm 2.x CLI; pin a GitHub tag); no 1:1 for
`autocontinue`/`small_model` equivalents.

## P6 — Measurement / validation

**Files:** `scripts/measure.mjs` (session-log mining: edit→run adjacency rate,
large-output replay bytes, compaction timing), `docs/plan/measurement-report.md`.

**Done:** headroom numbers per mechanism on ≥5 real long sessions with
mechanisms on vs off (bill + tokens + response counts, SoL-Pi A/B style);
report compares against SoL-Pi's reported deltas; go/no-go per mechanism for
default-on discussion.

**Risks:** small-n noise; provider pricing variance (use list prices, same
model, paired runs).
