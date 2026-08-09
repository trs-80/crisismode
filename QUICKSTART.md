# Quick Start

Running CrisisMode against your own stack, from nothing to a useful answer. No
configuration required to start.

> **Want to build or modify CrisisMode instead?** That's
> [GETTING_STARTED.md](GETTING_STARTED.md) — clone, build, test environment,
> project layout. This guide is about *using* the CLI.

## Install

Grab a prebuilt binary — no Node.js needed:

```bash
# macOS (Apple Silicon); see README for other platforms
curl -fsSL https://github.com/trs-80/crisismode/releases/latest/download/crisismode-darwin-arm64 -o crisismode
chmod +x crisismode
```

Put it on your `PATH`, then optionally enable tab completion:

```bash
crisismode completions zsh    # or bash, fish
```

Running from a source checkout instead? Use `node dist/cli/index.js` in place of
`crisismode` after `pnpm install && pnpm run build`.

## Your first scan

CrisisMode auto-detects services on the machine and checks whatever it finds:

```bash
crisismode
```

`scan` is the default command, so bare `crisismode` and `crisismode scan` do the
same thing.

```text
  Scanning for services...
  Detected services:
    ✓ postgresql at localhost:5432
    ✓ dns at localhost:53

  Running health checks on 7 target(s)...

  System Health Score: 100/100
  Scanned at 2026-08-09T15:09:00.480Z (586ms)

  HEALTHY
  PG-001      OK postgresql (default-postgres) — PostgreSQL replication is healthy.
                 All replicas are streaming and worst replay lag is 0s.
  DNS-002     OK dns (local-dns) — DNS resolution is healthy. All configured
                 resolvers are reachable and returning consistent answers.
  DISK-003    OK disk (local-disk) — Disk usage is healthy. All filesystems have
                 sufficient free space and inodes.
```

No config file needed. The scan:

- TCP-probes common ports for databases, caches, and brokers
- Picks up LLM providers from environment variables (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`)
- Scores overall health 0–100
- Suggests a next command for anything it flags

Findings from best-effort agents are labelled as such in the output — they're
leads, not conclusions. [docs/coverage.md](docs/coverage.md) explains which is
which and why.

### What gets detected without config

These ports are probed by default:

| Service | Port |
|---|---|
| PostgreSQL | 5432 |
| Redis | 6379 |
| etcd | 2379 |
| Kafka | 9092 |
| Kubernetes | 6443 |
| Ceph | 6789 |
| Flink | 8081 |
| DNS | 53 |
| RabbitMQ / AMQP | 5672 |

Check plugins are discovered from `~/.crisismode/checks/`, `./checks/`, or
`$CRISISMODE_CHECK_PATH`. The prebuilt binary ships none — the example plugins
(disk usage, memory, DNS resolution, HTTP endpoint, certificate expiry, plus
Nagios/Goss/Sensu adapter samples) live in `checks/` in a repo checkout, so
you'll see them when running from source or after copying them into
`~/.crisismode/checks/`.

## Drill into a finding

Scan findings are labelled by target — `PG-001` above is the PostgreSQL target
`default-postgres`. To investigate one, pass the **target name**:

```bash
crisismode diagnose default-postgres
# equivalently
crisismode diagnose --target default-postgres
```

> Note: `diagnose` resolves its positional argument as a *target name*, not a
> finding id, so `crisismode diagnose PG-001` returns
> `Target "PG-001" not found in config` followed by the names you can use.
> Check-plugin findings are the exception — `PLUG-<n>` ids are routed straight to
> the plugin's diagnose verb, so `crisismode diagnose PLUG-002` works as written.
> Scan's own "Investigate:" suggestion accounts for both.

For infrastructure agents this connects to the live service and runs AI-powered
analysis when `ANTHROPIC_API_KEY` is set, falling back to rule-based diagnosis
otherwise:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
crisismode diagnose --target default-postgres
```

`diagnose` is read-only. It never mutates anything.

## Three questions before you touch anything

These are the commands worth reaching for first during an actual incident,
because all three are read-only and fast.

**Is it me, my network, or them?**

```bash
crisismode triage
```

Works offline. Walks outward from local interfaces → gateway → DNS → captive
portal → internet → your configured targets, and tells you which layer broke.
Exits 1 when the cause is local, network, or mixed — so it works in a script.

**Is it down for everyone, or just me?**

```bash
crisismode down stripe github
```

Keeps two facts separate: what the provider's status page says, and whether this
machine can actually reach it. A status-page hiccup is never reported as an
outage. Exits 1 if anything looks down.

**Will this break under load?**

```bash
crisismode readiness
```

Forward-looking and read-only: connection headroom, pooling, missing indexes,
slow queries, pgvector index health, plus honest capacity ceilings. It reports
`unknown` rather than guessing — see [docs/readiness.md](docs/readiness.md).

## Add a config file

For non-default ports, remote hosts, or credentials:

```bash
crisismode init
```

That writes `crisismode.yaml`. Point it at your infrastructure:

```yaml
apiVersion: crisismode/v1
kind: SiteConfig
metadata:
  name: my-environment
  environment: production
targets:
  - name: primary-db
    kind: postgresql
    primary:
      host: db.internal
      port: 5432
    replicas:
      - host: db-replica.internal
        port: 5432
    credentials:
      type: env
      usernameVar: PG_USER
      passwordVar: PG_PASSWORD
```

Credentials are always read from environment variables or K8s Secrets at runtime
— never stored in the config file.

### Third-party services

A `services:` list works on its own, with no `targets:` block. Bare
`crisismode down` then checks all of them:

```yaml
services:
  - stripe
  - github
  - example.com        # raw domain — reachability only, no known status page
```

### AWS targets

```yaml
targets:
  - name: s3-backups
    kind: aws-s3
    aws:
      bucket: my-backup-bucket
      region: us-east-1

  - name: orders-table
    kind: aws-dynamodb
    aws:
      table: orders
      region: us-east-1

  - name: prod-rds
    kind: aws-rds
    aws:
      instance_id: prod-postgres
      region: us-east-1
```

Credentials resolve through the standard AWS SDK chain — environment variables,
`~/.aws/credentials`, IAM roles, IRSA. The AWS agents are best-effort: diagnosis
has been validated in dry-run against real AWS, but no execute path has been
verified.

Then `crisismode scan` picks the config up automatically.

## Recovery

```bash
crisismode recover              # dry-run: reads live systems, plans, executes nothing
crisismode recover --execute    # actually runs recovery actions
```

Dry-run is the default and you always see the plan first. Before trusting
`--execute` against anything you care about, read
[docs/coverage.md](docs/coverage.md) — end-to-end mutating recovery is verified
for exactly three scenarios today, and everything else should be treated as
experimental.

To watch the whole pipeline safely, run the simulator:

```bash
crisismode demo
```

That walks a PostgreSQL replication lag cascade from trigger through diagnosis,
plan, validation, execution, and forensic record — entirely in memory.

## Output for scripts and pipelines

```bash
crisismode scan --json          # JSON Lines, one object per line
crisismode scan | cat           # plain tab-separated (auto-detected when piped)
crisismode scan --terse         # drop the plain-language explanations
```

```bash
crisismode readiness --json | jq 'select(.type == "readiness") | .verdict'
```

Field-by-field format contracts are in
[docs/cli-reference.md](docs/cli-reference.md#output-modes).

## Where to go next

| Goal | Go to |
|---|---|
| Look up any command, flag, or exit code | [docs/cli-reference.md](docs/cli-reference.md) |
| Know what's actually been validated | [docs/coverage.md](docs/coverage.md) |
| Let Claude or another AI client drive it | [MCP server](docs/cli-reference.md#mcp-server) |
| Receive Prometheus AlertManager alerts | `crisismode webhook` |
| Monitor continuously | `crisismode watch` |
| Ask in plain English | `crisismode ask "why is my database slow"` |
| Write a recovery procedure | [Playbook Authoring](docs/playbook-authoring.md) |
| Build or modify CrisisMode | [GETTING_STARTED.md](GETTING_STARTED.md) |
