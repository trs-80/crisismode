# Getting Started

This guide covers everything you need to start developing on CrisisMode — from first clone to running recovery agents against real infrastructure.

## Prerequisites

- **Node.js** >= 18 (recommended: use [fnm](https://github.com/Schniz/fnm) or [nvm](https://github.com/nvm-sh/nvm))
- **pnpm** — `npm install -g pnpm`
- **Podman** — for the containerized test environment. `brew install podman && podman machine init && podman machine start`
- **Git** — with the repo cloned: `git clone git@github.com:trs-80/crisismode.git`

### Optional

- **shellcheck** — `brew install shellcheck` (required by pre-commit hooks for `.sh` files)
- **gitleaks** — `brew install gitleaks` (required by pre-commit hooks for secret scanning)

## First-time Setup

```bash
cd crisismode
pnpm install
```

This installs dependencies and sets up husky pre-commit hooks automatically (via the `prepare` script).

Verify the hooks are working:

```bash
pnpm run typecheck    # TypeScript compilation check
```

## Running the Demo

The demo runs entirely in-memory using simulators — no database or infrastructure required:

```bash
pnpm dev
```

This walks through the full recovery pipeline for a PostgreSQL replication lag cascade: trigger → diagnosis → plan → validation → execution → forensic record.

## Setting Up the Test Environment

The test environment gives you real PostgreSQL with streaming replication, Prometheus, AlertManager, and a mock hub API.

### Start the stack

```bash
./test/podman/scripts/start.sh
```

This pulls container images and starts:
- **PostgreSQL primary** on `localhost:5432` (user: `crisismode`, password: `crisismode`)
- **PostgreSQL replica** on `localhost:5433` (streaming replication from primary)
- **Prometheus** on `http://localhost:9090` (scraping PG metrics)
- **AlertManager** on `http://localhost:9093` (configured to webhook to `localhost:3000`)
- **postgres_exporter** on `http://localhost:9187`
- **Mock Hub API** on `http://localhost:8080`

### Validate

```bash
./test/smoke/run-all.sh                # 16 checks: services, replication, metrics, hub API
./test/smoke/test-failure-injection.sh  # 6 checks: inject failures, verify, reset
```

### Inject failures

These scripts create real degraded states in the test PostgreSQL:

```bash
./test/failures/inject-replication-lag.sh     # Pause WAL replay → growing lag
./test/failures/inject-connection-flood.sh    # Open 200 idle connections
./test/failures/inject-long-queries.sh        # Hold row locks + expensive scans
./test/failures/inject-slot-overflow.sh       # Abandoned slot accumulating WAL
./test/failures/reset.sh                      # Restore everything to healthy
```

### Run the spoke against real PostgreSQL

```bash
# Dry-run: reads from real PG, logs mutations
pnpm run live

# With lag injected first:
./test/failures/inject-replication-lag.sh
pnpm run live

# Execute mode: actually runs SQL mutations
pnpm run live -- --execute
```

### Run the webhook receiver

```bash
pnpm run webhook                # dry-run, listens on :3000
pnpm run webhook --execute      # execute mode

# Then inject lag — AlertManager will fire an alert to the spoke
./test/failures/inject-replication-lag.sh
```

### Tear down

```bash
./test/podman/scripts/stop.sh
```

## Project Layout

### Core Framework (`src/framework/`)

| File | Purpose |
|---|---|
| `engine.ts` | Executes recovery plans step-by-step. Handles dry-run vs execute mode. |
| `backend.ts` | ExecutionBackend contract — shared interface for all execution backends |
| `safety.ts` | State capture, blast radius validation |
| `coordinator.ts` | Human approval logic (auto-approve decisions based on trust + catalog) |
| `validator.ts` | Validates plans against agent manifests |
| `catalog.ts` | Pre-authorized action catalog matching |
| `forensics.ts` | Forensic record assembly and persistence |
| `hub-client.ts` | Spoke ↔ hub communication (bootstrap, heartbeat, forensics, policies) |
| `capability-registry.ts` | Global registry of standard recovery capabilities |
| `provider-registry.ts` | Resolves capability providers for plan steps |
| `operator-summary.ts` | Builds operator-facing health and readiness summaries |
| `index.ts` | Barrel export for all framework modules |

### Agents (`src/agent/`)

Each agent follows the same pattern:

```
agent/
  <system>/
    backend.ts      # Interface that both simulator and live client implement
    simulator.ts    # In-memory implementation for demos and tests
    live-client.ts  # Real infrastructure client (connects to actual systems)
    manifest.ts     # Agent manifest (capabilities, risk profile, triggers)
    agent.ts        # RecoveryAgent implementation (diagnose, plan, replan)
```

**PostgreSQL Replication** (`pg-replication/`) — the MVP agent. Has a full live client that queries real `pg_stat_replication`.

**Redis Memory** (`redis/`) — cache recovery agent. Simulator complete, live client not yet built.

**etcd Recovery** (`etcd/`) — consensus cluster recovery. Handles leader election loops, NOSPACE alarms, member failures. Simulator complete.

**Kafka Recovery** (`kafka/`) — broker recovery agent. Handles under-replicated partitions, leader imbalance, consumer lag cascades. Simulator complete.

**Kubernetes Recovery** (`kubernetes/`) — cluster recovery agent. Handles node failures, pod crash loops, stuck deployments, PVC issues. Simulator complete.

**Ceph Storage** (`ceph/`) — distributed storage recovery. Handles OSD failures, degraded placement groups, pool near-full conditions. Simulator complete.

**Flink Stream Processing** (`flink/`) — stream job recovery. Handles checkpoint failure cascades, savepoint corruption, backpressure. Simulator complete.

### Type System (`src/types/`)

All contract types are defined here. Key types:
- `RecoveryPlan` — the plan structure with steps, impact analysis, rollback strategy
- `RecoveryStep` — 7 step types (system_action, diagnosis_action, human_notification, human_approval, checkpoint, replanning_checkpoint, conditional)
- `AgentManifest` — agent capabilities declaration
- `ForensicRecord` — immutable audit trail
- `AgentContext` — trigger, topology, trust levels, policies
- `HealthAssessment` / `OperatorSummary` — health assessment and operator-facing readiness types
- `PluginKind` / `CapabilityProviderDescriptor` — plugin ecosystem types for capability providers

## Building a New Agent

1. Create `src/agent/<system>/backend.ts` — define the interface for querying your target system
2. Create `src/agent/<system>/simulator.ts` — implement the interface with canned data
3. Create `src/agent/<system>/manifest.ts` — declare what your agent targets and its risk profile
4. Create `src/agent/<system>/agent.ts` — implement `RecoveryAgent` (diagnose, plan, replan)
5. Create `src/agent/<system>/registration.ts` — lazy factory for the agent registry
6. Register your agent in `src/config/builtin-agents.ts`
7. Add capabilities to `src/framework/capability-registry.ts` if your agent uses new capability domains

The framework handles validation, approval workflows, forensic recording, and hub communication — your agent only needs to diagnose and produce plans.

## Commit Conventions

This repo uses [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): description

feat(agent): add Redis memory pressure recovery
fix: correct replication lag threshold check
docs: update README with webhook instructions
chore: update dependencies
test: add failure injection round-trip tests
```

Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `ci`, `perf`, `build`

The commit-msg hook enforces this format.

## Pre-commit Hooks

All hooks run automatically on `git commit`. To bypass (e.g., for WIP commits):

```bash
git commit --no-verify -m "wip: work in progress"
```

| Hook | What it checks |
|---|---|
| TypeScript typecheck | `tsc --noEmit` on staged `.ts` files |
| gitleaks | Secret detection (API keys, tokens, passwords) |
| Sensitive files | Blocks `.pem`, `.key`, `.p12`, `.env`, `kubeconfig`, `tfstate` |
| shellcheck | Lints staged `.sh` files |
| Large files | Blocks files >1MB |
| Conflict markers | Catches leftover `<<<<<<<` / `>>>>>>>` |
| Conventional commits | Enforces commit message format |

## Useful Commands

```bash
pnpm dev                              # Demo mode (simulated)
pnpm run live                         # Live mode against test PG (dry-run)
pnpm run live -- --execute            # Live mode with mutations
pnpm run webhook                      # Start webhook receiver
pnpm test                             # Run unit tests (vitest)
pnpm run test:watch                   # Run tests in watch mode
pnpm run typecheck                    # TypeScript check
pnpm run build                        # Compile to dist/
./test/podman/scripts/start.sh        # Start test environment
./test/podman/scripts/status.sh       # Check test environment status
./test/smoke/run-all.sh               # Run smoke tests
./test/failures/inject-replication-lag.sh  # Inject test failure
./test/failures/reset.sh              # Reset to healthy
```
