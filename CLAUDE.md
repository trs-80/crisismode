# CLAUDE.md — AI Agent Instructions for CrisisMode

This file provides context and instructions for AI agents (Claude Code, Copilot, Cursor, etc.) working in this repository.

## Project Overview

CrisisMode is an AI crisis recovery framework with a hub-and-spoke architecture. Spokes execute recovery plans close to target systems. The hub provides coordination, analytics, and management. The framework is designed for crisis conditions — when infrastructure is degraded and the cost of wrong actions is highest.

## Architecture

### Layers
- **Layer 1 (Execution)** + **Layer 2 (Safety)** — run in the spoke
- **Layer 3 (Coordination)** + **Layer 4 (Enrichment)** — run in the hub

### Key abstractions
- **RecoveryAgent** (`src/agent/interface.ts`) — the contract every agent implements: `assessHealth()`, `diagnose()`, `plan()`, `replan()`
- **ExecutionBackend** (`src/framework/backend.ts`) — shared contract for execution backends (`executeCommand()`, `evaluateCheck()`, optional `listCapabilityProviders()`)
- **PgBackend / RedisBackend / EtcdBackend / KafkaBackend / K8sBackend / CephBackend / FlinkBackend / DnsBackend / TlsBackend / DiskBackend** — agent-specific backend interfaces that extend ExecutionBackend with system-specific diagnosis methods
- **ExecutionEngine** (`src/framework/engine.ts`) — executes plans step-by-step with safety checks
- **GraphEngine** (`src/framework/graph-engine.ts`) — LangGraph-based graph execution engine for complex recovery workflows
- **SymptomRouter** (`src/framework/symptom-router.ts`) — routes symptoms to the appropriate recovery agent
- **ProviderRegistry** (`src/framework/provider-registry.ts`) — resolves which capability providers can handle each step
- **CapabilityRegistry** (`src/framework/capability-registry.ts`) — global registry of standard recovery capabilities (e.g., `db.query.read`, `db.replica.disconnect`)
- **OperatorSummary** (`src/framework/operator-summary.ts`) — builds human-readable health and readiness summaries for operators
- **Remediation guidance** (`src/framework/guidance/`) — static `RemediationGuide` registry (console steps, CLI equivalent, expected outcome, `verifiedOn`) keyed to readiness rule ids and agent `checkId`s; rendered identically by scan, diagnose, readiness, and recover
- **IncidentReport** (`src/framework/incident-report.ts`) — generates structured incident reports from recovery executions
- **NetworkProfile** (`src/framework/network-profile.ts`) — network diagnostics and profiling
- **AI Diagnosis** (`src/framework/ai-diagnosis-universal.ts`) — universal AI-powered diagnosis for any agent via Claude API
- **ForensicRecorder** — immutable audit trail for every execution

### Agent SDK (`packages/agent-sdk/`)
- All public types are defined in `@crisismode/agent-sdk` and re-exported from `src/types/index.ts`
- Zero runtime dependencies — types only
- Source-of-truth for: RecoveryAgent, ExecutionBackend, AgentManifest, RecoveryPlan, step types, health types
- The main package depends on `@crisismode/agent-sdk` via pnpm workspace

### Playbook System (`src/framework/playbook/`)
- `parser.ts` — Parses Markdown + YAML frontmatter into `ParsedPlaybook` objects
- `runtime.ts` — Converts `ParsedPlaybook` to `RecoveryPlan` (same type the execution engine uses)
- `discovery.ts` — Scans `~/.crisismode/playbooks/`, `./playbooks/`, `CRISISMODE_PLAYBOOK_PATH` for `.md` files
- Playbooks use the same safety infrastructure as code-based agents (no shortcuts)
- Format spec: `specs/foundational/playbook-format.md`

### Hook System (`src/framework/hooks/`)
- `types.ts` — 9 lifecycle hook points (plan:validate, step:before, step:after, etc.)
- `registry.ts` — Priority-ordered, multi-subscriber hook registry with timeout protection
- `builtin.ts` — Built-in hooks for logging and summary (priority 0-99, non-removable)
- Engine integration: optional `HookRegistry` parameter in `LegacyExecutionEngine` constructor

### Agent Plugin Registry (`src/framework/registry/`)
- `types.ts` — `AgentPluginManifest` (crisismode-agent.json schema)
- `local.ts` — Discovery from `~/.crisismode/agents/`, `./agents/`, `CRISISMODE_AGENT_PATH`, `node_modules/@crisismode/`
- Manifest spec: `specs/foundational/registry-manifest.md`

### Execution modes
- `dry-run` — reads from real systems, logs mutations without executing
- `execute` — runs all operations including SQL mutations

## Code Conventions

- **TypeScript** with strict mode, ESM modules (`"type": "module"`)
- **Module resolution:** NodeNext — all imports use `.js` extensions
- **No default exports** — use named exports
- **Async by default** — backend interfaces return `Promise<T>`, engine methods are async
- **Type imports** — use `import type { ... }` for type-only imports

## CLI

The `crisismode` CLI (`src/cli/index.ts`) provides a unified interface with the following commands:

| Command | Description |
|---|---|
| `scan` | Zero-config health scan with scored summary (default when no command given); exit 1 when anything is unhealthy/recovering |
| `diagnose` | Health check + AI-powered diagnosis (read-only); exit 1 when the target is unhealthy/recovering |
| `recover` | Full recovery flow with execution planning |
| `status` | Quick health probe; exit 1 when a configured target is not listening |
| `triage` | Offline localization: is the problem this machine, its network, or the remote services? (exit 1 on local/network/mixed) |
| `down` | Is it down for everyone, or just me? Ad-hoc third-party service check (Stripe, GitHub, an LLM provider, ...); bare invocation uses the config's `services:` list (exit 0/1, 2 on bad usage) |
| `ask` | Natural language AI diagnosis |
| `demo` | Simulator demo mode |
| `init` | Generate `crisismode.yaml` configuration |
| `webhook` | Start webhook receiver for AlertManager |
| `watch` | Continuous shadow observation; `--interval <seconds>` must be a positive integer (no unit suffixes — exit 2) |
| `readiness` | Scale-readiness report (read-only): will this stack break under load? (exit 1 on at-risk/not-ready) |
| `playbook validate` | Validate a playbook file |
| `playbook list` | List discovered playbooks |
| `playbook dry-run` | Preview compiled recovery plan |
| `agent list` | List all registered agents |
| `agent info` | Show agent details |
| `bundle ingest` | Read-only AI diagnosis of an SRE evidence bundle (v1) |
| `bundle respond` | Emit AdapterResponse v1 (ranked hypotheses, policy-gated actions) |
| `bundle execute` | Translate a bundle into a RecoveryPlan (dry-run) |
| `registry list` / `search` / `install` | Discover and install check plugins |
| `mcp` | Start MCP server on stdio — 8 read-only diagnosis tools (`src/mcp/server.ts`); the MCP surface never mutates infrastructure |
| `completions` | Generate bash/zsh/fish shell completions |

### Output Modes

Three output modes are supported:
- **human** (default for TTY): colored, interactive, emoji severity indicators; plain-language explanations on by default (suppress with --terse)
- **pipe** (auto-detected when stdout is not a TTY): plain text, no ANSI, tab-separated
- **machine** (`--json`): structured JSON/JSONL with metadata

### Exit Codes

`src/cli/exit-codes.ts` is the single source of truth. Commands **return** an `ExitCode`; `src/cli/index.ts` is the only place that assigns `process.exitCode`. `process.exit()` is not used anywhere in `src/cli/**` — it truncates buffered stdout mid-write.

| Code | Name | Meaning |
|---|---|---|
| 0 | `OK` | Healthy, or the command did what was asked |
| 1 | `UNHEALTHY` | Ran correctly, the answer is bad news (unhealthy/recovering target, service down, validation failed) |
| 2 | `USAGE` | Called wrong: unknown command or flag, flag missing its value (including an empty `--flag=`), a malformed flag value (e.g. `--interval abc`), missing required subcommand, unknown target name, unreadable file or `--config` argument, config file missing or invalid, or any `CrisisModeError` (`src/cli/errors.ts` — the class carries a user-facing `suggestion`, e.g. "no config found", "`ANTHROPIC_API_KEY` not set") |
| 3 | `INDETERMINATE` | Nothing could be checked — every finding evaluated came back `unknown`. Distinct from 0 because a run that measured nothing is not evidence of health; distinct from 1 because "could not check" is not "broken". Mirrors `src/framework/check-plugin.ts`'s `EXIT_CODE_MAP`, which already ships `3: 'unknown'` to plugin authors (only that row — the plugin contract's 1/2 mean warning/critical) |
| 70 | `INTERNAL` | Unexpected failure inside CrisisMode (sysexits `EX_SOFTWARE`) — distinct from 1 so a script can tell "your infra is broken" from "this tool is broken" |

Per command:

| Command | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| `scan` (and bare `crisismode`) | zero findings, or at least one `healthy` and none bad | any finding `unhealthy`/`recovering` | usage | one or more findings, **all** `unknown` |
| `diagnose` | target healthy | target `unhealthy`/`recovering` | usage; unknown target name or unroutable finding ID | target health `unknown` |
| `readiness` | verdict `ready` | verdict `at-risk`/`not-ready` | usage | verdict `unknown` (no rule could be evaluated) |
| `status` | every configured target reachable | any configured target not listening | usage | — (a TCP probe either connected or did not; there is no `unknown` state to report) |
| `triage` | verdict `healthy`/`remote` | verdict `local`/`network`/`mixed` | usage | — (verdict contract is fixed at 0/1/2) |
| `down` | no failure verdict | ≥1 failure verdict | usage | — (contract is fixed at 0/1/2; `offline_skipped` is already handled as "not evidence") |
| `recover` | the flow completed (dry-run or execute) | — | usage | — |
| `playbook validate` / `dry-run` | valid | fails safety validation | missing/unreadable path | — |
| `agent`, `bundle`, `registry`, `completions`, `init`, `demo`, `webhook`, `ask`, `watch`, `mcp` | success | the requested work failed | usage | — |

**The governing principle: nothing to check → 0. Tried to check and couldn't → 3.**

Code 3 reports a *failure to observe*, never an absence of things to observe. A scan with no targets, `crisismode down` with no `services:` configured, and `--category` matching nothing all had nothing to look at — that is not a failed observation, and the no-config onboarding path already guides it, so they stay 0. A target that was configured, was reached for, and could not be assessed is a failed observation — that is 3. Apply this rule when adding a code to any new command.

Three boundaries in the health-derived codes follow from it, and are tested on both sides (`severityExitCode`, `src/cli/status-presentation.ts`):

- **A definite answer beats "could not check".** `[unhealthy, unknown]` → 1. Something real was measured and it was bad news.
- **Partial `unknown` stays 0.** Nine healthy findings plus one `unknown` → 0. Failing a deploy for one unmeasurable signal is the cliff a separate code exists to avoid; 3 means "nothing at all", not "not everything".
- **Zero findings → 0, not 3.** `[].every()` is vacuously true, so the all-`unknown` test is guarded on a non-empty set. A scan with no findings had nothing to observe, which is a different situation from having targets that could not be observed — and the no-config onboarding path already guides that case. Reporting 3 for `--category nonexistent` would be actively misleading.

An individual `unknown` finding is deliberately **not** a failure: it means "CrisisMode could not check this" (no agent registered for the kind, probe timed out), not "this is broken". Exiting 1 on it would fail every `crisismode && deploy` chain for a service nobody asked CrisisMode to watch.

But a run in which **everything** came back `unknown` is not evidence of health either, and it used to exit 0 — a false green a CI gate would read as "healthy", the same shape as the always-0 `scan` this contract replaced. That case is now exit **3** (`INDETERMINATE`). It matters increasingly: a misconfigured `kafka`/`etcd`/`ceph`/`flink` target yields an `unknown` finding rather than a fabricated one, and an unprobeable resolver yields an `unknown` DNS signal.

Scripts that only care "is it safe to proceed" should test `-eq 0`; scripts that want to distinguish "broken" from "blind" get 1 and 3 separately.

`recover` returns 0 on completion rather than deriving from health: in its default dry-run mode nothing has been fixed yet, so a health-derived code would report failure for a successful preview. Wiring the real execution outcome means changing `runRecovery` in `src/live.ts`.

### Argument Parsing

`src/cli/args.ts` (`parseCli`) is the only parser. The subcommand is the **first positional that is neither a flag nor a flag's value** — so `crisismode --json diagnose` runs `diagnose`, not `scan`. The remainder is parsed with `strict: true` scoped to that subcommand's option set, so an unknown flag, a flag belonging to a different command, or a value-taking flag with a missing/flag-like value is a `USAGE` error naming the token (with the nearest valid command suggested for a near miss).

**Flag values are validated before the command runs.** `--interval <seconds>` (watch) requires a plain positive integer: `parseIntervalSeconds` rejects `abc`, `0`, `-5`, `1.5`, `1e3` and unit suffixes (`30s`, `1m`) with a `USAGE` error. Suffixes are rejected deliberately rather than parsed — the flag is documented in seconds, and the old `parseInt` made `--interval 1m` silently mean *one second* while `--interval abc` produced `NaN`, which survived `watch.ts`'s `?? DEFAULT_INTERVAL_MS` (`??` only falls back on null/undefined) and reached `setTimeout(fn, NaN)`, clamping to 1ms — a continuous scan loop against infrastructure that is already degraded. `runWatch` additionally floors any non-finite or non-positive `intervalMs` to the default, so no caller can reintroduce the hot loop.

Any new numeric flag should go through the same validate-then-convert path in `run.ts` rather than an inline `parseInt`.

### Escalation Levels

Five progressive escalation levels surface in scan output and recovery proposals:
1. **Observe** — read-only health checks, no system interaction
2. **Diagnose** — read-only queries against live systems
3. **Suggest** — generate recovery plans without executing
4. **Repair (safe)** — execute routine/elevated risk actions
5. **Repair (destructive)** — execute high/critical risk actions

Supporting modules: `detect.ts` (system detection), `autodiscovery.ts` (zero-config agent detection), `output.ts` (structured output formatting), `errors.ts` (error formatting), `status-presentation.ts` (single source for status → presentation mappings). The five-level escalation model lives in `src/framework/escalation.ts`.

## Agent Pattern

Every agent follows this structure:

```
src/agent/<system>/
  backend.ts        # Interface (PgBackend, RedisBackend, etc.)
  simulator.ts      # In-memory implementation for demos/tests
  live-client.ts    # Real infrastructure client
  manifest.ts       # AgentManifest — capabilities, risk profile, triggers
  agent.ts          # RecoveryAgent implementation
  registration.ts   # Lazy factory for the agent registry
```

When building a new agent:
1. Define the backend interface with async methods
2. Build the simulator first — it enables demo mode and testing
3. The live client queries real infrastructure (database, cache, API)
4. The manifest declares what the agent targets, its max risk level, and trigger conditions
5. The agent uses diagnosis findings to dynamically build plans — never hardcode IPs or hostnames
6. Create `registration.ts` with a lazy factory and register in `src/config/builtin-agents.ts`

## Recovery Plan Steps

7 step types are available (defined in `src/types/step-types.ts`):
- `diagnosis_action` — read-only data gathering
- `human_notification` — send alerts to stakeholders
- `checkpoint` — capture state before mutations
- `system_action` — execute commands with preconditions, success criteria, blast radius
- `human_approval` — gate execution pending human decision
- `replanning_checkpoint` — agent can revise the remaining plan mid-flight
- `conditional` — branch execution based on system state

## Safety Rules

- Every `system_action` at `elevated` risk or higher MUST have `statePreservation.before` captures
- Every plan with `elevated+` steps MUST include a `human_notification` step
- Plans MUST have a `rollbackStrategy`
- Step IDs must be unique within a plan
- No nested conditionals
- Blast radius must declare affected components

These are enforced by the validator (`src/framework/validator.ts`).

## Testing

### Test environment
- `./test/podman/scripts/start.sh` — starts PG primary/replica, Prometheus, AlertManager, mock hub
- `./test/smoke/run-all.sh` — validates the test environment (16 checks)
- `./test/failures/*.sh` — inject specific failures into PostgreSQL

### Running against real infrastructure
- `pnpm run live` — dry-run against podman test PG
- `pnpm run live -- --execute` — execute mode (will mutate real PG)
- `pnpm run webhook` — start webhook receiver for AlertManager

### Unit tests
- `pnpm test` — runs vitest unit tests (`src/__tests__/*.test.ts`)
- `pnpm run test:watch` — runs vitest in watch mode
- Configuration in `vitest.config.ts`

### Type checking
- `pnpm run typecheck` — runs `tsc --noEmit`

### Linting

Two linters run the same rule set at different speeds. **ESLint is authoritative** — oxlint exists only so the pre-commit hook stays cheap.

- `pnpm run lint` — ESLint (flat config in `eslint.config.js`), ~15s over 619 files; `pnpm run lint:fix` to autofix. Runs in CI and is the gate that decides whether a PR is clean.
- `pnpm run lint:fast` — oxlint (`.oxlintrc.json`), ~0.5s. Runs in the pre-commit hook. Also runs in CI, purely so a broken or drifted `.oxlintrc.json` fails a PR instead of silently breaking every contributor's hook.
- Lint-time TypeScript is pinned to 6.0.2 via `.pnpmfile.cjs` (typescript-eslint does not yet support the TS 7 native compiler); `tsc` stays on TS 7

**`.oxlintrc.json` must mirror `eslint.config.js`.** When you add, remove, or retune a rule in one, do the same in the other — nothing enforces the correspondence automatically. The mapping today:

| `eslint.config.js` | `.oxlintrc.json` |
|---|---|
| `js.configs.recommended` + `tseslint.configs.recommended` | `categories.correctness: error`, `plugins: ["typescript"]` |
| `@typescript-eslint/no-explicit-any` | `typescript/no-explicit-any` |
| `@typescript-eslint/consistent-type-imports` | `typescript/consistent-type-imports` |
| `@typescript-eslint/no-unused-vars` (+ `^_` patterns) | `typescript/no-unused-vars` (same options) |
| test overrides (`no-non-null-assertion`, `no-explicit-any` off) | `overrides` block, same globs |
| `ignores` | `ignorePatterns` |
| `no-restricted-syntax` — no default exports | **not expressible in oxlint** — see below |

oxlint does not implement `no-restricted-syntax` (its config parser rejects the rule outright), so the no-default-exports convention cannot move. The pre-commit hook greps staged `.ts`/`.tsx` for `^export default ` instead, exempting the same tool-config and `.d.ts` paths ESLint exempts. That grep is a heuristic — it can be fooled by the phrase inside a string or comment — so CI's ESLint run remains the real check.

oxlint's `unicorn` and `oxc` plugins are on by default and flag opinions this codebase has never enforced; `.oxlintrc.json` names `plugins` explicitly to keep them off. Don't enable them without also deciding what ESLint should do about the same code. `--type-aware` is deliberately unused: it needs the extra `oxlint-tsgolint` binary, and `pnpm run typecheck` already covers that ground in ~1s.

### CI
- GitHub Actions (`.github/workflows/ci.yml`) — runs typecheck, unit tests, and gitleaks on push to main and PRs

## Key Files

| File | Purpose |
|---|---|
| `src/agent/interface.ts` | RecoveryAgent contract — start here for understanding the agent model |
| `src/framework/engine.ts` | ExecutionEngine — how plans are executed step by step |
| `src/framework/graph-engine.ts` | LangGraph-based graph execution engine |
| `src/framework/symptom-router.ts` | Routes symptoms to appropriate recovery agents |
| `src/framework/ai-diagnosis-universal.ts` | Universal AI-powered diagnosis for any agent |
| `src/framework/incident-report.ts` | Structured incident report generation |
| `src/framework/network-profile.ts` | Network diagnostics and profiling |
| `src/framework/triage.ts` | Offline triage — layered localization and verdict synthesis |
| `src/framework/triage-probes.ts` | Node implementations of the triage probes (built-ins only) |
| `src/cli/commands/triage.ts` | `crisismode triage` command and exit-code contract |
| `src/framework/service-status/` | Third-party service status checker — combines a provider's status page with a reachability probe into one verdict, never conflating the two; catalog of known services (`catalog.ts`) and Statuspage v2 parsing (`statuspage.ts`); consumed by `down`, the service-status agent, and triage enrichment |
| `src/types/step-types.ts` | All 7 recovery step types |
| `src/types/recovery-plan.ts` | RecoveryPlan structure |
| `src/cli/index.ts` | CLI process boundary — the one place `process.exitCode` is assigned |
| `src/cli/run.ts` | CLI routing: argv in, `ExitCode` out (`runCli`), plus the help text |
| `src/cli/args.ts` | The single argument parser — subcommand detection + per-command strict option sets |
| `src/cli/exit-codes.ts` | `ExitCode` enum — single source of truth for the CLI's exit contract |
| `src/cli/commands/` | CLI subcommands (scan, diagnose, recover, status, ask, demo, init, webhook, watch, readiness, triage, agent, playbook, bundle, registry, completions) |
| `src/mcp/server.ts` | MCP server — 8 read-only diagnosis tools exposed via `crisismode mcp` |
| `src/readiness/` | Scale-readiness rule registry + capacity ceilings/weak-link (readiness command + MCP tool) |
| `src/framework/escalation.ts` | Five-level progressive escalation model |
| `src/framework/guidance/registry.ts` | Remediation guide registry — console-step guidance keyed to finding types |
| `src/agent/pg-replication/` | Reference agent implementation (PostgreSQL) |
| `src/agent/redis/` | Redis memory pressure recovery agent |
| `src/agent/etcd/` | etcd consensus recovery agent |
| `src/agent/kafka/` | Kafka broker recovery agent |
| `src/agent/kubernetes/` | Kubernetes cluster recovery agent |
| `src/agent/ceph/` | Ceph storage recovery agent |
| `src/agent/flink/` | Flink stream processing recovery agent |
| `src/agent/llm-provider/` | LLM provider diagnosis agent — API key, quota/billing, rate-limit headroom, model deprecation, provider status |
| `src/agent/ai-provider/` | AI service failover and fallback agent (explicit config and demo only) |
| `src/agent/config-drift/` | Configuration drift detection and remediation agent |
| `src/agent/db-migration/` | Database migration safety and rollback agent |
| `src/agent/deploy-rollback/` | Deployment rollback orchestration agent |
| `src/agent/queue-backlog/` | Queue backlog and lag recovery agent |
| `src/agent/dns/` | DNS resolution failure recovery agent |
| `src/agent/tls/` | TLS certificate health and expiry agent |
| `src/agent/disk/` | Local disk exhaustion detection agent |
| `src/agent/backup/` | Backup verification and DR readiness agent |
| `src/agent/aws-s3/` | AWS S3 backup configuration agent |
| `src/agent/aws-dynamodb/` | AWS DynamoDB PITR verification agent |
| `src/agent/aws-rds/` | AWS RDS control-plane health, metrics, reachability, and backup agent |
| `src/agent/iac-drift/` | Terraform drift detection agent (intended vs. observed) |
| `src/agent/vector-store/` | Managed vector store (Pinecone, Upstash Vector) reachability agent — maturity `simulator_only`: neither provider has been live-validated against a real account; the invalid-key rejection and secret-redaction paths were live-checked against the real Pinecone API, Upstash was exercised only in simulator/mocked tests |
| `src/agent/service-status/` | Third-party service status agent — scans the config's `services:` list in `scan`/`watch`; maturity `live_validated` (all 12 catalog entries passed live validation) |
| `src/config/builtin-agents.ts` | Built-in agent registration |
| `src/config/agent-registry.ts` | Global agent registry |
| `src/integrations/` | External integrations (GitHub, Sentry) |
| `specs/foundational/recovery-agent-contract.md` | The authoritative specification |
| `src/framework/backend.ts` | ExecutionBackend contract — shared interface for all backends |
| `src/framework/provider-registry.ts` | Resolves capability providers for plan steps |
| `src/framework/capability-registry.ts` | Global registry of standard recovery capabilities |
| `src/framework/operator-summary.ts` | Builds operator-facing health and readiness summaries |
| `src/types/health.ts` | Health assessment and operator summary types |
| `src/types/plugin.ts` | Plugin ecosystem types (capability providers, domain packs, etc.) |
| `specs/deployment/operations.md` | Hub-and-spoke deployment architecture |
| `specs/architecture/plugin-platform.md` | Plugin platform architecture guide |
| `specs/architecture/operator-health-and-ai-services.md` | Operator summary, AI services, and site config spec |
| `packages/agent-sdk/` | @crisismode/agent-sdk — public types package |
| `src/framework/playbook/` | Markdown playbook parser, runtime, and discovery |
| `src/framework/hooks/` | Pluggable lifecycle hook system |
| `src/framework/registry/` | Agent plugin discovery and manifest handling |
| `specs/foundational/playbook-format.md` | Playbook format specification |
| `specs/foundational/registry-manifest.md` | Agent manifest specification |
| `playbooks/examples/` | Reference playbook implementations |
| `CONTRIBUTING.md` | Contribution guide (agents and playbooks) |
| `docs/architecture.md` | System architecture overview |
| `docs/readiness.md` | Scale-readiness usage and extension guide (rules, ceilings, honesty contract) |
| `docs/guides/creating-a-recovery-agent.md` | Agent development tutorial |
| `docs/playbook-authoring.md` | Playbook authoring guide |

## Commit Conventions

Use [Conventional Commits](https://www.conventionalcommits.org/):
```
type(scope): description
```
Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `ci`, `perf`, `build`

## What NOT to Do

- Don't hardcode IPs, hostnames, or infrastructure identifiers in agents — discover them at diagnosis time
- Don't skip pre-commit hooks (`--no-verify`) unless explicitly asked
- Don't add dependencies without considering the spoke's resource footprint (256Mi memory target)
- Don't bypass safety validations — they exist because wrong actions during a crisis are catastrophic
- Don't store secrets in code — credentials come from K8s Secrets or environment variables at runtime
- Don't create agents with `maxRiskLevel: 'critical'` without explicit discussion — critical operations require the highest level of human oversight
