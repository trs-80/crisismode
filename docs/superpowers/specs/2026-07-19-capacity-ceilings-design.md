# Capacity Ceilings & Weak-Link Analysis Design

**Date:** 2026-07-19
**Status:** Draft — follow-up to `2026-07-18-scale-readiness-design.md` (PR #74)
**Depends on:** the `src/readiness/` module (rules, sources, report) shipped by that PR

## Problem

The scale-readiness report says whether individual components are misconfigured
for load, but not *which part of the stack gives out first* or *at roughly what
throughput*. Absolute capacity ("your app handles X req/s") is unknowable
without generating load — any tool that prints that number from static
inspection is guessing. But a large subset of capacity is declared in config
and plan documents, and Little's law turns declared concurrency plus measured
latency into honest **upper bounds**. The deliverable is a ranked weak-link
verdict built only from facts we can cite.

## Core honesty rules (binding, in priority order)

1. **Ceilings, never predictions.** Every number is an "at most," derived from
   a named source. Real capacity is lower; the report says so, always.
2. **Three evidence classes, always labeled:**
   - `declared` — read from config/API (`max_connections`, pool size,
     `maxmemory`, partition count, fd limit, provisioned IOPS, plan
     concurrency, instance network baseline)
   - `measured` — observed by us (mean query time from `pg_stat_statements`,
     average response size)
   - `typical` — published rules-of-thumb (Node event-loop throughput, Redis
     ops/s). Presented only as a cited range, never as this system's number.
3. **Conversions require measured fan-outs.** Translating a ceiling into
   requests/sec needs a fan-out factor (queries per request, bytes per
   response). If the factor is measured, the conversion is stated as fact-
   derived; if not, the conversion is **conditional** and rendered as such:
   "if each request runs ~3 queries, connections bind first at ~170 req/s."
   Never silently assume a fan-out.
4. **W inflates under load.** Every Little-derived ceiling carries the caveat
   that residence time grows with utilization, so the bound is optimistic and
   systems degrade well before it (~80% is the practical wall).
5. **Constraint migration.** The verdict names the *first* bottleneck and
   states that fixing it promotes the next one.

## Little's law usage

For any resource with concurrency limit `C` and mean residence time `W`:
`λ_max = C / W`. Exact in steady state, distribution-free. Applied to:

- **Database:** `max_connections` (or pool size if smaller — the binding one
  is reported) × mean query time → queries/sec ceiling
- **Workers/serverless:** concurrency limit × mean invocation time →
  invocations/sec ceiling (only when both inputs are declared/measured)

When `W` is unavailable (no `pg_stat_statements`), the ceiling is reported in
native units only (`C` concurrent queries) — same `unknown`-not-guessed
contract as the readiness rules.

## Ceiling inventory (v1 of this feature)

| Ceiling | Class | Source | Unit |
|---|---|---|---|
| DB concurrent queries | declared | `max_connections` vs pool max — min is binding | connections |
| DB throughput | declared×measured | Little: binding connections ÷ mean query ms | queries/s |
| Redis memory | declared | `CONFIG GET maxmemory` + current usage | bytes, % used |
| Redis clients | declared | `CONFIG GET maxclients` | connections |
| File descriptors | declared | local `ulimit -n`; reported only when the app runs on this host (suppressed for serverless platforms, where it is not the app's limit) | sockets |
| Network egress | declared×measured | declared link/instance baseline (config/user-supplied) ÷ measured mean response bytes | responses/s |
| Node single-instance | typical | cited range only, shown when Node app detected | req/s range |

Network link speed is included **only** when declared (crisismode.yaml field
`network.egressMbps`, or a future cloud-instance-metadata probe) — never
measured from the operator's machine, which says nothing about prod egress.

## Weak-link verdict

1. Compute each available ceiling with its evidence class.
2. Convert to requests/sec where a measured fan-out exists; otherwise keep
   native units and produce conditional conversions for the default fan-out
   set {1, 3, 10} queries/request (rendered as a table, labeled conditional).
3. Rank the commensurable ceilings; the minimum is the weak link. Ordinal
   confidence beats numeric precision: the verdict sentence is "your first
   bottleneck under load is X," with the number as supporting evidence.
4. `typical`-class ceilings never determine the verdict; they render as
   context beneath it.

## Architecture

Extends `src/readiness/` — no new module:

- `src/readiness/ceilings.ts` — `CapacityCeiling { id, value, unit,
  evidenceClass: 'declared' | 'measured' | 'typical', source, littleInputs? }`
  and `computeCeilings(sources, ctx): Promise<CapacityCeiling[]>`
- `src/readiness/weak-link.ts` — pure `rankWeakLink(ceilings, fanouts):
  WeakLinkVerdict` (conditional table when fan-outs unmeasured)
- `ReadinessSources` gains the extra probes (redis config, ulimit, declared
  network) following the existing optional-method + null-on-unavailable
  pattern; each lands in the same pg/redis live clients that own those
  connections today
- Report/CLI/MCP: a "Capacity ceilings" section appended to the existing
  readiness report — ceilings do NOT affect the readiness score or verdict
  (they are context, not findings); the weak-link sentence renders beneath
  the verdict line. The `crisismode_readiness` MCP tool returns them in a
  `ceilings` field. Still read-only end to end.

## Error handling

Identical contract to readiness rules: unavailable probe ⇒ that ceiling is
omitted and listed under "could not assess: <reason>"; no ceiling is ever
fabricated; a report with zero computable ceilings says exactly that.

## Testing

- Unit: `computeCeilings` per-probe (declared present/absent), Little
  arithmetic with exact-boundary cases per branch convention, `rankWeakLink`
  ordering incl. conditional-fanout table and typical-class exclusion
- Simulator fixtures for the new probe methods
- Renderer tests: evidence-class labels always present; conditional
  conversions never rendered as unconditional
- Eval gate unaffected (no diagnosis-path changes) — verify by grep, as PR #74
  did for attributions

## Out of scope

Kafka partition-vs-consumer parallelism ceiling — a real declared ceiling, but
the repo has no live Kafka client to read topic metadata from (simulator
only); deferred until one exists rather than shipping a probe that always
reports "could not assess."
Load generation / empirical capacity measurement (torture-harness territory);
speed-testing the operator's machine; cloud-provider API probes for instance
network baselines (future, behind the same declared-only rule); USL
contention/coherence modeling; any influence of ceilings on the readiness
score.
