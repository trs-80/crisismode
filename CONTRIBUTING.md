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

Agents are TypeScript modules that implement the `RecoveryAgent` interface.

### 1. Install the SDK

```bash
npm install @crisismode/agent-sdk
```

### 2. Implement the RecoveryAgent interface

Every agent lives in `src/agent/<system>/` with these files:

| File | Purpose |
|---|---|
| `backend.ts` | Interface with async methods for system interaction |
| `simulator.ts` | In-memory implementation for demos and tests |
| `live-client.ts` | Real infrastructure client |
| `manifest.ts` | Agent metadata: capabilities, risk profile, triggers |
| `agent.ts` | `RecoveryAgent` implementation |
| `registration.ts` | Lazy factory for the agent registry |

### 3. Study the reference implementation

`src/agent/pg-replication/` is the canonical example. It demonstrates:

- Backend interface design with system-specific diagnosis methods
- Simulator that enables testing without infrastructure
- Manifest with target systems, version constraints, and trigger conditions
- Dynamic plan building based on diagnosis findings

### 4. Write tests using the simulator

```typescript
import { describe, it, expect } from 'vitest';
import { YourSimulator } from './simulator.js';
import { YourAgent } from './agent.js';

describe('my-agent', () => {
  it('diagnoses the issue', async () => {
    const backend = new YourSimulator();
    const agent = new YourAgent(backend);
    const health = await agent.assessHealth();
    expect(health.status).toBe('degraded');
  });
});
```

### 5. Add a plugin manifest

Create `crisismode-agent.json` in your agent's root:

```json
{
  "name": "my-agent",
  "version": "1.0.0",
  "description": "Recovers my-system from common failures",
  "kind": "agent",
  "entryPoint": "./agent.js",
  "targetKinds": ["my-system"],
  "crisismode": { "minVersion": "0.3.0" }
}
```

### 6. Register the agent

Create `registration.ts` with a lazy factory and register it in `src/config/builtin-agents.ts`.

## Development setup

### Prerequisites

- **Node.js** >= 18 (recommended: [fnm](https://github.com/Schniz/fnm) or [nvm](https://github.com/nvm-sh/nvm))
- **pnpm** -- `npm install -g pnpm`

### Getting started

```bash
git clone git@github.com:trs-80/crisismode.git
cd crisismode
pnpm install
pnpm test
pnpm run typecheck
```

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
