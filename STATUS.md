# STATUS — sol-pi-opencode

Living tracker. Last updated: 2026-10-11.

## Goal

opencode plugin porting SoL-Pi's 4 token-efficiency mechanisms. opencode 1.x
priority; 2.x via official dual-entry pattern. One repo / one branch / one
package (ADR-001).

## Phases

| Phase | Scope | Status |
|---|---|---|
| P0 | Scaffold: dual entry, config loader, core interfaces | not started |
| P1 | ObservationPack v1 + pure-logic tests | not started |
| P2 | Action Fusion v1 + tests | not started |
| P3 | Online Context Compact v1 | not started |
| P4 | Evidence-Preserving Reducer v1 | not started |
| P5 | v2 adapters for shipped mechanisms | not started |
| P6 | Measurement / validation | not started |

Priority order: ObservationPack → Action Fusion → OCC → Reducer (rationale in
`docs/plan/mapping.md`).

## Key facts

- SoL-Pi mechanisms, constants, numbers: `docs/research/sol-pi.md`
  (10 KiB threshold, 2 full sends, sha256 guard, cacheWriteReadRatio 12.5,
  ObservationPack A/B −23.58% bill).
- opencode 1.x/2.x hook surface + breaking changes + dual-entry:
  `docs/research/opencode-extensions.md` (V1 object entrypoint needs
  opencode-ai ≥ 1.18.29).
- Repo decision + consequences: `docs/plan/adr-001-repo-structure.md`.
- Per-mechanism hook mapping, feasibility, resolved questions (a)–(d):
  `docs/plan/mapping.md`.
- Phases + done-criteria: `docs/plan/roadmap.md`.
- Resolved during planning: 1.x compaction trigger = SDK
  `client.session.summarize`; 1.x archives under XDG cache keyed by sessionID;
  1.x reducer one-shot call = throwaway session + hidden no-tools agent
  (P4 spike confirms).

## Invariants (non-negotiable)

Opt-in default-off (`sol-pi.json`); fail-open; never mutate stored history
(project only); exact local archives; deterministic verification.
