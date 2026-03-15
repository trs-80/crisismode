# AGENTS.md — AI Agent Instructions for CrisisMode

This file provides context and instructions for AI agents (Codex, Copilot, Cursor, etc.) working in this repository.

## Project Overview

CrisisMode is an AI crisis recovery framework with a hub-and-spoke architecture. Spokes execute recovery plans close to target systems. The hub provides coordination, analytics, and management. The framework is designed for crisis conditions — when infrastructure is degraded and the cost of wrong actions is highest.

## Architecture

### Layers
- **Layer 1 (Execution)** + **Layer 2 (Safety)** — run in the spoke
- **Layer 3 (Coordination)** + **Layer 4 (Enrichment)** — run in the hub

### Key abstractions
- **RecoveryAgent** (`src/agent/interface.ts`) — the contract every agent implements: `diagnose()`, `plan()`, `replan()`
- **PgBackend / RedisBackend** — backend interfaces that abstract over simulators and live clients
- **ExecutionEngine** (`src/framework/engine.ts`) — executes plans step-by-step with safety checks
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

## Agent Pattern

Every agent follows this structure:

```
src/agent/<system>/
  backend.ts      # Interface (PgBackend, RedisBackend, etc.)
  simulator.ts    # In-memory implementation for demos/tests
  live-client.ts  # Real infrastructure client
  manifest.ts     # AgentManifest — capabilities, risk profile, triggers
  agent.ts        # RecoveryAgent implementation
```

When building a new agent:
1. Define the backend interface with async methods
2. Build the simulator first — it enables demo mode and testing
3. The live client queries real infrastructure (database, cache, API)
4. The manifest declares what the agent targets, its max risk level, and trigger conditions
5. The agent uses diagnosis findings to dynamically build plans — never hardcode IPs or hostnames

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

### Type checking
- `pnpm run typecheck` — runs `tsc --noEmit`

## Key Files

| File | Purpose |
|---|---|
| `src/agent/interface.ts` | RecoveryAgent contract — start here for understanding the agent model |
| `src/framework/engine.ts` | ExecutionEngine — how plans are executed step by step |
| `src/types/step-types.ts` | All 7 recovery step types |
| `src/types/recovery-plan.ts` | RecoveryPlan structure |
| `src/agent/pg-replication/` | Reference agent implementation (PostgreSQL) |
| `specs/foundational/recovery-agent-contract.md` | The authoritative specification |
| `specs/deployment/operations.md` | Hub-and-spoke deployment architecture |

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
