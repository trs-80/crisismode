# Scale Readiness

`crisismode readiness` answers a different question than a health scan. A scan asks *"is this broken right now?"* — readiness asks *"will this break under load?"*. It is forward-looking: it inspects the stack you have (connection limits, indexes, query latency, pooling) and reports where growth will hit a wall before traffic arrives to prove it.

Readiness is strictly read-only. It observes, explains, and recommends — it never mutates anything. On the five-level escalation model it suggests at most: the report can recommend a fix, but executing one is always a separate, human-initiated step.

## Quick Start

```bash
crisismode readiness          # human-readable report
crisismode readiness --json   # one JSONL record for machines
```

With `--json`, the command emits a single JSON line of `type: "readiness"` with the report fields spread at the top level (no sub-key):

```bash
crisismode readiness --json | jq 'select(.type == "readiness") | .verdict'
```

A trimmed real record (run against a stock PostgreSQL 16 with no `pg_stat_statements`; two of five findings and one of two ceilings shown):

```json
{
  "type": "readiness",
  "verdict": "ready",
  "score": 100,
  "evaluated": 4,
  "unknown": 1,
  "findings": [
    {
      "ruleId": "connection-headroom",
      "title": "Database connection headroom",
      "status": "ready",
      "headroom": 0.94,
      "evidence": ["6 of 100 connections in use (6%)"],
      "explanation": "PostgreSQL allows a fixed number of simultaneous connections (max_connections). When they run out, new requests fail immediately — this is the most common way growing apps fall over.",
      "fix": "Add a connection pooler (pgbouncer, or your provider's pooled connection string) and close connections promptly.",
      "learnMoreUrl": "https://www.postgresql.org/docs/current/runtime-config-connection.html"
    },
    {
      "ruleId": "slow-queries",
      "title": "Slow queries",
      "status": "unknown",
      "evidence": [],
      "reason": "pg_stat_statements is not available — enable it with CREATE EXTENSION pg_stat_statements (most managed providers support it)"
    }
  ],
  "ceilings": [
    {
      "id": "db-connections",
      "title": "Database concurrent queries",
      "value": 100,
      "unit": "connections",
      "evidenceClasses": ["declared"],
      "evidence": ["max_connections = 100 (declared)"],
      "caveat": "This is an upper bound (\"at most\") — latency grows with utilization, so real capacity is lower; systems degrade well before the ceiling (~80% is the practical wall)."
    }
  ],
  "ceilingsOmitted": [
    { "id": "db-throughput", "reason": "mean query time unavailable (pg_stat_statements absent or empty)" },
    { "id": "network-egress", "reason": "no declared link speed (set network.egressMbps in crisismode.yaml)" }
  ],
  "weakLink": {
    "binding": null,
    "conditional": [],
    "note": "no ceiling convertible to requests/s yet (needs a measured or declared throughput input). Fixing the first bottleneck promotes the next one — re-run after any change."
  }
}
```

The same report is available to AI agents through the MCP server (`crisismode mcp`) as the `crisismode_readiness` tool, annotated `readOnlyHint: true` like every tool on the MCP surface.

## The Six Rules

Six rules live in `src/readiness/rules/`. Each returns one finding with a status, raw evidence, a plain-English explanation, and a concrete fix.

| Rule | Threshold (exact) | Statuses | Meaning | Fix guidance (the rule's own words) |
|---|---|---|---|---|
| `connection-headroom` | usage ≥ 60% of `max_connections` → `at_risk`; ≥ 80% → `blocking` | `ready`, `at_risk`, `blocking`, `unknown` | When connections run out, new requests fail immediately — the most common way growing apps fall over | "Add a connection pooler (pgbouncer, or your provider's pooled connection string) and close connections promptly." |
| `connection-limit-tier` | `max_connections` ≤ 25 → `at_risk` | `ready`, `at_risk`, `unknown` | A free/starter-tier-sized limit leaves little room for growth — every serverless instance and background job consumes one | "Plan a tier upgrade or add pooling before launch traffic arrives." |
| `long-transactions` | idle-in-transaction age ≥ 60s → `at_risk` (never `blocking`) | `ready`, `at_risk`, `unknown` | An open transaction holds its locks and its connection; under load these pile up and block other queries | "Find the code path that opens a transaction without committing; set idle_in_transaction_session_timeout as a backstop." |
| `missing-index` | table rows ≥ 10,000 AND seq scans > max(1, index scans) × 10 → `at_risk` | `ready`, `at_risk`, `unknown` | Without an index every query reads the whole table — fine at 1k rows, an outage at 1M; cost grows with data even if traffic stays flat | "Add an index on the columns these queries filter or join on (check with EXPLAIN)." |
| `slow-queries` | mean execution ≥ 250ms → `at_risk`; without `pg_stat_statements` → `unknown` | `ready`, `at_risk`, `unknown` | A slow query occupies a connection the whole time; under concurrency slow queries multiply into pool exhaustion and timeouts | "EXPLAIN the listed queries; usually the fix is an index or fetching fewer rows." |
| `serverless-pooling` | **heuristic** — only applicable when a serverless platform is detected; non-5432 port → `ready` (pooled endpoint likely); direct port 5432 with `max_connections` ≤ 25 → `blocking`, otherwise `at_risk` | `ready`, `at_risk`, `blocking`, `unknown` | Each serverless invocation opens its own connection, so traffic spikes translate directly into connection spikes; the rule infers pooling from the connection port and limit size — its own explanation labels it a heuristic | "Use your provider's pooled connection string (or add pgbouncer) for serverless functions." |

Rules that are not applicable to the detected stack are skipped entirely — a non-serverless deployment produces no `serverless-pooling` finding at all, not a `ready` one.

Note the spelling split: finding statuses are underscored (`at_risk`), while the report verdict is hyphenated (`at-risk`). They are different fields with different vocabularies.

### Verdict and Score

The verdict is computed from the known (non-`unknown`) findings:

- any `blocking` finding → `not-ready`
- otherwise any `at_risk` finding → `at-risk`
- no known findings at all → `unknown`
- otherwise → `ready`

The score starts at 100 and subtracts 30 per `blocking` finding and 10 per `at_risk` finding, floored at 0. `unknown` findings never move the score or the verdict — see [The Honesty Contract](#the-honesty-contract).

## Capacity Ceilings

Alongside the findings, the report computes **capacity ceilings**: honest per-component upper bounds. Ceilings are report *context* — they never affect the score or the verdict.

Every ceiling labels the class of evidence behind each input:

- **`declared`** — a configured limit read from the system (`max_connections`, `maxmemory`, a ulimit). It promises the limit exists, not that you can reach it.
- **`measured`** — observed data from the running system (mean query time, current memory use).
- **`typical`** — a published ballpark for the class of system, not a measurement of *this* system. Typical-class ceilings never participate in the weak-link verdict.

| Ceiling id | Source | Unit |
|---|---|---|
| `db-connections` | `max_connections` (declared) | connections |
| `db-throughput` | `max_connections` (declared) + mean query time from `pg_stat_statements` (measured) | queries/s |
| `redis-memory` | `maxmemory` (declared) + `used_memory` (measured) | bytes |
| `redis-clients` | `maxclients` (declared) + `connected_clients` (measured) | connections |
| `fd-limit` | open-files soft limit on this machine (declared); suppressed on serverless platforms — the local file-descriptor limit is not the app host's limit | open sockets/files |
| `network-egress` | `network.egressMbps` from `crisismode.yaml` (declared); bytes/s = Mbps × 125,000 | bytes/s |
| `node-typical` | typical single-instance Node.js HTTP throughput for light handlers (community benchmarks), range 1,000–5,000 — emitted only when a Node framework (express, fastify, next, remix, nest) is detected | requests/s |

A ceiling that cannot be computed honestly is **omitted with a reason** in `ceilingsOmitted`, never estimated. For example, Redis with `maxmemory = 0` yields the omission reason `maxmemory = 0 (unlimited) — bounded by host memory, not a declared limit` — an unlimited setting is not a declared ceiling, so no number is invented for it.

### Little's Law and db-throughput

`db-throughput` is derived from Little's law, `λ_max = C / W`: with `C = max_connections` concurrent slots and a mean query residence time of `W` seconds, the database can serve at most `max_connections × 1000 / mean_ms` queries per second. This needs a measured mean, so without `pg_stat_statements` the ceiling is omitted with the reason `mean query time unavailable (pg_stat_statements absent or empty)`.

Every Little-derived bound carries the same caveat, verbatim from the source:

> This is an upper bound ("at most") — latency grows with utilization, so real capacity is lower; systems degrade well before the ceiling (~80% is the practical wall).

## The Weak-Link Verdict

Ceilings are per-component; what you usually want to know is *which one binds first in requests per second*. The catch: converting queries/s to requests/s requires knowing how many queries one request issues, and readiness does not measure fan-out. So every req/s figure is **conditional** on an assumed queries-per-request.

The weak-link ranking evaluates the assumption set `{1, 3, 10}` queries per request. For each assumption it converts every convertible ceiling (unit `queries/s`, a concrete value, and not `typical`-class) and reports which ceiling binds. The top-level `binding` field is only set when the *same* ceiling binds across all three assumptions; if the answer depends on the assumption, `binding` is `null` and you read the per-assumption list instead.

The verdict always carries this note, because a bottleneck is a moving target:

> Fixing the first bottleneck promotes the next one — re-run after any change.

## Configuration

Target resolution is **environment-hint based**. Readiness picks its PostgreSQL target from the standard connection env vars:

- `DATABASE_URL`, `POSTGRES_URL`, `PG_CONNECTION_STRING`, `PGHOST` → PostgreSQL
- `REDIS_URL`, `REDIS_TLS_URL` → Redis (used only for the Redis ceilings)

Credentials embedded in the URL are parsed into the connection. Targets defined in `crisismode.yaml` are **not** consulted by readiness — target resolution goes through stack autodiscovery's derived targets, which are built from env hints. If no PostgreSQL env hint is set, the report is a single can't-assess finding (see below), regardless of what `crisismode.yaml` contains.

One setting does come from `crisismode.yaml`: the declared egress link speed for the `network-egress` ceiling. It is declared-only — never measured — and must be a finite number greater than 0:

```yaml
network:
  egressMbps: 100
```

## The Honesty Contract

Readiness follows a strict honesty policy — the report never pretends to know more than it does:

- **Unknown is never scored.** A finding with status `unknown` carries a `reason` explaining why it could not evaluate, and moves neither the score nor the verdict. Demanding zero unknowns would invite fabrication; instead the report separates `evaluated` from `unknown` counts.
- **Omit, never fabricate.** A ceiling that cannot be computed from declared or measured inputs lands in `ceilingsOmitted` with a reason. There is no fallback to simulated data.
- **Ceilings never move the verdict.** They are context for capacity planning, not findings.
- **Failures degrade coverage, never delivery.** Each rule runs with per-rule error isolation: a rule that throws becomes an `unknown` finding with the error message as its `reason`, and the rest of the report proceeds. A failure computing ceilings drops the ceilings section, never the findings.
- **An unreachable database is a report, not a crash.** The CLI exits 0 with a single finding (`ruleId: "readiness"`, status `unknown`) whose `reason` is the raw connection error; the verdict is `unknown`, `evaluated` is 0, and no `ceilings`, `ceilingsOmitted`, or `weakLink` keys are emitted.

## Extending

### Adding a Rule

A rule implements the `ReadinessRule` interface (`src/readiness/types.ts`):

```typescript
export interface ReadinessRule {
  id: string;
  title: string;
  applicable(ctx: ReadinessContext): boolean;
  evaluate(sources: ReadinessSources, ctx: ReadinessContext): Promise<ReadinessFinding>;
}
```

`applicable` gates the rule on the discovered stack — return `false` and the rule is skipped entirely (no finding). `evaluate` reads only through the narrow `ReadinessSources` surface and returns exactly one finding.

Register the rule in `src/readiness/rules/index.ts`:

```typescript
export const allRules: ReadinessRule[] = [
  connectionHeadroomRule,
  connectionLimitTierRule,
  longTransactionsRule,
  missingIndexRule,
  slowQueriesRule,
  serverlessPoolingRule,
];
```

Two conventions are load-bearing:

1. **Exact-boundary tests.** Every threshold gets a test at the exact boundary value and one on the other side — see `src/__tests__/readiness-connection-rules.test.ts` (e.g. "at_risk at exact 25 max_connections boundary (max_connections <= 25)", "blocking at exact 80% boundary (usage >= 0.8)"). This pins the inclusivity of every comparison.
2. **Unknown requires a reason.** When a rule cannot evaluate (a source returns `null`, a probe fails), it must return status `unknown` with a non-empty `reason` — never a guessed status, and never a throw that kills the report.

### Adding a Ceiling

Ceilings are computed in `computeCeilings` (`src/readiness/ceilings.ts`). A new ceiling must:

- label every evidence line with its class — e.g. `` `max_connections = ${max} (declared)` `` — and list the classes in `evidenceClasses`;
- carry an honest caveat (Little-derived bounds reuse the shared "at most" caveat);
- when its inputs are unavailable, push an entry onto the omitted list with a reason instead of emitting a guess.

## Validation

Readiness is validated against real infrastructure by two torture scenarios in the sibling `crisismode-torture` repo, both running the CLI against a stock `postgres:16` compose stack:

- **`readiness-at-risk`** — injects three at-risk conditions (a 70%-of-max connection flood, a 20k-row table hammered by unindexed sequential scans, an idle-in-transaction session aged past 60s) and asserts the report detects all three with evidence and an `at-risk` verdict. A **false-alarm guard** is part of the pass: before injection, the same fresh stack must read `ready` with zero alarming findings.
- **`readiness-honest-limits`** — degrades the environment and asserts the honesty contract holds: with the database stopped, the CLI exits 0 with an `unknown` verdict, a can't-assess reason, and no fabricated ceilings; with the database up but `pg_stat_statements` absent, `slow-queries` is `unknown` with a reason naming the extension, `db-throughput` is omitted with a reason, and the `db-connections` ceiling is still delivered for what *is* measurable.

What a pass proves: real detection on real PostgreSQL without false alarms, and honest degradation when the environment withholds data. What it does **not** prove: the `blocking`-verdict path, the `pg_stat_statements`-present positive path (measured `db-throughput`, slow-query detection), and the `serverless-pooling` heuristic are not yet covered by torture scenarios — deferred per the validation spec.

## Further Reading

- [Architecture](architecture.md) — system architecture overview
- [Readiness validation & documentation design spec](superpowers/specs/2026-07-19-readiness-validation-and-doc-design.md) — the design behind the torture scenarios and this document
- `crisismode-torture` scenarios `readiness-at-risk` and `readiness-honest-limits` — the executable validation
