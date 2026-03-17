# AGENTS.md — AI Agent Instructions for CrisisMode

This file provides context and instructions for AI agents (Codex, Copilot, Cursor, etc.) working in this repository.

## Project Overview

CrisisMode is an AI crisis recovery framework with a hub-and-spoke architecture. Spokes execute recovery plans close to target systems. The hub provides coordination, analytics, and management. The framework is designed for crisis conditions — when infrastructure is degraded and the cost of wrong actions is highest.

## Architecture

### Layers
- **Layer 1 (Execution)** + **Layer 2 (Safety)** — run in the spoke
- **Layer 3 (Coordination)** + **Layer 4 (Enrichment)** — run in the hub

### Key abstractions
- **RecoveryAgent** (`src/agent/interface.ts`) — the contract every agent implements: `assessHealth()`, `diagnose()`, `plan()`, `replan()`
- **ExecutionBackend** (`src/framework/backend.ts`) — shared contract for execution backends (`executeCommand()`, `evaluateCheck()`, optional `listCapabilityProviders()`)
- **PgBackend / RedisBackend / EtcdBackend / KafkaBackend / K8sBackend / CephBackend / FlinkBackend** — agent-specific backend interfaces that extend ExecutionBackend with system-specific diagnosis methods
- **ExecutionEngine** (`src/framework/engine.ts`) — executes plans step-by-step with safety checks
- **GraphEngine** (`src/framework/graph-engine.ts`) — LangGraph-based graph execution engine for complex recovery workflows
- **SymptomRouter** (`src/framework/symptom-router.ts`) — routes symptoms to the appropriate recovery agent
- **ProviderRegistry** (`src/framework/provider-registry.ts`) — resolves which capability providers can handle each step
- **CapabilityRegistry** (`src/framework/capability-registry.ts`) — global registry of standard recovery capabilities (e.g., `db.query.read`, `db.replica.disconnect`)
- **OperatorSummary** (`src/framework/operator-summary.ts`) — builds human-readable health and readiness summaries for operators
- **IncidentReport** (`src/framework/incident-report.ts`) — generates structured incident reports from recovery executions
- **NetworkProfile** (`src/framework/network-profile.ts`) — network diagnostics and profiling
- **AI Diagnosis** (`src/framework/ai-diagnosis-universal.ts`) — universal AI-powered diagnosis for any agent via Claude API
- **ForensicRecorder** — immutable audit trail for every execution

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
| `scan` | Zero-config health scan with scored summary (default when no command given) |
| `diagnose` | Health check + AI-powered diagnosis (read-only) |
| `recover` | Full recovery flow with execution planning |
| `status` | Quick health probe |
| `ask` | Natural language AI diagnosis |
| `demo` | Simulator demo mode |
| `init` | Generate `crisismode.yaml` configuration |
| `webhook` | Start webhook receiver for AlertManager |
| `watch` | Continuous shadow observation |

Supporting modules: `detect.ts` (system detection), `autodiscovery.ts` (zero-config agent detection), `output.ts` (structured output formatting), `escalation.ts` (five-level escalation model), `errors.ts` (error formatting).

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

### CI
- GitHub Actions (`.github/workflows/ci.yml`) — runs typecheck, unit tests, and gitleaks on push to main and PRs

## Key Files

| File | Purpose |
|---|---|
| `src/agent/interface.ts` | RecoveryAgent contract — start here for understanding the agent model |
| `src/framework/engine.ts` | ExecutionEngine — how plans are executed step by step |
| `src/types/step-types.ts` | All 7 recovery step types |
| `src/types/recovery-plan.ts` | RecoveryPlan structure |
| `src/agent/pg-replication/` | Reference agent implementation (PostgreSQL) |
| `src/agent/redis/` | Redis memory pressure recovery agent |
| `src/agent/etcd/` | etcd consensus recovery agent |
| `src/agent/kafka/` | Kafka broker recovery agent |
| `src/agent/kubernetes/` | Kubernetes cluster recovery agent |
| `src/agent/ceph/` | Ceph storage recovery agent |
| `src/agent/flink/` | Flink stream processing recovery agent |
| `src/agent/ai-provider/` | AI service failover and fallback agent |
| `src/agent/config-drift/` | Configuration drift detection and remediation agent |
| `src/agent/db-migration/` | Database migration safety and rollback agent |
| `src/agent/deploy-rollback/` | Deployment rollback orchestration agent |
| `src/agent/queue-backlog/` | Queue backlog and lag recovery agent |
| `src/framework/graph-engine.ts` | LangGraph-based graph execution engine |
| `src/framework/symptom-router.ts` | Routes symptoms to appropriate recovery agents |
| `src/framework/ai-diagnosis-universal.ts` | Universal AI-powered diagnosis for any agent |
| `src/framework/incident-report.ts` | Structured incident report generation |
| `src/framework/network-profile.ts` | Network diagnostics and profiling |
| `src/cli/index.ts` | Unified CLI entry point |
| `src/config/builtin-agents.ts` | Built-in agent registration |
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
