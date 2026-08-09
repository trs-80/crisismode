# CrisisMode

[![CI](https://github.com/trs-80/crisismode/actions/workflows/ci.yml/badge.svg)](https://github.com/trs-80/crisismode/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/trs-80/crisismode/graph/badge.svg)](https://codecov.io/gh/trs-80/crisismode)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-%3E%3D22-green?logo=node.js&logoColor=white)](https://nodejs.org/)

**Monitoring tells you something is wrong. CrisisMode tells you what to do about it — safely.**

CrisisMode diagnoses infrastructure failures, builds validated recovery plans with
blast-radius controls, and executes them under human-in-the-loop oversight. Every
mutation is preceded by a state capture. Every execution leaves an immutable
forensic record.

It is built for the moment when infrastructure is degraded and the cost of a wrong
action is highest — which is also why it reports what it *hasn't* verified. See
[Maturity and validation](#maturity-and-validation).

**Website:** [crisismode.ai](https://crisismode.ai)

## Who it's for

- **SREs and platform engineers** who get paged and need to act under pressure.
- **AI app builders** running managed infrastructure without deep ops backup.
- **On-call engineers** who inherit systems they didn't build.
- **Domain experts** — DBAs, Kafka and storage specialists — who want to codify
  recovery knowledge as something executable instead of a wiki page.

## Install

Prebuilt binaries need no Node.js. macOS builds are codesigned and notarized, and
every artifact ships a SHA256 checksum.

```bash
# Linux (x64)
curl -fsSL https://github.com/trs-80/crisismode/releases/latest/download/crisismode-linux-x64 -o crisismode

# macOS (Apple Silicon)
curl -fsSL https://github.com/trs-80/crisismode/releases/latest/download/crisismode-darwin-arm64 -o crisismode

chmod +x crisismode && ./crisismode scan
```

Also built: `crisismode-linux-arm64`, `crisismode-darwin-x64`. To verify a
download, fetch the matching `.sha256` and run `shasum -a 256 -c`. Building from
source needs Node.js >= 22 — see [GETTING_STARTED.md](GETTING_STARTED.md).

## 60-second demo

No config, no infrastructure. CrisisMode autodiscovers what's running locally and
checks it:

```bash
crisismode                 # zero-config health scan (the default command)
```

```
  System Health Score: 100/100
  Scanned at 2026-08-09T15:09:00.480Z (586ms)

  HEALTHY
  PG-001      OK postgresql (default-postgres) — PostgreSQL replication is healthy.
  DNS-002     OK dns (local-dns) — DNS resolution is healthy.
  DISK-003    OK disk (local-disk) — Disk usage is healthy.
```

Three questions it answers without touching your infrastructure:

```bash
crisismode triage          # is it me, my network, or them?  (exit 1 on local/network)
crisismode down stripe     # is it down for everyone, or just me?
crisismode readiness       # will this stack break under load?
```

Then the full pipeline against a simulator — trigger → diagnosis → plan →
validation → execution → forensic record:

```bash
crisismode demo
```

Recovery is **dry-run by default**. `crisismode recover` reads live systems and
shows you the plan; mutations require an explicit `--execute`.

## From alert to recovery

Live mode against real PostgreSQL replication lag (local podman test
environment), abridged:

```
  Phase 3: Diagnosis (Live — AI-Powered)
  🤖 AI analyzing system state...
     Scenario:    replication_lag_cascade
     Confidence:  94%
     Root cause:  WAL replay paused on replica — sent LSN is advancing
                  but replay LSN is static, indicating a deliberate pause
                  or I/O bottleneck on the replica, not a network issue.

  Phase 4: Plan Creation
     #   Type                    Risk        Name
     1   diagnosis_action        —           Assess replication lag
     2   human_notification      —           Notify on-call DBA
     3   checkpoint              —           Pre-recovery state capture
     4   system_action           elevated    Disconnect lagging replica
     7   human_approval          —           Approve resynchronization
     8   system_action           high        pg_basebackup + resync
    10   human_notification      —           Recovery summary

  Phase 7: Execution (Live — EXECUTE MODE)
     Step step-004 [system_action]
     ✓ Precondition: Replica 10.89.0.5/32 is currently connected
     ✓ Success: WAL sender for 10.89.0.5/32 is no longer present
     ● SUCCESS (6ms)
```

## Safety model

- Dry-run by default — reads real systems, logs mutations without running them.
- Pre-mutation state capture on every `elevated`-or-higher action.
- Blast-radius validation against the agent's declared manifest.
- Human approval gates; `--execute` fails closed when confirmation can't be
  collected (non-interactive stdin).
- Five escalation levels: observe → diagnose → suggest → repair-safe →
  repair-destructive.
- Immutable forensic record per execution, and a rollback strategy on every plan.

These are enforced by the plan validator, not by convention — see
[docs/architecture.md](docs/architecture.md).

## Maturity and validation

CrisisMode registers more agents than it has validated against real
infrastructure, and it says so at runtime rather than in a footnote. Its honesty
layer collapses every agent to one of two labels:

- **live-validated** — exercised against a real deployment of that system.
- **best-effort** — the checks exist and run, but have never been proven against
  a live system. Findings are leads, not conclusions. This is the default; an
  agent has to earn the other label.

Ask the tool directly — this is the authoritative roster, not this README:

```bash
crisismode agent list      # 26 registrations, each with its maturity label
```

Today **9 of 26** registrations are live-validated: PostgreSQL replication,
Kubernetes, DNS, TLS, disk, backup verification, third-party service status, and
the LLM-provider agent for Anthropic and OpenAI (it registers once per provider).
Everything else — Redis, etcd, Kafka, Ceph, Flink, AWS (S3/DynamoDB/RDS),
Terraform drift, deploy rollback, DB migration, queue backlog, config drift,
vector stores, AI-provider failover — is best-effort.

Separately, end-to-end `--execute` recovery (a mutating plan that ran, plus
post-recovery verification that the fault was actually gone) is proven for
**exactly three scenarios** as of 2026-07-13, all reproducible in the
[crisismode-torture](https://github.com/trs-80/crisismode-torture) harness:
Redis memory pressure, PostgreSQL WAL-replay-paused replication lag, and
PostgreSQL connection-pool exhaustion. Treat every other execute path as
experimental. AWS and Vercel scenarios remain dry-run only.

Full per-system coverage tables and what each harness proves:
**[docs/coverage.md](docs/coverage.md)**.

## Extending it

Two contribution tracks, depending on whether your recovery knowledge is a
procedure or a decision tree:

| Track | You write | Good for |
|---|---|---|
| **Playbook** | Markdown + YAML frontmatter | A runbook with fixed steps |
| **Agent** | TypeScript implementing `RecoveryAgent` | Diagnosis that builds different plans for different failures |

Playbooks compile to the same `RecoveryPlan` the engine runs for code-based
agents, through the same validator — no shortcuts, no second safety path.

```bash
crisismode playbook validate my-playbook.md
crisismode playbook dry-run my-playbook.md
```

Check plugins are a third, smaller entry point: a shell script that probes a
system and reports health on a JSON wire protocol. CrisisMode also adapts
existing Nagios/Icinga/Checkmk plugins, Goss assertions, and Sensu checks, so
established checks work without a rewrite.

- [Playbook Authoring Guide](docs/playbook-authoring.md)
- [Your First Agent](docs/guides/your-first-agent.md) · [Agent reference](docs/guides/creating-a-recovery-agent.md)
- [Your First Check Plugin](docs/guides/your-first-check-plugin.md) · [Check plugin reference](docs/guides/creating-a-check-plugin.md)

## Works with your tools

**MCP server** — `crisismode mcp` exposes 8 read-only diagnosis tools over stdio,
so Claude Code or any MCP client can inspect your infrastructure. The MCP surface
never mutates anything.

```bash
claude mcp add crisismode -- crisismode mcp
```

**Evidence bundles** — CrisisMode speaks the SRE evidence-bundle v1 format, so
external incident tooling can hand it logs, metrics, and operator notes and get
back ranked hypotheses with policy-gated actions. Reads a path or stdin:

```bash
cat incident-bundle.json | crisismode bundle respond -
```

**Pipelines** — `--json` emits JSON lines; plain tab-separated output is
auto-detected when stdout isn't a TTY.

```bash
crisismode recover --target my-db --json | jq 'select(.type == "diagnosis")'
```

Full command list, flags, exit codes, and output-format contracts:
**[docs/cli-reference.md](docs/cli-reference.md)**.

## Deployment

```bash
helm install crisis-spoke deploy/helm/crisismode-spoke/ \
  --set hub.endpoint=https://hub.crisismode.ai \
  --set postgresql.primary.host=my-pg-primary \
  --set postgresql.primary.credentialsSecret=pg-credentials \
  --set targetNamespaces='{default,production}'
```

Spokes (Layers 1–2) run close to target systems and own execution and safety;
the hub (Layers 3–4) adds coordination, analytics, and AI enrichment. A spoke
runs in 256Mi and keeps working when the hub is unreachable.

## Documentation

| If you want to… | Read |
|---|---|
| Use the CLI on your own stack | [QUICKSTART.md](QUICKSTART.md) |
| Build and hack on CrisisMode | [GETTING_STARTED.md](GETTING_STARTED.md) |
| Contribute an agent or playbook | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Understand the design | [docs/architecture.md](docs/architecture.md) |
| Look up a command or output format | [docs/cli-reference.md](docs/cli-reference.md) |
| Know what's actually validated | [docs/coverage.md](docs/coverage.md) |
| Check scale readiness | [docs/readiness.md](docs/readiness.md) |

Specifications: [Recovery Agent Contract](specs/foundational/recovery-agent-contract.md)
(authoritative) · [Deployment & Operations](specs/deployment/operations.md) ·
[Plugin Platform](specs/architecture/plugin-platform.md) ·
[Operator Health & AI Services](specs/architecture/operator-health-and-ai-services.md)

## License

Apache 2.0 for everything in this repo — spoke runtime, agent SDK, specs, and
test infrastructure. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The hub API,
coordination service, and management UI are commercial and not part of this
repository.
