# Getting Started (Development)

Setting up a CrisisMode development environment — first clone through running
agents against real degraded PostgreSQL.

> **Just want to use the CLI?** That's [QUICKSTART.md](QUICKSTART.md) — install a
> binary and scan your stack. This guide is about building and modifying
> CrisisMode itself.
>
> **Ready to contribute?** [CONTRIBUTING.md](CONTRIBUTING.md) covers the
> contribution tracks, code standards, and PR expectations.

## Prerequisites

- **Node.js** >= 22 (recommended: [fnm](https://github.com/Schniz/fnm) or
  [nvm](https://github.com/nvm-sh/nvm)) — Node 18 and 20 are end-of-life; CI
  tests 22 and 24
- **pnpm** — install the version pinned by `packageManager` in `package.json`
  (currently `pnpm@10.30.3`): `npm install -g pnpm@10.30.3`. A bare
  `npm install -g pnpm` gets the latest release instead, which can resolve the
  lockfile differently than CI — CI takes its version from that same
  `packageManager` field
- **Podman** — for the containerized test environment:
  `brew install podman && podman machine init && podman machine start`
- **Git** — `git clone git@github.com:trs-80/crisismode.git`

Optional, but the pre-commit hooks want them:

- **shellcheck** — `brew install shellcheck` (lints staged `.sh` files)
- **gitleaks** — `brew install gitleaks` (secret scanning)

## First-time setup

```bash
cd crisismode
pnpm install          # also installs husky pre-commit hooks via `prepare`
pnpm run build        # compiles to dist/, including the agent-sdk workspace
```

Verify the toolchain:

```bash
pnpm run typecheck    # tsc --noEmit
pnpm test             # vitest unit tests
pnpm run lint         # eslint
```

Then run the in-memory demo — no database or infrastructure required:

```bash
pnpm dev
```

That walks the full recovery pipeline for a PostgreSQL replication lag cascade:
trigger → diagnosis → plan → validation → execution → forensic record.

To run the CLI from source without building:

```bash
npx tsx src/cli/index.ts scan
npx tsx src/cli/index.ts agent list
```

## The test environment

Real PostgreSQL with streaming replication, Prometheus, AlertManager, and a mock
hub API.

```bash
./test/podman/scripts/start.sh     # start
./test/podman/scripts/status.sh    # check
./test/podman/scripts/stop.sh      # tear down
```

`start.sh` pulls images and brings up:

| Service | Where | Notes |
|---|---|---|
| PostgreSQL primary | `localhost:5432` | user `crisismode`, password `crisismode` |
| PostgreSQL replica | `localhost:5433` | streaming replication from primary |
| Prometheus | `http://localhost:9090` | scraping PG metrics |
| AlertManager | `http://localhost:9093` | webhooks to `localhost:3000` |
| postgres_exporter | `http://localhost:9187` | |
| Mock Hub API | `http://localhost:8080` | |

Validate it came up correctly:

```bash
./test/smoke/run-all.sh                 # services, replication, metrics, hub API
./test/smoke/test-failure-injection.sh   # inject, verify, reset round-trip
./test/smoke/test-alert-pipeline.sh      # AlertManager → spoke webhook path
```

Each script prints a `passed/total` tally at the end.

### Injecting real failures

These create genuinely degraded states in the test PostgreSQL — not mocks:

```bash
./test/failures/inject-replication-lag.sh      # pause WAL replay → growing lag
./test/failures/inject-connection-flood.sh     # 200 idle connections
./test/failures/inject-long-queries.sh         # hold row locks + expensive scans
./test/failures/inject-slot-overflow.sh        # abandoned slot accumulating WAL
./test/failures/inject-pgvector-unindexed.sh   # vector column with no ANN index
./test/failures/reset.sh                       # restore everything to healthy
./test/failures/reset-pgvector.sh              # undo just the pgvector injection
```

### Running against real PostgreSQL

```bash
pnpm run live                    # dry-run: reads real PG, logs mutations
pnpm run live -- --execute       # execute mode: runs real SQL mutations

# A useful loop:
./test/failures/inject-replication-lag.sh && pnpm run live
```

### Webhook receiver

```bash
pnpm run webhook                 # dry-run, listens on :3000
pnpm run webhook --execute       # execute mode

# Inject lag; AlertManager fires an alert at the spoke
./test/failures/inject-replication-lag.sh
```

## Project layout

### CLI (`src/cli/`)

`src/cli/index.ts` is the entry point. Commands live in `src/cli/commands/`.
Supporting modules: `detect.ts` (port probing), `autodiscovery.ts` (zero-config
agent detection), `output.ts` (structured output), `errors.ts` (error
formatting), `status-presentation.ts` (single source for status → presentation
mappings), `visibility.ts` (coverage and maturity reporting).

Full command surface: [docs/cli-reference.md](docs/cli-reference.md).

### Framework (`src/framework/`)

| File | Purpose |
|---|---|
| `engine.ts` | `LegacyExecutionEngine` — sequential step execution, dry-run vs execute |
| `graph-engine.ts` | `RecoveryGraphEngine` — LangGraph-based, supports checkpoint/resume |
| `backend.ts` | `ExecutionBackend` contract shared by all backends |
| `safety.ts` | State capture, blast-radius validation |
| `validator.ts` | Validates plans against agent manifests and safety rules |
| `coordinator.ts` | Human approval logic (trust + catalog driven) |
| `catalog.ts` | Pre-authorized action catalog matching |
| `forensics.ts` | Forensic record assembly and persistence |
| `escalation.ts` | The five-level progressive escalation model |
| `agent-maturity.ts` | Collapses manifest maturity to the two labels operators see |
| `capability-registry.ts` | Registry of standard recovery capabilities |
| `provider-registry.ts` | Resolves capability providers for plan steps |
| `symptom-router.ts` | Routes symptoms to the appropriate agent |
| `root-cause-synthesis.ts` | Correlation clustering (the rule set is frozen — see CONTRIBUTING) |
| `ai-diagnosis-universal.ts` | Universal AI-powered diagnosis for any agent |
| `operator-summary.ts` | Operator-facing health and readiness summaries |
| `incident-report.ts` | Structured incident report generation |
| `network-profile.ts` | Network diagnostics and profiling |
| `triage.ts` / `triage-probes.ts` | Offline layered localization and verdict synthesis |
| `service-status/` | Third-party status checker — status page + reachability, never conflated |
| `guidance/` | Static `RemediationGuide` registry for console-only fixes |
| `hooks/` | 9-point lifecycle hook system |
| `playbook/` | Markdown playbook parser, runtime, discovery |
| `registry/` | Agent plugin discovery and manifest handling |
| `hub-client.ts` | Spoke ↔ hub communication |

`src/readiness/` holds the scale-readiness rule registry and capacity ceilings —
see [docs/readiness.md](docs/readiness.md).

### Agents (`src/agent/`)

Every agent follows the same six-file pattern:

```text
src/agent/<system>/
  backend.ts        # Interface both simulator and live client implement
  simulator.ts      # In-memory implementation for demos and tests
  live-client.ts    # Real infrastructure client
  manifest.ts       # Capabilities, risk profile, triggers, maturity
  agent.ts          # RecoveryAgent implementation
  registration.ts   # Lazy factory for the agent registry
```

`src/config/builtin-agents.ts` is the authoritative roster. For the live list
with maturity labels, ask the CLI:

```bash
crisismode agent list      # 26 registrations
crisismode agent info postgresql-replication-recovery
```

**Do not duplicate that roster in prose.** Which agents are validated versus
best-effort is tracked in one place: [docs/coverage.md](docs/coverage.md).
`src/agent/pg-replication/` is the reference implementation — read it first.

### Types (`src/types/`)

Public types are defined in `packages/agent-sdk` (zero runtime dependencies) and
re-exported from `src/types/index.ts`. Key ones:

- `RecoveryPlan` — steps, impact analysis, rollback strategy
- `RecoveryStep` — the 7 step types
- `AgentManifest` — capability and risk declaration, including `plugin.maturity`
- `ForensicRecord` — immutable audit trail
- `AgentContext` — trigger, topology, trust levels, policies
- `HealthAssessment` / `OperatorSummary` — health and operator-facing readiness
- `PluginKind` / `PluginMaturity` / `CapabilityProviderDescriptor` — plugin types

## Pre-commit hooks

All hooks run on `git commit`. Bypass with `--no-verify` only for genuine WIP.

| Hook | Checks |
|---|---|
| TypeScript typecheck | `tsc --noEmit` on staged `.ts` files |
| gitleaks | Secrets (API keys, tokens, passwords) |
| Sensitive files | Blocks `.pem`, `.key`, `.p12`, `.env`, `kubeconfig`, `tfstate` |
| shellcheck | Staged `.sh` files |
| Large files | Blocks files >1MB |
| Conflict markers | Leftover `<<<<<<<` / `>>>>>>>` |
| Conventional commits | Commit message format |

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):
`type(scope): description`, where type is one of `feat`, `fix`, `docs`, `style`,
`refactor`, `test`, `chore`, `ci`, `perf`, `build`.

## Command reference

```bash
pnpm dev                              # Demo mode (simulated)
pnpm run live                         # Live mode against test PG (dry-run)
pnpm run live -- --execute            # Live mode with mutations
pnpm run webhook                      # Start webhook receiver
pnpm test                             # Unit tests (vitest)
pnpm run test:watch                   # Tests in watch mode
pnpm run test:coverage                # Tests with coverage
pnpm run test:cli                     # CLI smoke test
pnpm run typecheck                    # TypeScript check
pnpm run lint                         # ESLint  (lint:fix to autofix)
pnpm run build                        # Compile to dist/
pnpm run build:bundle                 # esbuild single-file bundle
pnpm run build:binary                 # Standalone binary
pnpm run eval:diagnosis               # Diagnosis eval, writes eval/reports/
pnpm run eval:diagnosis:gate          # Fails below the 13/14 score gate
pnpm run guides:walkthrough           # Generate a remediation-guide checklist
pnpm run guides:apply <checklist>     # Stamp verifiedOn for verified guides
```

Lint-time TypeScript is pinned to 6.0.2 via `.pnpmfile.cjs` because
typescript-eslint does not yet support the TS 7 native compiler; `tsc` itself
stays on TS 7.

## Next steps

- [CONTRIBUTING.md](CONTRIBUTING.md) — contribution tracks, code standards, PR expectations
- [docs/architecture.md](docs/architecture.md) — layers, engines, safety, plugin model
- [Your First Agent](docs/guides/your-first-agent.md) — build an agent start to finish
- [specs/foundational/recovery-agent-contract.md](specs/foundational/recovery-agent-contract.md) — the authoritative contract
