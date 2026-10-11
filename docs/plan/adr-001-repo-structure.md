# ADR-001: Repo structure — one repo, one branch, one package

## Status

Accepted (2026-10-11). Decided by orchestrator; encoded here.

## Context

We port SoL-Pi's four token-efficiency mechanisms (see `docs/research/sol-pi.md`)
to opencode as a plugin named **sol-pi-opencode**. opencode has two incompatible
plugin APIs:

- **1.x** (`@opencode-ai/plugin` 1.19.0): exported function `(input, options) => Hooks`,
  string-keyed hooks. **PRIORITY target.**
- **2.x** (`@opencode/plugin` 2.0.x): `Plugin.define({id, setup(ctx)})`, domain hooks.
  V1 code does not run in V2 (official migrate-v1 guide).

opencode officially documents a **dual-entry pattern**: one default export
carrying both a V1 `server()` function and a V2 `Plugin.define(...).setup()`
(see `docs/research/opencode-extensions.md` § "Strategy to Support Both Versions").
Constraint: **V1 object entrypoints require opencode-ai ≥ 1.18.29.**

## Decision

Ship **ONE repository, ONE branch, ONE npm package** containing:

1. A **version-agnostic core** (`src/core/`): pure TypeScript logic — thresholds,
   economics math, receipt validation, archive naming, placeholder construction,
   send-count ledger — with zero imports from either plugin package.
2. **Thin per-version adapters** (`src/v1/`, `src/v2/`): each adapter only maps
   core functions onto that version's hook surface, plus the dual-entry
   composition at the package root.

## Consequences

**Positive**
- Research, design docs, tests for pure logic, and the four mechanism specs exist once.
- Cross-version fixes (e.g. a better placeholder, an economics constant) land in one commit.
- One version number, one changelog, one install story (`plugin` key in 1.x, `plugins` in 2.x).

**Negative / accepted costs**
- **Dual API surface maintenance:** every behavior is mapped twice (V1 hook object ↔ V2
  domain hooks). Adapter drift is a real risk; mitigated by keeping adapters < ~150 lines
  each and unit-testing the core, not the adapters.
- **V1 object entrypoint needs opencode-ai ≥ 1.18.29.** Users on older 1.x cannot load the
  dual-entry object form. **Legacy fallback note:** document that pre-1.18.29 users must
  either upgrade opencode or use a legacy function-export entrypoint
  (`export const SolPiPlugin: Plugin = ...` as a *named function export* kept alongside the
  default object export); we do not promise CI coverage for < 1.18.29.
- Both plugin packages become devDependencies (`@opencode-ai/plugin`, `@opencode/plugin`);
  type-checking must tolerate both.
- 2.x is moving fast (no npm `opencode-ai@2.x` yet; GitHub tags v2.0.x only) — the V2
  adapter may churn. Isolation in `src/v2/` bounds the blast radius.

## Alternatives considered

- **Two repos (sol-pi-opencode-v1 / -v2):** rejected — research, design docs, and the
  pure core (thresholds, economics, receipt verifier) would be duplicated or
  submodule-juggled; every core fix needs a cross-repo sync.
- **Two branches in one repo:** rejected — same duplication of shared docs/core across
  branches, and cross-version fixes fork immediately (cherry-pick drift, divergent
  constants).
- **V1-only for now:** rejected — 2.x is the announced direction; the official dual-entry
  pattern makes coexistence cheap, and deferring V2 would re-open this decision later.
