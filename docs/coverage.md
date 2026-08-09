# Coverage and Validation Status

What CrisisMode can look at, and how far each part has actually been proven. This
page exists because "we support Kafka" is a claim that means nothing without
saying how it was tested.

The tool is the authoritative source, not this file:

```bash
crisismode agent list          # every registration with its maturity label
crisismode agent info <name>   # one agent's targets, risk profile, and maturity
```

## The two labels

CrisisMode's manifests carry a five-value `PluginMaturity`
(`experimental`, `simulator_only`, `dry_run_only`, `live_validated`,
`production_certified`), but the honesty layer that operators see collapses it to
two (`src/framework/agent-maturity.ts`):

| Label | Means |
|---|---|
| **live-validated** | The manifest declares `live_validated` — the agent has been exercised against a real deployment of that system. |
| **best-effort** | Everything else. The checks exist and run, but have never been proven against a live system. Findings are leads, not conclusions. |

Two deliberate consequences:

- **best-effort is the default.** Unknown kinds, unregistered kinds, and plugin
  manifests that declare no maturity all land here. The pessimistic reading is
  the honest one.
- **A kind is only live-validated when *every* agent registered for it says so.**
  With several agents per kind, the framework can't know which one will run, so
  it claims the weaker label.

Best-effort findings say so in the output — human scan output appends a
"never been validated against real infrastructure — treat this as a lead, not a
conclusion" suffix rather than presenting them as equal to validated ones.

## Live-validated today

9 of 26 registrations. The LLM-provider agent registers once per provider, so it
accounts for two of the nine (Anthropic and OpenAI) from the single row below.

| System | Agent | Notes |
|---|---|---|
| PostgreSQL | `postgresql-replication-recovery` | Replication lag, slot overflow, replica divergence, connection-pool exhaustion. The reference implementation. |
| Kubernetes | `kubernetes-recovery` | Node not-ready cascade, pod crashloop, stuck reconciliation |
| DNS | `dns-recovery` | Resolution failures, resolver health; can flush the local cache |
| TLS | `tls-certificate-recovery` | Certificate expiry and chain health (diagnosis only) |
| Disk | `disk-exhaustion-recovery` | Local disk exhaustion (diagnosis only) |
| Backup | `backup-verification` | Backup verification and DR readiness across filesystem, `aws_s3`, `aws_rds` providers (diagnosis only) |
| Third-party status | `service-status-diagnosis` | All 12 catalog entries passed live validation |
| LLM providers | `llm-provider-diagnosis` | **Anthropic and OpenAI only.** Key validity, quota/billing, rate-limit headroom, model deprecation, provider status |

## Best-effort today

17 of 26 registrations. The logic and simulators are complete and unit-tested;
none has been validated against a live deployment of its target system. The
Google Gemini and OpenRouter rows are two separate registrations of the
LLM-provider agent, which is why the table below has 16 rows.

| System | Agent | Scenarios covered |
|---|---|---|
| Redis | `redis-memory-recovery` | Memory pressure, client exhaustion, slow queries, cluster health |
| etcd | `etcd-recovery` | Leader election loop, member thrashing, NOSPACE alarms, snapshot corruption |
| Kafka | `kafka-recovery` | Under-replicated partitions, leader imbalance, consumer lag cascade |
| Ceph | `ceph-storage-recovery` | OSD down cascade, degraded PGs, pool near-full |
| Flink | `flink-recovery` | Checkpoint failure cascade, TaskManager loss, backpressure |
| AWS S3 | `aws-s3-recovery` | Backup bucket versioning and lifecycle configuration |
| AWS DynamoDB | `aws-dynamodb-recovery` | Point-in-time-recovery verification |
| AWS RDS | `aws-rds-recovery` | Control-plane health, metrics, reachability, backup retention and snapshot recency |
| Terraform | `iac-drift-recovery` | Drift detection: intended state vs. observed AWS resources. Read-only; suggests reconciliation |
| Deploy rollback | `deploy-rollback-recovery` | Bad-deploy rollback (Vercel; needs `VERCEL_TOKEN`) |
| DB migration | `db-migration-recovery` | Migration safety checks, rollback orchestration |
| Queue backlog | `queue-backlog-recovery` | Backlog reduction, consumer lag recovery |
| Config drift | `config-drift-recovery` | Configuration and environment drift, compliance enforcement |
| Vector stores | `vector-store-diagnosis` | Managed vector store reachability (Pinecone, Upstash Vector) |
| AI provider | `ai-provider-failover-recovery` | Provider failover and fallback routing |
| LLM providers | `llm-provider-diagnosis` | Google Gemini and OpenRouter paths (implemented; not live-validated) |

Some of these have been exercised in *dry-run* against real infrastructure, which
is worth more than simulator-only but is still not `live_validated`:

- **AWS S3, DynamoDB, RDS** — diagnosis validated in dry-run against real AWS
  accounts. No execute path has been verified.
- **DB migration, queue backlog, config drift** — diagnosis validated in dry-run
  through the torture harness.
- **Deploy rollback** — exercised against the real Vercel API in dry-run.

### Vector stores: read this before believing the table

`vector-store-diagnosis` is `simulator_only` and neither provider has been
validated against a real account. Two narrower things *were* checked against the
live Pinecone API: that an invalid key is rejected, and that secrets are redacted
from output. Upstash Vector was exercised only in simulator and mocked tests.
Nothing about healthy-path behaviour against a real index is verified.

## Execute-verified recovery

Maturity labels describe *diagnosis*. Whether a mutating recovery plan actually
ran and actually fixed the fault is a stricter and much narrower claim.

The [crisismode-torture](https://github.com/trs-80/crisismode-torture) harness
runs CrisisMode against real degraded infrastructure — PostgreSQL replication,
Redis, 3-node etcd, 3-broker Kafka, Redis Cluster partitions, cascading failures,
and real AWS RDS/S3/DynamoDB.

**Validated:** failure detection (typically 3–5s), AI diagnosis, and dry-run
recovery planning against real infrastructure, including real AWS and Vercel.

**Execute-verified (as of 2026-07-13)** — a mutating plan that ran, *plus*
post-recovery health verification confirming the underlying fault was resolved,
not merely that the engine exited without error. Exactly three scenarios:

1. Redis memory pressure
2. PostgreSQL WAL-replay-paused replication lag
3. PostgreSQL connection-pool exhaustion

All three are reproducible through the harness.

**Not verified:** end-to-end `--execute` recovery for every other
agent/scenario on this page. Execute mode is functional for individual actions,
and the engine correctly refuses to run a plan when a required live provider is
missing — a blocked run is never counted as a recovery — but no other torture
scenario has completed a full mutating recovery with post-recovery verification.
Treat those execute paths as experimental. AWS and Vercel scenarios remain
dry-run/skipped under `--execute`.

Note that Redis is execute-verified for memory pressure while its manifest still
declares `simulator_only`. That is not a typo: the two claims measure different
things, and the manifest deliberately makes the weaker one.

## Readiness rules

`crisismode readiness` is a separate, strictly read-only surface with its own
honesty contract (unknown is never scored, ceilings are never fabricated). Two
torture scenarios validate it against real PostgreSQL. Its uncovered paths —
the `blocking` verdict, the `pg_stat_statements`-present positive path, and the
`serverless-pooling` heuristic — are listed in
[docs/readiness.md](readiness.md#validation).

## Other validation surfaces

**Diagnosis eval** — 14 incident families from the external
[sre-incident-agent-skills](https://github.com/Dbochman/sre-incident-agent-skills)
benchmark, run against the real CLI with a 13/14 score gate
(`pnpm run eval:diagnosis:gate`). A recorded run is in
[docs/evals/2026-07-04-diagnosis-eval.md](evals/2026-07-04-diagnosis-eval.md).

**Remediation guide verification** — the console-step guidance CrisisMode prints
for fixes it must not perform itself is re-walked against live consoles on a
schedule; a test fails when any guide's `verifiedOn` is more than 12 months old.
The most recent walk-through is in
[docs/guide-verification/2026-08-08-walkthrough.md](guide-verification/2026-08-08-walkthrough.md).
Guides on platforms nobody has an account for are marked `BLOCKED` and reported
as a coverage gap rather than quietly assumed correct.

**Unit tests and typecheck** — `pnpm test` and `pnpm run typecheck`, both run in
CI on Node 22 and 24.
