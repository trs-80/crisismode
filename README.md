# CrisisMode

Runbooks tell humans what to do. CrisisMode agents *do it* — with safety guarantees that runbooks can't enforce. Every action is validated against a blast radius, every mutation is preceded by a state capture, every risky step requires approval, and every execution produces an immutable forensic record. AI-powered diagnosis identifies failure patterns that rule-based monitoring misses.

**Website:** [crisismode.ai](https://crisismode.ai)

## What is this?

CrisisMode is the tool an organization reaches for when normal operational tooling has failed or is insufficient. Recovery agents connect to real infrastructure, use AI to diagnose what's wrong, build validated recovery plans, and execute them with human-in-the-loop safety — all while producing a complete forensic trail.

The framework uses a **hub-and-spoke architecture**: spokes run close to target systems and handle execution (Layers 1-2), while the hub provides coordination, analytics, and management (Layers 3-4). Spokes operate autonomously when the hub is unreachable.

<details>
<summary><strong>See it in action</strong> — live mode diagnosing real PostgreSQL replication lag</summary>

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

</details>

## Project Structure

```
specs/
  foundational/
    recovery-agent-contract.md      # Agent contract specification (v0.2.1)
  deployment/
    operations.md                   # Hub-and-spoke deployment & operations spec

src/
  types/                            # TypeScript type definitions for the contract
  framework/                        # Execution engine, safety, forensics, coordination, hub client
  agent/
    interface.ts                    # RecoveryAgent contract interface
    pg-replication/                 # PostgreSQL replication recovery agent
    redis/                          # Redis memory pressure recovery agent
  demo/                             # Interactive CLI demo (simulator mode)
  live.ts                           # Live mode — runs against real infrastructure
  webhook.ts                        # Webhook receiver for AlertManager integration

test/
  podman/                           # Containerized test environment
    compose.yaml                    #   PG primary/replica, Prometheus, AlertManager, mock hub
    mock-hub/                       #   Mock hub API server
  failures/                         # Failure injection scripts
  smoke/                            # Automated validation tests
  local/                            # Native macOS test setup (no containers)

deploy/
  helm/crisismode-spoke/            # Helm chart for Kubernetes deployment

site/                               # Marketing site (crisismode.ai)
```

## Quick Start

```bash
pnpm install
```

### Demo mode (simulated)

```bash
pnpm dev
```

Walks through the full recovery pipeline with simulated PostgreSQL data. No infrastructure required.

### Live mode (real PostgreSQL)

Requires the test environment running (see below):

```bash
# Dry-run — reads from real PG, mutations are logged but not executed
pnpm run live

# Execute mode — actually runs recovery SQL against PostgreSQL
pnpm run live -- --execute
```

### Webhook receiver (AlertManager integration)

```bash
# Start the spoke webhook server (dry-run)
pnpm run webhook

# Start with mutations enabled
pnpm run webhook --execute
```

AlertManager sends alerts to `http://localhost:3000/api/v1/alerts`. The spoke runs the full pipeline: diagnose → plan → validate → execute → submit forensic record to hub.

## Test Environment

### Podman (full stack with replication)

Requires [Podman](https://podman.io/):

```bash
# Start: PG primary/replica, Prometheus, AlertManager, mock hub
./test/podman/scripts/start.sh

# Validate
./test/smoke/run-all.sh

# Inject failures
./test/failures/inject-replication-lag.sh
./test/failures/inject-connection-flood.sh
./test/failures/inject-slot-overflow.sh
./test/failures/inject-long-queries.sh

# Reset to healthy
./test/failures/reset.sh

# Status check
./test/podman/scripts/status.sh

# Tear down
./test/podman/scripts/stop.sh
```

### Local mode (no containers)

```bash
./test/local/setup.sh    # One-time: brew install PG, Prometheus, AlertManager
./test/local/start.sh    # Start services as native processes
./test/local/stop.sh     # Stop everything
```

## Agents

| Agent | System | Scenarios | Status |
|---|---|---|---|
| **PostgreSQL Replication** | PostgreSQL >=14 | Replication lag cascade, slot overflow, replica divergence, WAL sender timeout | Live — tested against real PG |
| **Redis Memory** | Redis >=6 | Memory pressure, client exhaustion, slow query storms | Simulator complete |

### Building a new agent

Implement the `RecoveryAgent` interface (`src/agent/interface.ts`):

```typescript
interface RecoveryAgent {
  manifest: AgentManifest;
  diagnose(context: AgentContext): Promise<DiagnosisResult>;
  plan(context: AgentContext, diagnosis: DiagnosisResult): Promise<RecoveryPlan>;
  replan(context: AgentContext, diagnosis: DiagnosisResult, state: ExecutionState): Promise<ReplanResult>;
}
```

Follow the backend pattern: create a `Backend` interface, a `Simulator` for testing, and a `LiveClient` for real infrastructure. See `src/agent/pg-replication/` for the reference implementation.

## Kubernetes Deployment

```bash
helm install crisis-spoke deploy/helm/crisismode-spoke/ \
  --set hub.endpoint=https://hub.crisismode.ai \
  --set postgresql.primary.host=my-pg-primary \
  --set postgresql.primary.credentialsSecret=pg-credentials \
  --set targetNamespaces='{default,production}'
```

## Architecture

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

**Execution modes:**
- `dry-run` (default) — reads from real systems, logs mutations without executing
- `execute` — runs all operations including SQL mutations

**Safety layers:** manifest validation, blast radius checks, precondition evaluation, success criteria, approval workflows, forensic recording.

## Specifications

- [Recovery Agent Contract](specs/foundational/recovery-agent-contract.md) — the authoritative agent interface definition
- [Deployment & Operations](specs/deployment/operations.md) — hub-and-spoke architecture, integration patterns, operational management

## Development

See [GETTING_STARTED.md](GETTING_STARTED.md) for development setup, testing workflows, and contribution guidelines.

## Pre-commit Hooks

Enforced automatically via husky:
- TypeScript type checking
- Secret detection (gitleaks)
- Shell script linting (shellcheck)
- Large file prevention, merge conflict markers, .env protection
- Conventional commit message format

## License

The spoke runtime, agent SDK, and specifications are licensed under **Apache 2.0**. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for details.

| Component | License |
|---|---|
| Spoke runtime (`src/framework/`, `src/agent/`, `src/types/`) | Apache 2.0 |
| Agent SDK and contract spec (`specs/foundational/`) | Apache 2.0 |
| Test infrastructure (`test/`, `deploy/`) | Apache 2.0 |
| Hub API, coordination, and management UI | Commercial (not in this repo) |
