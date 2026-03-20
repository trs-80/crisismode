# Creating a Recovery Agent

This guide explains how to build a recovery agent for CrisisMode. It covers the agent contract, the 6-file pattern, and the key decisions you need to make at each step.

For a working reference, study the Redis agent (`src/agent/redis/`) -- it is simpler than the PostgreSQL agent and demonstrates the full pattern without live client complexity.

## Overview

A recovery agent is a TypeScript module that diagnoses failures and builds validated recovery plans for a specific system. Every agent implements the `RecoveryAgent` interface defined in `src/agent/interface.ts`:

```typescript
interface RecoveryAgent {
  manifest: AgentManifest;
  assessHealth(context: AgentContext): Promise<HealthAssessment>;
  diagnose(context: AgentContext): Promise<DiagnosisResult>;
  plan(context: AgentContext, diagnosis: DiagnosisResult): Promise<RecoveryPlan>;
  replan(
    context: AgentContext,
    diagnosis: DiagnosisResult,
    executionState: ExecutionState,
  ): Promise<ReplanResult>;
  revisePlan?(
    context: AgentContext,
    diagnosis: DiagnosisResult,
    feedback: { reasons: string[] },
  ): Promise<RecoveryPlan>;
}
```

The four required methods represent a progression:

| Method | Purpose | Reads system? | Mutates system? |
|---|---|---|---|
| `assessHealth` | Quick health probe with status and confidence | Yes | No |
| `diagnose` | Deep inspection producing structured findings | Yes | No |
| `plan` | Build a recovery plan from diagnosis findings | No (uses diagnosis) | No |
| `replan` | Adapt the plan mid-execution based on new state | Yes | No |

The optional `revisePlan` method allows the framework to request a revised plan when validation fails (e.g., capabilities unavailable). Most agents do not need this initially.

The agent never executes recovery actions directly. It builds a `RecoveryPlan` containing typed steps. The framework's execution engine validates and runs those steps, enforcing safety rules, approval workflows, and forensic recording.

## The 6-File Pattern

Every agent follows this structure:

```
src/agent/<system>/
  backend.ts          # Interface for querying the target system
  simulator.ts        # In-memory implementation for demos and tests
  live-client.ts      # Real infrastructure client
  manifest.ts         # Agent manifest -- capabilities, risk profile, triggers
  agent.ts            # RecoveryAgent implementation
  registration.ts     # Lazy factory for the agent registry
```

### Why this pattern?

- **backend.ts** defines the contract between the agent and the system it manages. The agent codes against this interface, not against specific clients.
- **simulator.ts** enables testing and demo mode without real infrastructure. Build this first.
- **live-client.ts** connects to real systems. It can be built later -- the simulator is sufficient for an initial contribution.
- **manifest.ts** declares what the agent can do and what it is allowed to do. The framework uses this for validation and routing.
- **agent.ts** contains the diagnosis and planning logic. This is where domain expertise lives.
- **registration.ts** provides a lazy factory so the agent's heavy dependencies (drivers, clients) are only imported when the agent is actually needed.

## Step 1: Define the Backend Interface

Create `src/agent/<system>/backend.ts`. This interface defines the queries and commands your agent needs.

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { ExecutionBackend } from '../../framework/backend.js';

export interface MySystemInfo {
  // Fields that describe the current state of the system
}

export interface MySystemBackend extends ExecutionBackend {
  /** Read-only: get current system status */
  getInfo(): Promise<MySystemInfo>;

  /** Read-only: get detailed diagnostic data */
  getDiagnostics(): Promise<MyDiagnosticData>;

  // Add methods as needed for your system
}
```

Key decisions:

- **Extend `ExecutionBackend`.** This gives you `executeCommand()`, `evaluateCheck()`, and `close()` as the core interface the execution engine uses to run plan steps. Your implementation must provide all three.
- **Separate read from write.** Read-only methods (used during `assessHealth` and `diagnose`) should be clearly distinct from write operations (handled through `executeCommand`).
- **Keep the interface focused.** Only expose what the agent needs. You can always add methods later.

See `src/agent/redis/backend.ts` for an example: it defines `RedisInfo`, `RedisSlaveInfo`, and `RedisSlowlogEntry` data types, then declares read-only methods like `getInfo()`, `getSlaves()`, `getSlowlog()`.

## Step 2: Build the Simulator

Create `src/agent/<system>/simulator.ts`. The simulator implements your backend interface with in-memory state that models both healthy and degraded conditions.

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { MySystemBackend, MySystemInfo } from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';

export type SimulatorState = 'degraded' | 'recovering' | 'recovered';

export class MySystemSimulator implements MySystemBackend {
  private state: SimulatorState = 'degraded';

  transition(to: string): void {
    this.state = to as SimulatorState;
  }

  async getInfo(): Promise<MySystemInfo> {
    switch (this.state) {
      case 'degraded':
        return { /* unhealthy values */ };
      case 'recovering':
        return { /* improving values */ };
      case 'recovered':
        return { /* healthy values */ };
    }
  }

  async executeCommand(command: Command): Promise<unknown> {
    // Handle commands the agent's plan will issue
    // Transition state to model the effect of recovery actions
    return { simulated: true };
  }

  async evaluateCheck(check: CheckExpression): Promise<boolean> {
    // Evaluate preconditions and success criteria against simulator state
    return true;
  }

  async close(): Promise<void> {}
}
```

Why build the simulator first:

- It lets you develop and test the agent without any real infrastructure.
- It powers the `crisismode demo` command.
- It serves as executable documentation of how the system behaves under failure.
- It is required for unit tests.

Model at least three states: `degraded` (the failure the agent handles), `recovering` (intermediate state after some actions), and `recovered` (healthy). The `transition()` method lets the execution engine advance the simulator through states as plan steps execute.

The simulator must also implement `listCapabilityProviders()` (from `ExecutionBackend`) to declare what capabilities it provides. See `RedisSimulator.listCapabilityProviders()` for the pattern.

## Step 3: Write the Manifest

Create `src/agent/<system>/manifest.ts`. The manifest is a data declaration -- no logic, no imports of heavy dependencies.

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentManifest } from '../../types/manifest.js';

export const mySystemManifest: AgentManifest = {
  apiVersion: 'v0.2.1',
  kind: 'AgentManifest',
  metadata: {
    name: 'my-system-recovery',
    version: '1.0.0',
    description: 'Recovers MySystem from specific failure scenarios.',
    authors: ['Your Name <you@example.com>'],
    license: 'Apache-2.0',
    tags: ['my-system', 'database', 'stateful'],
    plugin: {
      id: 'my-system.domain-pack',
      kind: 'domain_pack',
      maturity: 'simulator_only',
      compatibilityMode: 'recovery_agent',
    },
  },
  spec: {
    targetSystems: [ /* ... */ ],
    triggerConditions: [ /* ... */ ],
    failureScenarios: [ /* ... */ ],
    executionContexts: [ /* ... */ ],
    observabilityDependencies: { required: [], optional: [] },
    riskProfile: { /* ... */ },
    humanInteraction: { /* ... */ },
  },
};
```

### Manifest fields explained

**`metadata`** -- identity and authorship:
- `name` -- unique agent name, used as the registry key.
- `version` -- semver version of the agent.
- `plugin.maturity` -- set to `"simulator_only"` until a live client exists; change to `"beta"` or `"stable"` later.

**`spec.targetSystems`** -- what systems this agent manages:
```typescript
targetSystems: [
  {
    technology: 'redis',
    versionConstraint: '>=6.0.0 <8.0.0',
    components: ['primary', 'replica'],
  },
],
```

**`spec.triggerConditions`** -- what causes this agent to activate:
```typescript
triggerConditions: [
  { type: 'alert', source: 'prometheus', matchLabels: { alertname: 'MyAlert' } },
  { type: 'health_check', name: 'my_system_check', status: 'degraded' },
  { type: 'manual', description: 'Operator-initiated recovery' },
],
```

**`spec.failureScenarios`** -- the failure modes this agent handles. These are string identifiers used to match the diagnosis to a recovery plan:
```typescript
failureScenarios: ['memory_pressure', 'client_exhaustion', 'slow_query_storm'],
```

**`spec.executionContexts`** -- what privileges the agent needs and what operations it performs:
```typescript
executionContexts: [
  {
    name: 'my_system_admin',
    type: 'my_system_command',
    privilege: 'admin',
    target: 'my_system',
    allowedOperations: ['INFO', 'CONFIG', 'KILL'],
    capabilities: ['my.system.query', 'my.system.config.set'],
  },
],
```

**`spec.riskProfile`** -- the maximum risk this agent's plans can reach:
```typescript
riskProfile: {
  maxRiskLevel: 'elevated',    // 'routine' | 'elevated' | 'high' | 'critical'
  dataLossPossible: false,
  serviceDisruptionPossible: true,
},
```

Do not set `maxRiskLevel` to `'critical'` without discussion with maintainers. Critical operations require the highest level of human oversight.

**`spec.humanInteraction`** -- approval requirements:
```typescript
humanInteraction: {
  requiresApproval: true,
  minimumApprovalRole: 'on_call_engineer',
  escalationPath: ['on_call_engineer', 'engineering_lead'],
},
```

## Step 4: Implement the Agent

Create `src/agent/<system>/agent.ts`. This is where your domain expertise goes.

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RecoveryAgent, ReplanResult } from '../interface.js';
import type { AgentContext } from '../../types/agent-context.js';
import type { DiagnosisResult } from '../../types/diagnosis-result.js';
import type { ExecutionState } from '../../types/execution-state.js';
import type { HealthAssessment } from '../../types/health.js';
import type { RecoveryPlan } from '../../types/recovery-plan.js';
import { mySystemManifest } from './manifest.js';
import type { MySystemBackend } from './backend.js';
import { MySystemSimulator } from './simulator.js';

export class MySystemAgent implements RecoveryAgent {
  manifest = mySystemManifest;
  backend: MySystemBackend;

  constructor(backend?: MySystemBackend) {
    this.backend = backend ?? new MySystemSimulator();
  }

  // ...implement assessHealth, diagnose, plan, replan
}
```

### assessHealth

A quick probe that returns an overall status, confidence score, and health signals. This runs during `crisismode scan` and must be fast (under 2 seconds).

```typescript
async assessHealth(context: AgentContext): Promise<HealthAssessment> {
  const info = await this.backend.getInfo();
  // Evaluate thresholds, build signals
  return {
    status: 'healthy' | 'recovering' | 'unhealthy',
    confidence: 0.95,
    summary: 'One-line description',
    observedAt: new Date().toISOString(),
    signals: [ /* HealthSignal[] */ ],
    recommendedActions: [ /* string[] */ ],
  };
}
```

### diagnose

A deeper inspection that produces structured findings. This runs during `crisismode diagnose` and can take longer.

The diagnosis result includes a `scenario` field that maps to one of the `failureScenarios` declared in the manifest. This is how the agent communicates *what kind of failure* it found.

### plan

Builds a `RecoveryPlan` from diagnosis findings. This is where you construct the ordered sequence of recovery steps.

The plan must satisfy the safety rules enforced by the validator (see the safety checklist below). Build the plan dynamically based on diagnosis findings -- never hardcode infrastructure identifiers like IPs or hostnames.

### replan

Called mid-execution at `replanning_checkpoint` steps. The agent can:
- `{ action: 'continue' }` -- proceed with the current plan
- `{ action: 'revised_plan', plan: newPlan }` -- substitute a new plan
- `{ action: 'abort', reason: '...' }` -- stop execution

## Step 5: Register the Agent

### registration.ts

Create `src/agent/<system>/registration.ts`:

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentRegistration } from '../../config/agent-registration.js';
import { mySystemManifest } from './manifest.js';

export const mySystemRegistration: AgentRegistration = {
  kind: 'my-system',
  name: 'my-system-recovery',
  manifest: mySystemManifest,

  async createAgent(target) {
    // Dynamic imports -- heavy dependencies load only when needed
    const { MySystemAgent } = await import('./agent.js');
    const { MySystemSimulator } = await import('./simulator.js');

    const backend = new MySystemSimulator();
    const agent = new MySystemAgent(backend);
    return { agent, backend, target };
  },
};
```

The `kind` field determines which detected services this agent handles. The `createAgent` factory uses dynamic `import()` so that the agent's dependencies are not loaded until the agent is actually needed.

### builtin-agents.ts

Add your registration to `src/config/builtin-agents.ts`:

```typescript
import { mySystemRegistration } from '../agent/my-system/registration.js';

export const builtinAgents: AgentRegistration[] = [
  // ...existing agents...
  mySystemRegistration,
];
```

This is the only file outside your agent directory that you need to modify.

## Step 6: Add Tests

Write unit tests in `src/__tests__/` that exercise your agent through the simulator.

At minimum, test:

- **assessHealth** returns correct status for healthy, degraded, and recovered states.
- **diagnose** identifies the right scenario and produces appropriate findings.
- **plan** generates a valid recovery plan that passes the validator.
- **replan** handles continuation, revision, and abort cases.
- **Simulator state transitions** advance correctly as commands execute.

Follow the existing test patterns. Use the simulator backend so tests run without external dependencies.

Run your tests:

```bash
pnpm test                # All tests
pnpm run test:watch      # Watch mode during development
pnpm run typecheck       # Verify type correctness
```

## Recovery Plan Steps

Your agent's `plan()` method builds a `RecoveryPlan` containing typed `RecoveryStep` entries. Seven step types are available (defined in `src/types/step-types.ts`):

| Type | Purpose | When to use |
|---|---|---|
| `diagnosis_action` | Read-only data gathering | First steps: collect system state before acting |
| `human_notification` | Alert stakeholders | Required when plan includes elevated+ risk steps |
| `checkpoint` | Capture state before mutations | Before any system_action at elevated risk or higher |
| `system_action` | Execute a command with preconditions and success criteria | The actual recovery operations |
| `human_approval` | Gate execution pending human decision | Before high-risk or irreversible actions |
| `replanning_checkpoint` | Agent can revise the remaining plan | After major state changes where the plan may need adaptation |
| `conditional` | Branch based on system state | When the next action depends on a runtime check |

A typical recovery plan follows this shape:

1. `diagnosis_action` -- gather current state
2. `human_notification` -- alert the on-call team
3. `checkpoint` -- capture pre-recovery state
4. `system_action` (routine) -- safe first action
5. `replanning_checkpoint` -- reassess after initial action
6. `human_approval` -- gate before riskier action
7. `system_action` (elevated/high) -- the main recovery operation
8. `conditional` -- branch based on outcome
9. `human_notification` -- send recovery summary

## Safety Checklist

The framework validator (`src/framework/validator.ts`) enforces these rules. Plans that violate them are rejected before any execution occurs.

| Rule | What it means |
|---|---|
| Step IDs must be unique | No two steps in a plan can share a `stepId` |
| `system_action` at elevated+ risk needs `statePreservation.before` | You must capture state before risky mutations |
| Plans with elevated+ steps need `human_notification` | Stakeholders must be notified before risky work |
| Plans must have a `rollbackStrategy` | Declare how to undo the plan if something goes wrong |
| `system_action` must declare `blastRadius` | List which components are affected |
| No nested conditionals | A `conditional` step's `thenStep`/`elseStep` cannot itself be a `conditional` |
| Risk level cannot exceed manifest `maxRiskLevel` | An agent with `maxRiskLevel: 'elevated'` cannot produce `high` risk steps |

Common validation failures when developing a new agent:

- Forgetting `statePreservation.before` on elevated risk `system_action` steps.
- Missing `human_notification` step in plans with elevated+ actions.
- Omitting the `rollbackStrategy` from the `RecoveryPlan`.
- Duplicate step IDs (especially when building steps in a loop).
- Using a risk level higher than what the manifest allows.
