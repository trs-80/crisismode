# CrisisMode

An open framework for building autonomous recovery agents that restore IT systems during severe incidents. Safety guarantees, forensic preservation, and human-in-the-loop coordination as first-class primitives.

**Website:** [crisismode.ai](https://crisismode.ai)

## What is this?

CrisisMode is the tool an organization reaches for when normal operational tooling has failed or is insufficient. It provides a contract-driven framework where recovery agents execute validated plans against degraded infrastructure — with state capture, blast radius enforcement, and approval workflows built in.

The framework uses a **hub-and-spoke architecture**: spokes run close to target systems and handle execution (Layers 1-2), while the hub provides coordination, analytics, and management (Layers 3-4). Spokes operate autonomously when the hub is unreachable.

## Project Structure

```
specs/
  foundational/
    recovery-agent-contract.md    # Agent contract specification (v0.2.1)
  deployment/
    operations.md                 # Hub-and-spoke deployment & operations spec

src/
  types/                          # TypeScript type definitions for the contract
  framework/                      # Execution engine, safety, forensics, coordination
  agent/
    interface.ts                  # RecoveryAgent contract interface
    pg-replication/               # PostgreSQL replication recovery agent (MVP)
  demo/                           # Interactive CLI demo

test/
  podman/                         # Containerized test environment (PG primary/replica,
                                  #   Prometheus, AlertManager, mock hub API)
  failures/                       # Failure injection scripts
  smoke/                          # Automated validation tests
  local/                          # Native macOS test setup (no containers)

site/                             # Marketing site (crisismode.ai)
```

## Quick Start

### Run the demo

```bash
pnpm install
pnpm dev
```

### Spin up the test environment

Requires [Podman](https://podman.io/):

```bash
# Start the full stack (PG primary/replica, Prometheus, AlertManager, mock hub)
./test/podman/scripts/start.sh

# Validate everything is working
./test/smoke/run-all.sh

# Inject failures to test against
./test/failures/inject-replication-lag.sh
./test/failures/inject-connection-flood.sh
./test/failures/inject-slot-overflow.sh
./test/failures/inject-long-queries.sh

# Reset to healthy state
./test/failures/reset.sh

# Tear down
./test/podman/scripts/stop.sh
```

### Local mode (no containers)

```bash
./test/local/setup.sh    # One-time: brew install PG, Prometheus, AlertManager
./test/local/start.sh    # Start services as native processes
./test/local/stop.sh     # Stop everything
```

## MVP Target

- **Deployment:** Kubernetes (Helm chart)
- **First agent:** PostgreSQL recovery (replication lag, connection exhaustion, slot overflow)
- **Trigger source:** Prometheus AlertManager
- **Notifications:** Slack with interactive approval buttons
- **Hub:** Vendor-hosted SaaS

## Specifications

- [Recovery Agent Contract](specs/foundational/recovery-agent-contract.md) — the authoritative definition of how agents interact with the framework
- [Deployment & Operations](specs/deployment/operations.md) — hub-and-spoke deployment architecture, integration patterns, and operational management

## License

Proprietary. All rights reserved.
