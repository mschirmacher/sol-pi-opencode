# STATUS — sol-pi-opencode

Living tracker. Last updated: 2026-10-12.

## Goal

opencode plugin porting SoL-Pi's 4 token-efficiency mechanisms; 1.x priority,
2.x via official dual-entry pattern; one repo/branch/package (ADR-001).

## Phases

| Phase | Scope | Status |
|---|---|---|
| P0 | Scaffold: dual entry, config loader, core interfaces | done |
| P1 | ObservationPack v1 + pure-logic tests | done (v1.19.0 source spike resolved Q1–Q5, see docs/research/opencode-v1-internals.md) |
| P2 | Action Fusion v1 + tests | done (code+tests); runtime E2E needs user env with real opencode + API key |
| P3 | Online Context Compact v1 | done (code+tests); runtime E2E needs real opencode + API key |
| P4 | Evidence-Preserving Reducer v1 | done (code+tests); runtime E2E needs real opencode + API key |
| P5 | v2 adapters for shipped mechanisms | done (code+tests, @opencode/plugin 2.0.26 types; runtime E2E needs real opencode 2.x) |
| P6 | Measurement / validation | done (baseline + E2E 4/4 PASS + A/B: 10 paired + 3 op-only runs, cost-0 proxy; all mechanisms stay default-off) |
| P6d | Long-session A/B suite (tasks-long + firing counters) | partial (10/18 runs; driver stopped; evaluation in report) |

## Key facts

- SoL-Pi mechanisms/constants/numbers: `docs/research/sol-pi.md` (10 KiB threshold,
  2 full sends, sha256 guard, cacheWriteReadRatio 12.5, ObservationPack −23.58% bill).
- P6 baseline (`scripts/measure.mjs`, 16 orchestration sessions, cost=0 → tokens only): adjacency 26.4% / eligible 10.2%, bash 26.6% post-edit; ObservationPack replay ≈1.95M tok (11.1% of billed); OCC compaction 0 — `docs/plan/measurement-report.md`.
- P6b E2E: all 4 mechanisms fire end-to-end on real opencode 1.19.0 + mock provider; no plugin bugs (`docs/plan/spike-p6-e2e.md`).
- P6c A/B (`scripts/ab/`, results in `docs/plan/ab-results/`): 5 small tasks ×
  off/on (+3 op-only, 1 timeout): ON = +10.9% tokens vs OFF, score 5/5 both,
  replayTokens=0 everywhere → no mechanism fired; SoL-Pi −44.7–49.0% NOT
  reproduced at this scale; all mechanisms NO-GO for default-on.
- 1.x/2.x hook surface + breaking changes + dual-entry: `docs/research/opencode-extensions.md` (V1 object entrypoint needs opencode-ai ≥ 1.18.29). Repo decision: `docs/plan/adr-001-repo-structure.md`; per-mechanism mapping + questions (a)–(d): `docs/plan/mapping.md`; phases: `docs/plan/roadmap.md`.
- P2 verified against v1.19.0 source: built-in arg decode strips excess keys; after-hook output rewrite reaches model AND storage (mapping.md addendum).
- P3 boundary signal: 1.x `todo.updated` events (built-in todo tool) are the
  completed-step signal; `session.idle` is only the quiescent firing point.
  1.x compaction trigger = SDK `client.session.summarize`; archives under
  XDG cache keyed by sessionID.
  LIMITATION: no todos → OCC never fires (src/v1/online-context-compact.ts).
- P5 (v2 adapters, src/v2/*): all four mechanisms wired against real
  @opencode/plugin 2.0.26 promise types. Deviations found vs docs:
  `generate.text` model ref is `{id, providerID, variant?}` (not
  `{providerID, modelID}`); no `todo.updated` event — plan boundaries observed
  on the todo tool's `execute.after`; `Message.content` is readonly →
  projection replaces the message entry copy-on-write; `execute.before`
  `event.input` IS mutable (thenRun strip works as sketched); built-in tool
  `input` may be an Effect Schema — thenRun JSON-Schema extension applies
  only when it is a plain JSON Schema (else guidance-only). OCC window size
  not resolved in v2 (economics use the request-based bound).
- P4 spike (v1.19.0, throwaway-session model call): CONFIRMED.
  `session.create` → `session.prompt({agent, model, parts})` blocks and returns
  the last assistant WithParts → `session.delete`. Hidden no-tools agent
  `sol-pi-reducer` registered on the live config object via the `config` hook.
  Gaps: no server-side prompt timeout (bounded client-side); missing agent/model →
  fail-open. Receipt marker `sol_pi_evidence_receipt_v1` already excluded by ObservationPack.

## Invariants (non-negotiable)

Opt-in default-off (`sol-pi.json`); fail-open; never mutate stored history
(project only); exact local archives; deterministic verification.
