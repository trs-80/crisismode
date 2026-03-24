# Contributing to CrisisMode

CrisisMode accepts two types of contributions:

1. **Markdown playbooks** -- declarative recovery procedures that anyone can write
2. **TypeScript agents** -- programmatic recovery logic for specific infrastructure

Both paths are welcome. Playbooks are the easiest way to start.

## Your first playbook

Playbooks are Markdown files with YAML frontmatter and structured steps.

### 1. Create the file

Create a `.md` file in `playbooks/`:

```markdown
---
name: restart-worker
version: "1.0.0"
description: Restart a stuck background worker
severity: warning
tags: [worker, restart]
---

### Check worker status
- type: diagnosis_action
- command: systemctl status worker

### Notify on-call
- type: human_notification
- channel: slack
- message: Worker is unresponsive, initiating restart

### Restart worker
- type: system_action
- command: systemctl restart worker
- risk: routine
- rollback: systemctl stop worker
```

### 2. Validate and test

```bash
crisismode playbook validate playbooks/restart-worker.md
crisismode playbook dry-run playbooks/restart-worker.md
```

### 3. Submit a PR

Open a pull request with your playbook. Include a description of what the playbook recovers and how you tested it.

## Your first agent

Agents are TypeScript modules that implement the `RecoveryAgent` interface using a 6-file pattern (`backend.ts`, `simulator.ts`, `live-client.ts`, `manifest.ts`, `agent.ts`, `registration.ts`).

See the [Agent Development Guide](docs/guides/creating-a-recovery-agent.md) for a complete walkthrough. The PostgreSQL agent at `src/agent/pg-replication/` is the canonical reference implementation.

## Development setup

See [GETTING_STARTED.md](GETTING_STARTED.md) for prerequisites, installation, test environment, and running against real infrastructure.

## Code standards

- **TypeScript strict mode** with ESM modules (`"type": "module"`)
- **`.js` extensions** on all imports (NodeNext module resolution)
- **Named exports only** -- no default exports
- **Async by default** -- backend interfaces return `Promise<T>`
- **Type imports** -- use `import type { ... }` for type-only imports
- **SPDX license header** on all new source files:
  ```typescript
  // SPDX-License-Identifier: Apache-2.0
  // Copyright 2026 CrisisMode Contributors
  ```
- **Conventional Commits** for all commit messages:
  ```
  feat(agent): add MySQL recovery agent
  fix(engine): handle timeout in step execution
  test(redis): add memory pressure scenario tests
  ```

## Testing requirements

- All new code needs tests
- Run `pnpm test` before submitting
- Run `pnpm run typecheck` to verify type safety
- Build the simulator first -- it enables testing without real infrastructure
- Use the agent test harness (`src/framework/agent-test-harness.ts`) for standardized agent testing
- Follow existing test patterns in `src/__tests__/`

## What NOT to do

- **Don't weaken safety layers** -- every `system_action` at `elevated` risk or higher must have state preservation captures
- **Don't add unnecessary dependencies** -- spokes target 256Mi memory; every dependency counts
- **Don't hardcode IPs or hostnames** -- discover infrastructure at diagnosis time
- **Don't store secrets in code** -- credentials come from environment variables or K8s Secrets
- **Don't modify hub code** -- hub coordination is managed separately
- **Don't skip pre-commit hooks** -- they enforce safety invariants
- **Don't create agents with `maxRiskLevel: 'critical'`** without explicit discussion
