# Building a Recovery Agent

This guide walks through creating a new CrisisMode recovery agent from scratch. By the end, you will have a working agent with a simulator, manifest, and test coverage.

## Prerequisites

Your agent package needs these dependencies:

```bash
npm install @crisismode/agent-sdk
```

TypeScript with strict mode and ESM modules (`"type": "module"` in `package.json`). All imports use `.js` extensions (NodeNext module resolution).

## Agent File Structure

Every agent follows a six-file pattern inside `src/agent/<system>/`:

```
src/agent/mydb/
  backend.ts        # System-specific interface extending ExecutionBackend
  simulator.ts      # In-memory implementation for demos and tests
  live-client.ts    # Real infrastructure client
  manifest.ts       # AgentManifest — capabilities, risk, triggers
  agent.ts          # RecoveryAgent implementation
  registration.ts   # Lazy factory for the agent registry
```

## Step 1: Define the Backend Interface

Start by extending `ExecutionBackend` with methods specific to your system. The execution engine depends on the generic `ExecutionBackend` contract; your agent uses the extended interface for diagnosis.

```typescript
// src/agent/mydb/backend.ts
import type { ExecutionBackend } from '@crisismode/agent-sdk';

export interface ClusterNode {
  id: string;
  role: 'leader' | 'follower';
  healthy: boolean;
  lag_ms: number;
}

export interface MyDbBackend extends ExecutionBackend {
  /** Query the cluster membership table */
  queryClusterNodes(): Promise<ClusterNode[]>;

  /** Check if the leader is accepting writes */
  isLeaderWritable(): Promise<boolean>;

  /** Get current connection count */
  queryConnectionCount(): Promise<number>;
}
```

Keep diagnosis methods read-only. Mutations happen through the `executeCommand()` method inherited from `ExecutionBackend`.

## Step 2: Build the Simulator

The simulator is the first implementation you write. It enables demo mode, unit tests, and dry-run execution without real infrastructure.

```typescript
// src/agent/mydb/simulator.ts
import type { MyDbBackend, ClusterNode } from './backend.js';
import type { Command } from '@crisismode/agent-sdk';

type SimState = 'degraded' | 'recovering' | 'recovered';

export class MyDbSimulator implements MyDbBackend {
  private state: SimState = 'degraded';

  transition(to: string): void {
    this.state = to as SimState;
  }

  async queryClusterNodes(): Promise<ClusterNode[]> {
    if (this.state === 'degraded') {
      return [
        { id: 'node-1', role: 'leader', healthy: true, lag_ms: 0 },
        { id: 'node-2', role: 'follower', healthy: false, lag_ms: 5000 },
      ];
    }
    return [
      { id: 'node-1', role: 'leader', healthy: true, lag_ms: 0 },
      { id: 'node-2', role: 'follower', healthy: true, lag_ms: 12 },
    ];
  }

  async isLeaderWritable(): Promise<boolean> {
    return true;
  }

  async queryConnectionCount(): Promise<number> {
    return this.state === 'degraded' ? 450 : 120;
  }

  async executeCommand(_cmd: Command): Promise<unknown> {
    return { ok: true };
  }

  async evaluateCheck(check: unknown): Promise<boolean> {
    // Simplified: always passes in recovered state
    return this.state === 'recovered';
  }
}
```

Model realistic state transitions. The simulator should return different data for each state so that the agent's diagnosis logic gets exercised.

## Step 3: Implement the Agent

The agent implements four methods from the `RecoveryAgent` interface.

```typescript
// src/agent/mydb/agent.ts
import type { RecoveryAgent, ReplanResult } from '@crisismode/agent-sdk';
import type { AgentContext } from '../../types/agent-context.js';
import type { DiagnosisResult } from '../../types/diagnosis-result.js';
import type { HealthAssessment } from '../../types/health.js';
import type { RecoveryPlan } from '../../types/recovery-plan.js';
import type { ExecutionState } from '../../types/execution-state.js';
import { myDbManifest } from './manifest.js';
import type { MyDbBackend } from './backend.js';
import { MyDbSimulator } from './simulator.js';

export class MyDbAgent implements RecoveryAgent {
  manifest = myDbManifest;
  backend: MyDbBackend;

  constructor(backend?: MyDbBackend) {
    this.backend = backend ?? new MyDbSimulator();
  }

  async assessHealth(_context: AgentContext): Promise<HealthAssessment> {
    const nodes = await this.backend.queryClusterNodes();
    const unhealthy = nodes.filter(n => !n.healthy);
    const observedAt = new Date().toISOString();

    return {
      status: unhealthy.length > 0 ? 'unhealthy' : 'healthy',
      confidence: 0.95,
      summary: unhealthy.length > 0
        ? `${unhealthy.length} node(s) are unhealthy.`
        : 'All cluster nodes are healthy.',
      observedAt,
      signals: nodes.map(n => ({
        source: `node:${n.id}`,
        status: n.healthy ? 'healthy' : 'critical',
        detail: `${n.role}, lag: ${n.lag_ms}ms`,
        observedAt,
      })),
      recommendedActions: unhealthy.length > 0
        ? ['Run diagnosis to identify the root cause.']
        : [],
    };
  }

  async diagnose(_context: AgentContext): Promise<DiagnosisResult> {
    const nodes = await this.backend.queryClusterNodes();
    const unhealthy = nodes.filter(n => !n.healthy);

    return {
      status: unhealthy.length > 0 ? 'identified' : 'healthy',
      scenario: 'follower_degradation',
      confidence: 0.90,
      findings: [
        {
          source: 'cluster_membership',
          observation: `${unhealthy.length} unhealthy follower(s) detected.`,
          severity: unhealthy.length > 0 ? 'critical' : 'info',
          data: { nodes },
        },
      ],
      diagnosticPlanNeeded: false,
    };
  }

  async plan(_context: AgentContext, diagnosis: DiagnosisResult): Promise<RecoveryPlan> {
    // Build steps dynamically based on diagnosis findings.
    // Never hardcode hostnames or IPs — discover them from diagnosis data.
    // See src/agent/pg-replication/agent.ts for a complete reference.
    // ...
  }

  async replan(
    _context: AgentContext,
    _diagnosis: DiagnosisResult,
    _state: ExecutionState,
  ): Promise<ReplanResult> {
    return { action: 'continue' };
  }
}
```

Key rules for agent implementation:

- **Never hardcode infrastructure identifiers.** Discover hosts, IPs, and resource names from diagnosis data.
- **Use `createPlanEnvelope()`** from `src/framework/plan-helpers.js` for consistent plan metadata.
- **Every `system_action` at `elevated` or higher risk must have `statePreservation.before` captures.**
- **Every plan with `elevated+` steps must include a `human_notification` step.**
- **Every plan must have a `rollbackStrategy`.**

## Step 4: Create the Manifest

The manifest declares the agent's capabilities, risk profile, and trigger conditions.

```typescript
// src/agent/mydb/manifest.ts
import type { AgentManifest } from '../../types/manifest.js';

export const myDbManifest: AgentManifest = {
  apiVersion: 'v0.2.1',
  kind: 'AgentManifest',
  metadata: {
    name: 'mydb-recovery',
    version: '1.0.0',
    description: 'Recovers MyDB cluster follower degradation.',
    authors: ['Your Team <team@example.com>'],
    license: 'Apache-2.0',
    tags: ['mydb', 'database', 'cluster'],
    plugin: {
      id: 'mydb.domain-pack',
      kind: 'domain_pack',
      maturity: 'experimental',
      compatibilityMode: 'recovery_agent',
    },
  },
  spec: {
    targetSystems: [
      {
        technology: 'mydb',
        versionConstraint: '>=3.0 <5.0',
        components: ['leader', 'follower'],
      },
    ],
    triggerConditions: [
      {
        type: 'alert',
        source: 'prometheus',
        matchLabels: { alertname: 'MyDbFollowerUnhealthy' },
      },
      {
        type: 'health_check',
        name: 'mydb_cluster_status',
        status: 'degraded',
      },
    ],
    failureScenarios: ['follower_degradation', 'leader_failover'],
    executionContexts: [
      {
        name: 'mydb_read',
        type: 'api',
        privilege: 'read',
        target: 'mydb',
        capabilities: ['mydb.query.read'],
      },
    ],
    observabilityDependencies: {
      required: ['mydb_cluster_status'],
      optional: ['prometheus_metrics'],
    },
    riskProfile: {
      maxRiskLevel: 'elevated',
      dataLossPossible: false,
      serviceDisruptionPossible: true,
    },
    humanInteraction: {
      requiresApproval: true,
      minimumApprovalRole: 'database_owner',
      escalationPath: ['on_call_dba', 'database_owner'],
    },
  },
};
```

Set `maxRiskLevel` to the highest risk any step in your agent's plans will use. Do not set `critical` without explicit discussion — critical operations require the highest level of human oversight.

## Step 5: Write the Registration

The registration provides a lazy factory that creates the agent and backend from target configuration.

```typescript
// src/agent/mydb/registration.ts
import type { AgentRegistration } from '../../config/agent-registration.js';
import { myDbManifest } from './manifest.js';

export const myDbRegistration: AgentRegistration = {
  kind: 'mydb',
  name: 'mydb-recovery',
  manifest: myDbManifest,

  async createAgent(target) {
    const { MyDbLiveClient } = await import('./live-client.js');
    const { MyDbAgent } = await import('./agent.js');

    const backend = new MyDbLiveClient(target);
    const agent = new MyDbAgent(backend);
    return { agent, backend, target };
  },
};
```

Then register your agent in `src/config/builtin-agents.ts`:

```typescript
import { myDbRegistration } from '../agent/mydb/registration.js';

// Add to the registrations array
registrations.push(myDbRegistration);
```

## Step 6: Write Tests

Use the simulator to test the full agent pipeline without real infrastructure.

```typescript
// src/__tests__/mydb-agent.test.ts
import { describe, it, expect } from 'vitest';
import { MyDbAgent } from '../agent/mydb/agent.js';
import { MyDbSimulator } from '../agent/mydb/simulator.js';
import { makeTestContext } from './helpers.js';

describe('MyDbAgent', () => {
  it('detects unhealthy followers', async () => {
    const sim = new MyDbSimulator();
    const agent = new MyDbAgent(sim);
    const ctx = makeTestContext();

    const health = await agent.assessHealth(ctx);
    expect(health.status).toBe('unhealthy');
  });

  it('produces a recovery plan', async () => {
    const sim = new MyDbSimulator();
    const agent = new MyDbAgent(sim);
    const ctx = makeTestContext();

    const diagnosis = await agent.diagnose(ctx);
    const plan = await agent.plan(ctx, diagnosis);

    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.rollbackStrategy).toBeDefined();
  });
});
```

Run tests with:

```bash
pnpm test
pnpm run typecheck
```

## Step 7: Distribute as a Plugin

To distribute your agent as a standalone plugin, create a `crisismode-agent.json` manifest at the package root:

```json
{
  "name": "mydb-recovery",
  "version": "1.0.0",
  "description": "MyDB cluster recovery agent",
  "main": "dist/agent.js",
  "agent": "mydb",
  "tags": ["mydb", "database"]
}
```

Users install your agent to `~/.crisismode/agents/` and CrisisMode discovers it automatically.

## Reference Implementation

The PostgreSQL replication agent at `src/agent/pg-replication/` is the canonical reference implementation. It demonstrates:

- A full backend interface with system-specific diagnosis methods
- A simulator with three state transitions (degraded, recovering, recovered)
- Dynamic plan generation based on diagnosis findings
- Replanning with slot repair when conditions change mid-flight
- All seven step types used in a real recovery scenario

Start there when you need a working example of any pattern described in this guide.
