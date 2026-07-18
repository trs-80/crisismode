# Scale-Readiness Design

**Date:** 2026-07-18
**Status:** Approved for implementation
**Audience:** Builders on serverless + managed-Postgres stacks (Vercel + `DATABASE_URL`-reachable PostgreSQL) with limited ops depth

## Problem

People who ship apps without ops experience hit a predictable set of scaling
failures — connection-pool exhaustion from serverless functions, missing
indexes, small plan limits — and existing tools either show them graphs they
cannot interpret or fire after the outage has already happened. CrisisMode
already diagnoses several of these failures reactively (pg connection
exhaustion is execute-verified) and already ships plain-English explanations
with learn-more links. What is missing is (a) a forward-looking answer to
"will my app break under load?" and (b) scaling attribution in the reactive
explanations ("why did this happen, in my stack's terms").

## Scope decisions (settled during brainstorm)

- **Both moments from day one:** proactive readiness report + reactive
  attribution layer.
- **Stack:** generic PostgreSQL via `DATABASE_URL`/`POSTGRES_URL` (covers
  Supabase/Neon/RDS connection strings) plus existing Vercel integration.
  No provider API clients in v1.
- **Surface:** new `crisismode readiness` CLI command + new
  `crisismode_readiness` MCP tool (tool #8). Scan is unchanged: scan answers
  "is it broken", readiness answers "will it break under load".
- **Reactive depth:** attribution layer only — new explanation-registry
  entries triggered by finding kind + environment context. No new agents, no
  new diagnosis scenarios.
- **Read-only end to end:** readiness maxes out at the *suggest* escalation
  level. The MCP surface keeps its all-tools-read-only invariant
  (`readOnlyHint: true`).

## Architecture

New `src/readiness/` module — a rule registry, not an agent and not a check
plugin. Rationale: readiness is a new kind of output (forward-looking,
scored) but not a new domain; it borrows all data access from existing
clients. An agent would leave `plan()`/`replan()` as permanent stubs; check
plugins (shell + JSON wire protocol) fit poorly for credentialed SQL and a
scored multi-rule report.

### Components

```
src/readiness/
  types.ts     ReadinessRule, ReadinessFinding, ReadinessReport, ReadinessContext
  rules/       one file per rule (six in v1)
  run.ts       context building, rule execution, report assembly
  report.ts    scoring + verdict
```

- `ReadinessRule { id, title, applicable(ctx), evaluate(sources) -> ReadinessFinding }`
- `ReadinessFinding { status: 'ready' | 'at_risk' | 'blocking' | 'unknown',
  headroom?, evidence, explanation, fix, learnMoreUrl }`
- Verdict: `ready` / `at-risk` / `not-ready`. `unknown` findings are counted
  and displayed separately — never folded into the score.

### Data sources (all existing)

| Source | Provider | Used for |
|---|---|---|
| Env/target discovery | `src/cli/autodiscovery.ts` (already parses `DATABASE_URL`, `POSTGRES_URL`, `PG_CONNECTION_STRING`) | target resolution, connection-string shape |
| PostgreSQL | pg-replication live client (already queries `pg_stat_activity`, `max_connections`) extended with two read-only queries: `pg_stat_user_tables`, `pg_stat_statements` (if present) | connection, index, and query rules |
| Serverless context | `vercel.json` / `.vercel/` in cwd, `VERCEL_TOKEN`; deploy-rollback live client for project metadata when token present | `serverless-pooling` rule, attribution context |
| Explanations | signal-explanation + learn-more-link infrastructure | finding rendering |

### CLI and MCP

Both are thin renderers over the same `ReadinessReport`:

- `crisismode readiness [--json]` — standard three output modes via
  `src/cli/output.ts` (human / pipe / JSON lines).
- `crisismode_readiness` MCP tool registered in `src/mcp/server.ts` with
  `readOnlyHint: true`.

### Attribution layer (reactive half)

New entries in the signal-explanation registry keyed by **finding kind +
environment context**. Example: connection-exhaustion diagnosis + serverless
context detected → explanation gains "each serverless invocation opens its
own database connection — use a pooled connection string" with fix and
learn-more link. Diagnosis logic is unchanged; only explanation output is
touched.

## v1 rules

| Rule | Source | Flags |
|---|---|---|
| `connection-headroom` | `pg_stat_activity` vs `max_connections` | usage above ~60% of max → `at_risk`, above ~80% → `blocking`; reports headroom % |
| `serverless-pooling` | serverless signals + connection-string shape | direct (unpooled) connection from a serverless deploy; explicitly labeled a heuristic finding |
| `connection-limit-tier` | `max_connections` | small limits (≈≤25, typical free tiers) → headroom warning |
| `missing-index` | `pg_stat_user_tables` | large tables where sequential scans dominate index scans |
| `slow-queries` | `pg_stat_statements` | top offenders by mean execution time; `unknown` + enablement hint when the extension is absent |
| `long-transactions` | existing idle-in-transaction query | idle-in-transaction sessions holding locks/connections |

Exact thresholds are implementation-time decisions; each rule's threshold
must be a named constant with a comment citing its rationale.

**Deliberately excluded:** latency/region checks. RTT measured from a
developer laptop says nothing about the function-to-database path; reporting
it would mislead. Future work gated on running from the deploy region.

## Data flow

```
readiness (CLI | MCP)
  -> build ReadinessContext (env scan, serverless detection, target resolution)
  -> connect pg live client
       (failure -> report contains explicit "cannot assess: <error>"; no fallback)
  -> run applicable rules
       (each isolated; a rule error -> that finding = unknown + reason)
  -> score + verdict
  -> render (human / pipe / JSON) or MCP structured content
```

## Error handling

Follows the live-registration honesty policy (`src/config/live-registration.ts`):

- Connection failures propagate into the report as explicit can't-assess
  findings. Never fall back to simulated data.
- A rule never guesses: absent extension or insufficient privileges →
  `unknown` with the reason and how to enable access.
- The verdict line always states how many rules ran vs. could not run.

## Testing

- Unit tests per rule against the pg simulator, extended with
  `pg_stat_user_tables` / `pg_stat_statements` fixtures covering healthy,
  at-risk, blocking, and extension-absent states.
- CLI coverage in `test:cli`.
- MCP test asserting `crisismode_readiness` registers with
  `readOnlyHint: true` (preserves the read-only invariant across all 8 tools).
- **Gate:** re-run `pnpm run build:bundle && pnpm run eval:diagnosis:gate`
  before merge — the attribution layer touches explanation output, and the
  standing rule is to re-run the eval after any respond/agent-adjacent
  change.

## Documentation (same PR)

README CLI reference and MCP table (7 → 8 tools), CLAUDE.md command table and
key files, GETTING_STARTED CLI list.

## Out of scope for v1

Provider API integrations (Supabase/Neon plan tiers, pooler mode),
Redis/Upstash rules, latency/region checks, any mutating remediation,
hosted/Slack surfaces.
