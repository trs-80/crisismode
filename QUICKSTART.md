# Quick Start

Get CrisisMode running in under 5 minutes. No configuration required.

## Prerequisites

- **Node.js** >= 18
- **pnpm** — `npm install -g pnpm`

## Install

```bash
git clone https://github.com/trs-80/crisismode.git
cd crisismode
pnpm install
pnpm run build
```

## Run your first scan

CrisisMode auto-detects services on your machine and checks what it finds:

```bash
node dist/cli/index.js scan
```

No config file needed. The scan:
- Probes common ports for databases, caches, and message brokers
- Runs bundled check plugins (disk, memory, DNS, HTTP, TLS certificates)
- Scores overall system health 0–100
- Suggests a next command for anything it finds

Example output:

```
  System Health Score: 83/100
  Scanned at 2026-03-18T16:47:28.181Z (52ms)

  ID            Service             Status        Level     Summary
  --------------------------------------------------------------------------------
  PLUG-001      plugin (check-certificate-expiry)UNKNOWN       Diagnose  Could not connect to localhost:443
  PLUG-002      plugin (check-disk-usage)OK            Observe   Disk usage normal, max 45%
  PLUG-003      plugin (check-dns-resolution)OK            Observe   DNS resolution healthy
  PLUG-004      plugin (check-http-endpoint)UNKNOWN       Diagnose  Endpoint unreachable
  PLUG-005      plugin (check-memory-usage)OK            Observe   Memory usage normal at 53%

  → Run `crisismode diagnose PLUG-001` to investigate plugin (check-certificate-expiry)
```

## Drill into a finding

The scan tells you what to run next. Copy the suggested command:

```bash
node dist/cli/index.js diagnose PLUG-002
```

For check plugins this runs the plugin's diagnose verb — a deeper inspection that lists individual findings with severity levels:

```
  Plugin: check-disk-usage

  ✓ Healthy: All partitions below 70% usage
```

For infrastructure agents (PostgreSQL, Redis, etcd, etc.), diagnose connects to the live service and runs AI-powered analysis if you have an `ANTHROPIC_API_KEY` set:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
node dist/cli/index.js diagnose --target my-postgres
```

## What services can CrisisMode detect?

Without any configuration, `scan` probes these ports:

| Service      | Port  |
|-------------|-------|
| PostgreSQL   | 5432  |
| Redis        | 6379  |
| etcd         | 2379  |
| Kafka        | 9092  |

It also runs these bundled check plugins automatically:

| Plugin                    | What it checks                          |
|--------------------------|----------------------------------------|
| check-disk-usage          | Filesystem usage (warns at 80%, critical at 90%) |
| check-memory-usage        | System memory utilization               |
| check-dns-resolution      | DNS resolver health                     |
| check-http-endpoint       | HTTP connectivity to localhost           |
| check-certificate-expiry  | TLS certificate validity on localhost:443 |

## Add a config file (optional)

For non-default ports or remote hosts, generate a config:

```bash
node dist/cli/index.js init
```

This creates `crisismode.yaml`. Edit it to point at your infrastructure:

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

Then scan picks it up automatically:

```bash
node dist/cli/index.js scan
```

## Recovery (dry-run by default)

When scan finds an unhealthy service, step through the full recovery flow:

```bash
# Dry-run — reads from live systems, plans recovery, but does not execute
node dist/cli/index.js recover

# Execute mode — actually runs recovery actions
node dist/cli/index.js recover --execute
```

Dry-run is the default. You always see the plan before anything is executed.

## Demo mode

See the full recovery pipeline with simulated data — no infrastructure needed:

```bash
node dist/cli/index.js demo
```

Walks through a PostgreSQL replication lag cascade: trigger → diagnosis → plan → validation → execution → forensic record.

## Output modes

```bash
# Machine-readable JSON (pipe to jq, scripts, dashboards)
node dist/cli/index.js scan --json

# Disable color (auto-detected when piping)
node dist/cli/index.js scan | cat
```

## What's next

- `node dist/cli/index.js ask "why is my database slow"` — natural language diagnosis
- `node dist/cli/index.js watch` — continuous health monitoring
- `node dist/cli/index.js webhook` — receive alerts from Prometheus AlertManager
- See [GETTING_STARTED.md](GETTING_STARTED.md) for the full development setup
