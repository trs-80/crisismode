# CrisisMode

[![CI](https://github.com/trs-80/crisismode/actions/workflows/ci.yml/badge.svg)](https://github.com/trs-80/crisismode/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/trs-80/crisismode/graph/badge.svg)](https://codecov.io/gh/trs-80/crisismode)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-%3E%3D18-green?logo=node.js&logoColor=white)](https://nodejs.org/)

CrisisMode is the recovery layer for your infrastructure. Monitoring tells you something is wrong. CrisisMode tells you what to do about it — safely.

It diagnoses issues using AI, builds validated recovery plans with blast-radius controls, and executes them with human-in-the-loop oversight. Every action is preceded by a state capture. Every execution produces an immutable forensic record. Domain experts contribute recovery knowledge as agents and check plugins — the framework ensures that knowledge is applied safely when infrastructure is degraded and the cost of wrong actions is highest.

**Website:** [crisismode.ai](https://crisismode.ai)

## Who This Is For

- SREs and platform engineers who get paged and need to act under pressure.
- AI app builders operating managed infrastructure with limited ops depth.
- On-call engineers who inherit systems they didn't build.
- Domain experts (database specialists, Kafka engineers, storage admins) who want to codify recovery knowledge.

## From Alert to Recovery

Live mode diagnosing real PostgreSQL replication lag:

```
  Connecting to PostgreSQL...
  ✅ Primary connected — 3 active connections
  ✅ Replication: 1 replica(s) streaming
  ✅ Replica connected — recovery mode: true, lag: 636s

  ── Live Replication Status ──
  🔴 10.89.0.5/32 | streaming | lag: 41s | sent: 0/63704F0 | replay: 0/5EDE5F8

  Phase 3: Diagnosis (Live — AI-Powered)
  ──────────────────────────────────────
  🤖 AI analyzing system state...
     Status:      identified
     Scenario:    replication_lag_cascade
     Confidence:  94%
     Root cause:  WAL replay paused on replica — sent LSN is advancing
                  but replay LSN is static, indicating a deliberate pause
                  or I/O bottleneck on the replica, not a network issue.

  Phase 4: Plan Creation
  ──────────────────────
     #   Type                    Risk        Name
     ────────────────────────────────────────────────────────────
     1   diagnosis_action        —           Assess replication lag
     2   human_notification      —           Notify on-call DBA
     3   checkpoint              —           Pre-recovery state capture
     4   system_action           elevated    Disconnect lagging replica
     5   system_action           routine     Redirect read traffic
     6   replanning_checkpoint   —           Assess progress
     7   human_approval          —           Approve resynchronization
     8   system_action           high        pg_basebackup + resync
     9   conditional             —           Restore traffic or notify
     10  human_notification      —           Recovery summary

  Phase 7: Execution (Live — EXECUTE MODE)
  ─────────────────────────────────────────
  🔴 EXECUTE MODE — SQL mutations WILL be run against real PostgreSQL.

     Step step-004 [system_action]
     Disconnect lagging replica 10.89.0.5/32 from replication
     ✓ Precondition: Replica 10.89.0.5/32 is currently connected
     ✓ Success: WAL sender for 10.89.0.5/32 is no longer present
     ● SUCCESS (6ms)
```

## Quick Start

**Demo mode** (no infrastructure required):

```bash
pnpm install && pnpm dev
```

**Real PostgreSQL** (requires [test environment setup](test/podman/scripts/start.sh)):

```bash
pnpm run live                  # Dry-run — reads real PG, logs mutations
pnpm run live -- --execute     # Execute mode — runs recovery commands
```

**AlertManager webhook:**

```bash
pnpm run webhook               # Dry-run, listens on :3000
pnpm run webhook --execute     # Execute mode
```

See [QUICKSTART.md](QUICKSTART.md) for a full walkthrough.

## What CrisisMode Recovers

### Modern Application Incidents

| Scenario | Agent | Status |
|---|---|---|
| Bad deploy rollback | Deploy Rollback | Simulator ready |
| AI provider degradation / failover | AI Provider | Simulator ready |
| Database migration failures | DB Migration | Simulator ready |
| Queue and worker backlog | Queue Backlog | Simulator ready |
| Config and environment drift | Config Drift | Simulator ready |

### Stateful Infrastructure Recovery

| System | Scenarios | Status |
|---|---|---|
| PostgreSQL | Replication lag, slot overflow, replica divergence | Live -- tested against real PG |
| Redis | Memory pressure, client exhaustion, slow queries | Simulator ready |
| etcd | Leader election loop, member thrashing, snapshot corruption | Simulator ready |
| Kafka | Under-replicated partitions, consumer lag cascade | Simulator ready |
| Kubernetes | Node not-ready cascade, pod crashloop, stuck reconciliation | Simulator ready |
| Ceph | OSD down cascade, degraded PGs, pool near-full | Simulator ready |
| Flink | Checkpoint failure cascade, TaskManager loss, backpressure | Simulator ready |

## How It Works

```
Alert Source (Prometheus) → Spoke Webhook Receiver
                              ↓
                           Diagnose (query real systems)
                              ↓
                           Plan (build recovery steps)
                              ↓
                           Validate (manifest + policy checks)
                              ↓
                           Execute (dry-run or live)
                              ↓
                           Forensic Record → Hub API
```

CrisisMode uses a hub-and-spoke architecture: spokes run close to target systems and handle execution, while the hub provides coordination, analytics, and management. Recovery actions progress through five escalation levels: observe, diagnose, suggest, repair-safe, and repair-destructive.

## Safety Model

- Blast radius validation on every system action
- Pre-mutation state capture (checkpoint before any change)
- Human approval gates for elevated-risk operations
- Dry-run mode by default (reads real systems, logs mutations without executing)
- Five-level progressive escalation (observe → diagnose → suggest → repair-safe → repair-destructive)
- Immutable forensic record for every execution

## CLI Reference

```bash
crisismode             # Zero-config health scan (default)
crisismode scan        # Health scan with scored summary and next-action hints
crisismode diagnose    # Health check + AI-powered diagnosis (read-only)
crisismode recover     # Full recovery flow with execution planning
crisismode status      # Quick health probe
crisismode ask         # Natural language AI diagnosis
crisismode demo        # Simulator demo mode
crisismode init        # Generate crisismode.yaml configuration
crisismode webhook     # Start webhook receiver for AlertManager
crisismode watch       # Continuous shadow observation
```

Output modes: `--json` for machine-readable JSON, plain text auto-detected when piped, colored TTY output by default.

## Check Plugin Ecosystem

CrisisMode consumes external health checks through a unified adapter layer, making thousands of existing checks available without rewriting them:

- **Native check plugins** — JSON wire protocol for purpose-built CrisisMode checks
- **Nagios/Icinga/Checkmk plugins** — thousands of battle-tested infrastructure checks
- **Goss YAML health assertions** — declarative system state validation
- **Sensu checks** — Graphite, InfluxDB, OpenTSDB, and Prometheus metric formats

See [docs/guides/creating-a-check-plugin.md](docs/guides/creating-a-check-plugin.md) for the check plugin authoring guide.

## Contributing

Recovery knowledge lives in agents and check plugins. Domain experts contribute what they know about how systems fail — the framework handles safety, validation, and execution. See [GETTING_STARTED.md](GETTING_STARTED.md) for the developer setup and the 6-file agent pattern.

Every agent implements the `RecoveryAgent` interface (`src/agent/interface.ts`):

```typescript
interface RecoveryAgent {
  manifest: AgentManifest;
  diagnose(context: AgentContext): Promise<DiagnosisResult>;
  plan(context: AgentContext, diagnosis: DiagnosisResult): Promise<RecoveryPlan>;
  replan(context: AgentContext, diagnosis: DiagnosisResult, state: ExecutionState): Promise<ReplanResult>;
}
```

## Deployment

```bash
helm install crisis-spoke deploy/helm/crisismode-spoke/ \
  --set hub.endpoint=https://hub.crisismode.ai \
  --set postgresql.primary.host=my-pg-primary \
  --set postgresql.primary.credentialsSecret=pg-credentials \
  --set targetNamespaces='{default,production}'
```

The spoke runs in 256Mi and operates autonomously when the hub is unreachable.

## Specifications

- [Recovery Agent Contract](specs/foundational/recovery-agent-contract.md) — the authoritative agent interface definition
- [Deployment & Operations](specs/deployment/operations.md) — hub-and-spoke architecture, integration patterns, operational management
- [Plugin Platform Architecture Guide](specs/architecture/plugin-platform.md) — how the repo evolves from bespoke agents to a scalable plugin ecosystem
- [Operator Health & AI Services](specs/architecture/operator-health-and-ai-services.md) — operator summary, AI diagnosis, and site config spec

## License

The spoke runtime, agent SDK, and specifications are licensed under **Apache 2.0**. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for details.

| Component | License |
|---|---|
| Spoke runtime (`src/framework/`, `src/agent/`, `src/types/`) | Apache 2.0 |
| Agent SDK and contract spec (`specs/foundational/`) | Apache 2.0 |
| Test infrastructure (`test/`, `deploy/`) | Apache 2.0 |
| Hub API, coordination, and management UI | Commercial (not in this repo) |
