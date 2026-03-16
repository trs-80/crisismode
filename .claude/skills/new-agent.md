---
name: new-agent
description: Scaffold a new CrisisMode recovery agent with all required files
user_invocable: true
---

# /new-agent — Scaffold a New Recovery Agent

The user wants to create a new CrisisMode recovery agent. Ask them for:

1. **System name** (e.g., `redis`, `kafka`, `elasticsearch`) — this becomes the directory name under `src/agent/`
2. **Technology and version constraint** (e.g., `redis >=6.0 <8.0`)
3. **Failure scenarios** the agent should handle (e.g., `memory_exhaustion`, `split_brain`)
4. **Max risk level** — `low`, `elevated`, `high` (never `critical` without explicit discussion per CLAUDE.md)

Then generate these files following the patterns in `src/agent/pg-replication/`:

```
src/agent/<system>/
  backend.ts      — Interface with async methods for querying system state
  simulator.ts    — In-memory implementation returning canned data per state
  live-client.ts  — Stub that implements the backend interface (TODO body)
  manifest.ts     — AgentManifest with metadata, triggers, risk profile
  agent.ts        — RecoveryAgent implementing diagnose(), plan(), replan()
```

## Rules

- Use named exports only (no default exports)
- All imports use `.js` extensions (NodeNext resolution)
- Use `import type { ... }` for type-only imports
- Add SPDX license header: `// SPDX-License-Identifier: Apache-2.0` and `// Copyright 2026 CrisisMode Contributors`
- The simulator should have at least `degraded`, `recovering`, and `recovered` states
- The agent's `plan()` must produce valid recovery plans with `rollbackStrategy` and proper step types from `src/types/step-types.ts`
- Every `system_action` at `elevated`+ risk must have `statePreservation.before` captures
- Plans with `elevated`+ steps must include a `human_notification` step
- Never hardcode IPs or hostnames — discover them during diagnosis
- Register the new agent in `src/agent/catalog.ts` if it exists

After scaffolding, run `pnpm run typecheck` to verify everything compiles.
