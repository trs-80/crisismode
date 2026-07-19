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

Live mode diagnosing real PostgreSQL replication lag (local podman test
environment; the excerpt shows a single elevated-risk step executing — see
[Validation status](#validation-status) for what is and isn't verified today):

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

## Install

Download a prebuilt binary from [GitHub Releases](https://github.com/trs-80/crisismode/releases/latest) — no Node.js required. macOS binaries are codesigned and notarized; every artifact ships with a SHA256 checksum.

```bash
# Linux (x64)
curl -fsSL https://github.com/trs-80/crisismode/releases/latest/download/crisismode-linux-x64 -o crisismode

# macOS (Apple Silicon)
curl -fsSL https://github.com/trs-80/crisismode/releases/latest/download/crisismode-darwin-arm64 -o crisismode

chmod +x crisismode
./crisismode scan
```

Also available: `crisismode-linux-arm64` and `crisismode-darwin-x64`. To verify a download, fetch the matching `.sha256` file and run `shasum -a 256 -c`.

Enable tab completion for your shell:

```bash
crisismode completions bash|zsh|fish
```

## Quick Start

**Zero-config scan** — CrisisMode autodiscovers databases, caches, and brokers on your machine and checks what it finds:

```bash
crisismode
```

**Demo mode** (no infrastructure required, building from source):

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

Status legend:

- **Live (execute-capable)** — queries real infrastructure and can run recovery mutations in `--execute` mode
- **Live (diagnosis only)** — queries real infrastructure; recovery output is advisory (no mutating actions)
- **Simulator** — full agent logic against an in-memory simulator; live client not yet wired into the CLI

### Modern Application Incidents

| Scenario | Agent | Status |
|---|---|---|
| Bad deploy rollback | Deploy Rollback | Live (execute-capable) -- Vercel, requires `VERCEL_TOKEN` |
| AI provider degradation / failover | AI Provider | Live (execute-capable) -- not yet torture-tested |
| Database migration failures | DB Migration | Live (execute-capable) -- diagnosis validated in dry-run via torture harness |
| Queue and worker backlog | Queue Backlog | Live (execute-capable) -- diagnosis validated in dry-run via torture harness |
| Config and environment drift | Config Drift | Live (execute-capable) -- diagnosis validated in dry-run via torture harness |

### Stateful Infrastructure Recovery

| System | Scenarios | Status |
|---|---|---|
| PostgreSQL | Replication lag, slot overflow, replica divergence, connection-pool exhaustion | Live (execute-capable) -- see validation status below |
| Redis | Memory pressure, client exhaustion, slow queries, cluster health | Live (execute-capable) |
| etcd | Leader election loop, member thrashing, snapshot corruption | Simulator |
| Kafka | Under-replicated partitions, consumer lag cascade | Simulator |
| Kubernetes | Node not-ready cascade, pod crashloop, stuck reconciliation | Live (execute-capable) |
| Ceph | OSD down cascade, degraded PGs, pool near-full | Simulator |
| Flink | Checkpoint failure cascade, TaskManager loss, backpressure | Simulator |
| AWS | S3, DynamoDB, and RDS recovery; backup verification, PITR, snapshot staleness | Live (execute-capable) -- validated in dry-run against real AWS |

### Host & Platform Health

| Check | Scenarios | Status |
|---|---|---|
| DNS | Resolution failures, resolver health | Live (diagnosis + local cache flush) |
| TLS | Certificate expiry and chain health | Live (diagnosis only) |
| Disk | Local disk exhaustion | Live (diagnosis only) |
| Backup | Backup verification and DR readiness | Live (diagnosis only) |

### Validation status

The [crisismode-torture](https://github.com/trs-80/crisismode-torture) harness
runs CrisisMode against real degraded infrastructure (PostgreSQL replication,
Redis, 3-node etcd, 3-broker Kafka, Redis Cluster partitions, cascading
failures, and real AWS RDS/S3/DynamoDB). What it currently proves:

- **Validated:** failure detection (typically 3–5s), AI diagnosis, and dry-run
  recovery planning against real infrastructure, including real AWS and Vercel.
- **Execute-verified (as of 2026-07-13):** end-to-end `--execute` recovery —
  a mutating recovery plan that actually ran, plus post-recovery health
  verification confirming the underlying fault was resolved (not just that
  the engine exited without error) — for exactly three scenarios: Redis
  memory pressure, PostgreSQL WAL-replay-paused replication lag, and
  PostgreSQL connection-pool exhaustion. All three are reproducible via the
  crisismode-torture harness.
- **Not yet validated:** end-to-end `--execute` recovery for every other
  agent/scenario in the tables above. Execute mode is functional for
  individual actions, and the engine correctly refuses to run a plan when a
  required live provider is missing (a blocked run is never counted as a
  recovery), but no torture scenario besides the three above has completed a
  full mutating recovery with post-recovery verification — treat the rest as
  experimental until the harness verifies them. AWS and Vercel scenarios
  remain dry-run/skipped in `--execute` mode.

## Building Agents

CrisisMode is extensible through recovery agents. Two contribution tracks:

### Markdown Playbooks (low-code)

Write recovery procedures as Markdown files with YAML frontmatter:

```markdown
---
name: "my-recovery-playbook"
version: "1.0.0"
description: "Recovery for my system"
severity: elevated
tags: [postgresql, replication]
---

### 1. Diagnose the issue
- type: diagnosis_action
- target: primary

### 2. Notify the team
- type: human_notification
- channel: default
```

Validate and test:
```sh
crisismode playbook validate my-playbook.md
crisismode playbook dry-run my-playbook.md
```

See [Playbook Authoring Guide](docs/playbook-authoring.md) for details.

### TypeScript Agents

For complex recovery logic, build agents with the SDK. The types-only SDK lives at [`packages/agent-sdk`](packages/agent-sdk) and is consumed from a repo checkout via the pnpm workspace (`@crisismode/agent-sdk`).

Implement the `RecoveryAgent` interface with `assessHealth()`, `diagnose()`, `plan()`, and `replan()` methods.

See the [Agent Development Guide](docs/guides/creating-a-recovery-agent.md) for a full tutorial.

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

Hub-and-spoke topology: **spokes** (Layers 1-2) run close to target systems and handle execution and safety; the **hub** (Layers 3-4) provides coordination, analytics, and AI enrichment. Recovery actions progress through five escalation levels: observe, diagnose, suggest, repair-safe, and repair-destructive.

See [Architecture Overview](docs/architecture.md) for details.

## Safety Model

- Blast radius validation on every system action
- Pre-mutation state capture (checkpoint before any change)
- Human approval gates for elevated-risk operations
- Dry-run mode by default (reads real systems, logs mutations without executing)
- `--execute` fails closed when confirmation can't be collected (non-interactive stdin)
- Five-level progressive escalation (observe → diagnose → suggest → repair-safe → repair-destructive)
- Immutable forensic record for every execution

## CLI Reference

```bash
crisismode                            # Zero-config health scan (default)
crisismode scan                       # Health scan with scored summary and next-action hints
crisismode diagnose                   # Health check + AI-powered diagnosis (read-only)
crisismode recover                    # Full recovery flow with plain-English AI summaries
crisismode status                     # Quick health probe
crisismode ask "<question>"           # Natural language AI diagnosis
crisismode ask                        # Interactive diagnostic REPL
crisismode demo                       # Simulator demo mode
crisismode init                       # Generate crisismode.yaml configuration
crisismode init --agent <name>        # Scaffold a check plugin
crisismode webhook                    # Start webhook receiver for AlertManager
crisismode watch                      # Continuous shadow observation
crisismode readiness                  # Scale-readiness report (read-only): will this stack break under load, and where are the capacity ceilings? See docs/readiness.md

crisismode bundle ingest <path|->     # Ingest an SRE evidence bundle (v1) for AI diagnosis
crisismode bundle respond <path|->    # Emit AdapterResponse v1 ("-" reads from stdin)
crisismode bundle execute <path|->    # Translate a bundle to a RecoveryPlan (dry-run)

crisismode playbook list              # List discovered playbooks
crisismode playbook validate <path>   # Validate a playbook file
crisismode playbook dry-run <path>    # Preview compiled recovery plan

crisismode agent list                 # List all registered agents
crisismode agent info <name>          # Show agent details

crisismode registry list              # List available check plugins
crisismode registry search <query>    # Search check plugins
crisismode registry install <name>    # Install a check plugin

crisismode mcp                        # Start MCP server on stdio (read-only diagnosis tools)

crisismode completions bash|zsh|fish  # Generate shell completions
```

Output modes: `--json` for machine-readable output, plain text auto-detected when piped, colored TTY output by default.

### JSON output format

The `--json` flag emits **JSON lines** (one JSON object per line), not a single JSON document. Each line has a `type` field indicating the data it carries:

| Type | Description |
|---|---|
| `health` | Health assessment with `status` and `signals` array |
| `diagnosis` | AI-powered diagnosis with `scenario`, `confidence`, and root cause |
| `plan` | Recovery plan with `steps` array |

Example usage:

```bash
# Pipe to jq for human-readable inspection
crisismode recover --target my-db --json | jq 'select(.type == "diagnosis")'

# Extract just the plan steps
crisismode recover --target my-db --json | jq 'select(.type == "plan") | .plan.steps'
```

## Evidence Bundles

CrisisMode speaks the SRE evidence-bundle v1 format, so external incident tooling can hand it a bundle of evidence (logs, metrics, operator notes) and get back a ranked diagnosis with policy-checked recovery actions:

- `bundle ingest` — read-only AI diagnosis of the evidence
- `bundle respond` — full AdapterResponse v1: ranked hypotheses with evidence citations, proposed actions gated by action-class policy, and explicit abstention when evidence is insufficient
- `bundle execute` — translate a bundle into a validated RecoveryPlan (dry-run)

All three accept a file path or `-` for stdin, making them easy to wire into pipelines:

```bash
cat incident-bundle.json | crisismode bundle respond -
```

## MCP Server

`crisismode mcp` starts a [Model Context Protocol](https://modelcontextprotocol.io) server on stdio, so AI agents (Claude Code, Claude Desktop, or any MCP client) can diagnose your infrastructure directly:

```bash
# Claude Code
claude mcp add crisismode -- crisismode mcp
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "crisismode": { "command": "crisismode", "args": ["mcp"] }
  }
}
```

Every MCP tool is read-only — the MCP surface never mutates infrastructure:

| Tool | What it does |
|---|---|
| `crisismode_scan` | Zero-config health scan with a 0–100 score and per-service findings |
| `crisismode_diagnose` | Health assessment + diagnosis for one target (AI-powered with `ANTHROPIC_API_KEY`, rule-based otherwise) |
| `crisismode_status` | Quick UP/DOWN probe of configured or detected services |
| `crisismode_list_agents` | The built-in recovery agent roster |
| `crisismode_bundle_ingest` | Read-only diagnosis of an SRE evidence bundle (v1) |
| `crisismode_bundle_respond` | Ranked hypotheses with evidence citations and policy-gated proposed actions |
| `crisismode_bundle_plan` | Translate a bundle into a dry-run RecoveryPlan (returned, never executed) |
| `crisismode_readiness` | Forward-looking scale-readiness report: connection headroom, pooling, indexes, slow queries; includes capacity ceilings and a conditional weak-link verdict — see [docs/readiness.md](docs/readiness.md) |

## Check Plugin Ecosystem

CrisisMode consumes external health checks through a unified adapter layer, making thousands of existing checks available without rewriting them:

- **Native check plugins** — JSON wire protocol for purpose-built CrisisMode checks
- **Nagios/Icinga/Checkmk plugins** — thousands of battle-tested infrastructure checks
- **Goss YAML health assertions** — declarative system state validation
- **Sensu checks** — Graphite, InfluxDB, OpenTSDB, and Prometheus metric formats

See [docs/guides/creating-a-check-plugin.md](docs/guides/creating-a-check-plugin.md) for the check plugin authoring guide.

## Contributing

Domain experts contribute recovery knowledge as agents, playbooks, and check plugins — the framework handles safety, validation, and execution.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution workflows and [GETTING_STARTED.md](GETTING_STARTED.md) for developer setup.

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
