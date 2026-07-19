# Readiness Torture Validation & Documentation Design

**Date:** 2026-07-19
**Status:** Approved design — awaiting spec review
**Repos:** crisismode-torture (two scenarios) + crisismode (one doc)
**Depends on:** readiness + capacity ceilings as merged (PRs #74/#75)

## Problem

`crisismode readiness` shipped with unit-level verification only. The project's
credibility standard is that capability claims are validated by the torture
harness against real infrastructure — readiness has no such validation yet,
and no documentation exists beyond one-line README/CLAUDE.md mentions.
Deliverables: two torture scenarios (detection + honesty) and one
comprehensive doc (usage + extension).

## Scope decisions (settled during brainstorm)

- **Coverage:** detection AND honesty — two scenarios. The serverless-pooling
  heuristic, redis-ceiling assertions, and a max_connections-tuned "blocking"
  case are explicitly deferred (full-sweep option declined).
- **Scenario architecture:** two self-contained scenarios on the shared
  compose PG stack, standard `Scenario` contract, registered in
  `scenarios/index.ts` (roster 18 → 20). No harness changes —
  `crisismodeCli(['readiness'])` already exists and appends `--json`.
- **Documentation:** one comprehensive `docs/readiness.md` in crisismode with
  an Extending section; README/CLAUDE.md link to it.

## Scenario 1: `readiness-at-risk` (crisismode-torture)

Proves detection with a built-in false-alarm guard.

**Setup:** shared compose PG stack via existing infra helpers; scenario config
(or `DATABASE_URL` env) pointing readiness at the compose primary — mirror
how `pg-connection-exhaustion` wires its target.

**Baseline phase (false-alarm guard):** run `crisismodeCli(['readiness'])`,
parse the JSONL record with `type: 'readiness'`, assert:
- verdict `ready`
- zero `at_risk` or `blocking` findings
- `unknown` findings are PERMITTED (e.g. slow-queries without
  pg_stat_statements) — unknowns never affect the verdict; a baseline that
  demanded zero unknowns would contradict the honesty contract.

**Inject — three real conditions on the compose primary:**
1. Idle-in-transaction session FIRST (so it ages past the 60s threshold
   while the rest of injection proceeds — no dead sleep): a detached psql
   holding `BEGIN;` open.
2. ~70 idle connections held open (the flood technique from
   `pg-connection-exhaustion`) → 70% of the stock max_connections=100,
   above the 60% at-risk boundary, below the 80% blocking boundary.
3. Unindexed table: `CREATE TABLE`, `generate_series` ≥ 20k rows, `ANALYZE`
   (so `n_live_tup` is fresh), then ≥ 12 full-scan queries with a
   non-indexed `WHERE` → seq_scan ≫ idx_scan on a ≥10k-row table.

**Verify:** run readiness again; assert on the parsed `readiness` record:
- verdict `at-risk` (not `not-ready` — nothing injected crosses a blocking
  threshold)
- findings include `connection-headroom`, `missing-index`, and
  `long-transactions`, each with status `at_risk` and non-empty evidence
- ceilings include `db-connections` with `max_connections = 100` in its
  evidence and the string `declared` in its labeling
- internal consistency: `evaluated` + `unknown` counts match the findings
  array.

**Teardown:** terminate injected sessions (`pg_terminate_backend`), drop the
table, standard compose cleanup. Teardown must succeed even if inject
partially failed.

**Timing note:** verify runs ≥ 60s after the idle transaction opened; the
connection flood and table work naturally consume part of that window — any
remainder is an explicit bounded wait, logged.

## Scenario 2: `readiness-honest-limits` (crisismode-torture)

Proves the never-fabricate contract under two degradations.

**Phase A — unreachable database:** `containerStop` the PG primary; run
readiness; assert:
- exit code 0 (an honest report is not a crash)
- verdict `unknown`
- a can't-assess finding whose `reason` is non-empty (carries the real
  connection error)
- no `ceilings` with fabricated values — either the ceilings fields are
  absent or every entry traces to real data (with the DB down, expect
  absent/omitted)
Then `containerStart` and wait healthy before Phase B.

**Phase B — missing extension (live DB, stock image, no
pg_stat_statements):** run readiness; assert:
- the `slow-queries` finding has status `unknown` with a `reason` that
  names `pg_stat_statements` and how to enable it
- `db-throughput` appears in `ceilingsOmitted` (reason present), never as a
  numeric ceiling
- the report still delivers real findings/ceilings for what IS measurable
  (e.g. `db-connections` present).

**Teardown:** ensure the container is running; standard cleanup.

## Registration & torture docs

Both scenarios registered in `scenarios/index.ts`; torture README's scenario
listing updated (core-scenario group + count). Scenario ids:
`readiness-at-risk`, `readiness-honest-limits`. Neither is AWS/Vercel-gated.

## Documentation: `docs/readiness.md` (crisismode)

Single doc, structure and tone matching `docs/architecture.md`. Sections:

1. **What readiness is** — will-it-break-under-load vs scan's is-it-broken;
   read-only, suggest escalation level at most.
2. **Quick start** — `crisismode readiness`, `--json` (JSONL record type
   `readiness`), and the `crisismode_readiness` MCP tool.
3. **The six rules** — table: rule id, threshold (exact values and
   inclusivity), status semantics, plain-English meaning, fix guidance.
   Serverless-pooling explicitly labeled a heuristic.
4. **Capacity ceilings** — the three evidence classes (`declared`,
   `measured`, `typical`) and what each label promises; per-ceiling table
   (source, unit); maxmemory=0-is-unlimited; Little's law derivation for
   db-throughput with the ~80%-practical-wall caveat.
5. **Weak-link verdict** — why every req/s figure is conditional, the
   {1, 3, 10} fan-out set, typical-class exclusion, constraint migration.
6. **Configuration** — `network.egressMbps` (declared-only, never measured),
   `DATABASE_URL`/target resolution, redis target for redis ceilings.
7. **The honesty contract** — unknown never scored; omit-never-fabricate;
   ceilings never move the score; failures degrade the report's coverage,
   never its delivery.
8. **Extending** — adding a rule: `ReadinessRule` interface, register in
   `src/readiness/rules/index.ts`, the exact-boundary-test convention, the
   unknown+reason requirement; adding a ceiling: `computeCeilings`,
   evidence-class labeling, omit-with-reason. Code snippets copied from
   real source, not invented.
9. **Validation** — pointer to the two torture scenarios and what a pass
   proves (and doesn't).

**Freshness rule (binding):** every claim in the doc is written against
current source, and thresholds/ids quoted from the constants — no
from-memory numbers.

**Link updates:** README's readiness CLI-reference comment and MCP row gain
a "see docs/readiness.md" pointer; CLAUDE.md Key Files gains the doc row.

## Error handling

Scenario asserts use the same JSONL parsing style as sibling scenarios; a
missing `readiness` record is a scenario FAIL with the raw stdout captured
in the report. Teardown is unconditional (finally-style) in both scenarios.

## Testing / acceptance

- `pnpm typecheck` clean in crisismode-torture; both scenarios PASS via
  `pnpm scenario readiness-at-risk` and `pnpm scenario readiness-honest-limits`
  against the sibling-built crisismode CLI, reports saved under `reports/`.
- Baseline false-alarm guard passing is part of the at-risk scenario's PASS.
- crisismode side is docs-only: no runtime change, no eval-gate re-run;
  docs claims spot-checked against source during review.

## Out of scope

Serverless-pooling/vercel-signal scenario, redis-ceiling torture assertions,
a max_connections-tuned blocking-verdict case, pg_stat_statements-enabled
compose variant (would allow slow-queries/db-throughput positive-path torture
coverage — worthwhile follow-up), execute-mode anything (readiness is
read-only), separate contributor tutorial for rules.
