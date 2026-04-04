# Your First Agent

This tutorial walks through building a CrisisMode recovery agent from scratch. You will create a "website health" agent that monitors an HTTP endpoint, diagnoses failures, and builds recovery plans.

**Time:** 2-4 hours

**Prerequisites:** TypeScript experience, a CrisisMode checkout with `pnpm install` completed.

For the full agent contract and all available options, see the [Agent Development Guide](creating-a-recovery-agent.md). The PostgreSQL replication agent at `src/agent/pg-replication/` is the canonical reference implementation.

## When to Write an Agent

CrisisMode offers three extension points. Choose based on what you need:

| Extension | When to use | Skill required | Time |
|---|---|---|---|
| **Check plugin** | You want to add a health check. Shell script, no recovery logic. | Bash | 30 min |
| **Playbook** | You want to codify a runbook. Markdown steps, no TypeScript. | Markdown + YAML | 1 hour |
| **Agent** | You need programmatic diagnosis and dynamic recovery planning. | TypeScript | Half day |

Write an agent when:

- The diagnosis logic requires parsing structured data and making decisions based on thresholds or combinations of signals.
- The recovery plan varies depending on what the diagnosis finds (e.g., different steps for "service down" vs. "service slow").
- You need the full safety infrastructure: state preservation, approval gates, blast radius enforcement, replanning.

If you just need to check a port or validate a certificate, a [check plugin](your-first-check-plugin.md) is simpler. If you have a fixed recovery runbook, a [playbook](../playbook-authoring.md) is easier to maintain.

## The 6-File Pattern

Every agent follows this structure:

```
src/agent/<system>/
  backend.ts        # Interface for querying the target system
  simulator.ts      # In-memory implementation for demos and tests
  live-client.ts    # Real infrastructure client (can come later)
  manifest.ts       # Agent metadata: capabilities, risk profile, triggers
  agent.ts          # RecoveryAgent implementation: diagnose, plan, replan
  registration.ts   # Lazy factory for the agent registry
```

We will build each file in order.

## Step 1: Define the Backend Interface

The backend interface defines the queries your agent needs. The agent codes against this interface, not against specific HTTP libraries or system clients. This separation is what makes the simulator possible.

Create `src/agent/website/backend.ts`:

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { ExecutionBackend } from '../../framework/backend.js';

/** Response from probing the website */
export interface WebsiteProbe {
  url: string;
  reachable: boolean;
  httpStatus: number | null;
  responseTimeMs: number;
  tlsValid: boolean | null;
  error: string | null;
}

/** Website configuration */
export interface WebsiteConfig {
  url: string;
  expectedStatus: number;
  maxResponseTimeMs: number;
}

export interface WebsiteBackend extends ExecutionBackend {
  /** Probe the website and return its current state */
  probe(): Promise<WebsiteProbe>;

  /** Get the website configuration */
  getConfig(): Promise<WebsiteConfig>;
}
```

Key decisions:

- **Extend `ExecutionBackend`.** This gives you `executeCommand()`, `evaluateCheck()`, and `close()` -- the interface the execution engine uses to run plan steps.
- **Keep it focused.** Only expose what the agent needs. Two methods are enough for this agent.
- **Separate read from write.** Both methods here are read-only. Write operations happen through `executeCommand()` in the plan execution phase.

## Step 2: Build the Simulator

The simulator implements your backend interface with in-memory state. Build this first -- it enables testing and demo mode without any real infrastructure.

Create `src/agent/website/simulator.ts`:

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { WebsiteBackend, WebsiteProbe, WebsiteConfig } from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderInfo } from '../../types/plugin.js';

export type SimulatorState = 'degraded' | 'recovering' | 'recovered';

export class WebsiteSimulator implements WebsiteBackend {
  private state: SimulatorState = 'degraded';

  transition(to: string): void {
    this.state = to as SimulatorState;
  }

  async probe(): Promise<WebsiteProbe> {
    switch (this.state) {
      case 'degraded':
        return {
          url: 'https://api.example.com',
          reachable: false,
          httpStatus: null,
          responseTimeMs: 0,
          tlsValid: null,
          error: 'Connection refused',
        };
      case 'recovering':
        return {
          url: 'https://api.example.com',
          reachable: true,
          httpStatus: 503,
          responseTimeMs: 8500,
          tlsValid: true,
          error: null,
        };
      case 'recovered':
        return {
          url: 'https://api.example.com',
          reachable: true,
          httpStatus: 200,
          responseTimeMs: 120,
          tlsValid: true,
          error: null,
        };
    }
  }

  async getConfig(): Promise<WebsiteConfig> {
    return {
      url: 'https://api.example.com',
      expectedStatus: 200,
      maxResponseTimeMs: 5000,
    };
  }

  async executeCommand(command: Command): Promise<unknown> {
    // Simulate the effect of recovery commands
    if (command.raw?.includes('restart') || command.raw?.includes('reload')) {
      this.state = 'recovering';
    }
    return { simulated: true, command: command.raw };
  }

  async evaluateCheck(check: CheckExpression): Promise<boolean> {
    if (check.raw?.includes('reachable')) {
      return this.state === 'recovered';
    }
    if (check.raw?.includes('status_200')) {
      return this.state === 'recovered';
    }
    return true;
  }

  async listCapabilityProviders(): Promise<CapabilityProviderInfo[]> {
    return [
      {
        id: 'website-simulator',
        capabilities: ['http.request', 'service.restart'],
        priority: 1,
      },
    ];
  }

  async close(): Promise<void> {}
}
```

Model at least three states:

- **degraded** -- the failure the agent handles (site unreachable)
- **recovering** -- intermediate state after initial actions (site responding but unhealthy)
- **recovered** -- healthy state (site responding normally)

The `transition()` method lets the execution engine advance the simulator as plan steps execute.

## Step 3: Write the Manifest

The manifest declares what your agent targets, what it can do, and what risk level it operates at. It is a data declaration -- no logic, no heavy imports.

Create `src/agent/website/manifest.ts`:

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentManifest } from '../../types/manifest.js';

export const websiteManifest: AgentManifest = {
  apiVersion: 'v0.2.1',
  kind: 'AgentManifest',
  metadata: {
    name: 'website-health-recovery',
    version: '1.0.0',
    description:
      'Monitors website availability and response time. Diagnoses outages, slow responses, and TLS issues. Plans recovery actions including service restarts and traffic rerouting.',
    authors: ['Your Name <you@example.com>'],
    license: 'Apache-2.0',
    tags: ['website', 'http', 'availability', 'response-time'],
    plugin: {
      id: 'website.health',
      kind: 'domain_pack',
      maturity: 'simulator_only',
      compatibilityMode: 'recovery_agent',
    },
  },
  spec: {
    targetSystems: [
      {
        technology: 'http',
        versionConstraint: '*',
        components: ['endpoint', 'service'],
      },
    ],
    triggerConditions: [
      { type: 'alert', source: 'prometheus', matchLabels: { alertname: 'EndpointDown' } },
      { type: 'health_check', name: 'website_health', status: 'degraded' },
      { type: 'manual', description: 'Operator-initiated website health check' },
    ],
    failureScenarios: [
      'endpoint_unreachable',
      'http_error_response',
      'high_response_time',
    ],
    executionContexts: [
      {
        name: 'website_read',
        type: 'api_call',
        privilege: 'read',
        target: 'http-endpoint',
        allowedOperations: ['probe', 'get_config'],
        capabilities: ['http.request'],
      },
      {
        name: 'website_admin',
        type: 'system_command',
        privilege: 'admin',
        target: 'application-service',
        allowedOperations: ['restart', 'reload'],
        capabilities: ['service.restart'],
      },
    ],
    observabilityDependencies: {
      required: ['endpoint_http_status'],
      optional: ['endpoint_response_time', 'tls_certificate_status'],
    },
    riskProfile: {
      maxRiskLevel: 'elevated',
      dataLossPossible: false,
      serviceDisruptionPossible: true,
    },
    humanInteraction: {
      requiresApproval: true,
      minimumApprovalRole: 'on_call_engineer',
      escalationPath: ['on_call_engineer', 'engineering_lead'],
    },
  },
};
```

### Important manifest fields

- **`plugin.maturity`** -- set to `"simulator_only"` until you build a live client. Change to `"beta"` or `"stable"` later.
- **`riskProfile.maxRiskLevel`** -- the maximum risk any step in your plans can declare. Do not set to `"critical"` without discussion with maintainers.
- **`failureScenarios`** -- string identifiers that your `diagnose()` method returns. The framework uses these to match agents to incidents.

## Step 4: Implement the Agent

This is where your domain expertise lives. The agent implements four methods:

| Method | Purpose | Reads system? | Mutates system? |
|---|---|---|---|
| `assessHealth` | Quick health probe (runs during `scan`) | Yes | No |
| `diagnose` | Deep inspection producing structured findings | Yes | No |
| `plan` | Build a recovery plan from diagnosis findings | No | No |
| `replan` | Adapt the plan mid-execution | Yes | No |

The agent never executes recovery actions directly. It builds a `RecoveryPlan` containing typed steps. The framework validates and executes those steps.

Create `src/agent/website/agent.ts`:

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RecoveryAgent, ReplanResult } from '../interface.js';
import type { AgentContext } from '../../types/agent-context.js';
import type { DiagnosisResult } from '../../types/diagnosis-result.js';
import type { ExecutionState } from '../../types/execution-state.js';
import type { HealthAssessment, HealthSignal } from '../../types/health.js';
import type { RecoveryPlan } from '../../types/recovery-plan.js';
import type { RecoveryStep } from '../../types/step-types.js';
import { signalStatus, buildHealthAssessment } from '../../framework/health-helpers.js';
import { createPlanEnvelope } from '../../framework/plan-helpers.js';
import { defaultReplan } from '../interface.js';
import { websiteManifest } from './manifest.js';
import type { WebsiteBackend } from './backend.js';
import { WebsiteSimulator } from './simulator.js';

export class WebsiteHealthAgent implements RecoveryAgent {
  manifest = websiteManifest;
  backend: WebsiteBackend;

  constructor(backend?: WebsiteBackend) {
    this.backend = backend ?? new WebsiteSimulator();
  }

  // ── assessHealth ──
  // Quick probe for crisismode scan. Must complete in under 2 seconds.

  async assessHealth(_context: AgentContext): Promise<HealthAssessment> {
    const observedAt = new Date().toISOString();
    const probe = await this.backend.probe();
    const config = await this.backend.getConfig();

    const unreachable = !probe.reachable;
    const httpError = probe.httpStatus !== null && probe.httpStatus !== config.expectedStatus;
    const slow = probe.responseTimeMs > config.maxResponseTimeMs;

    const status = unreachable
      ? 'unhealthy'
      : httpError
        ? 'unhealthy'
        : slow
          ? 'recovering'
          : 'healthy';

    const signals: HealthSignal[] = [
      {
        source: 'http_reachability',
        status: signalStatus(unreachable, false),
        detail: unreachable
          ? `${probe.url} is unreachable: ${probe.error}`
          : `${probe.url} is reachable (HTTP ${probe.httpStatus})`,
        observedAt,
      },
      {
        source: 'response_time',
        status: signalStatus(false, slow),
        detail: `Response time: ${probe.responseTimeMs}ms (threshold: ${config.maxResponseTimeMs}ms)`,
        observedAt,
      },
    ];

    const recommendedActions: string[] = [];
    if (unreachable) recommendedActions.push('Check if the service process is running');
    if (httpError) recommendedActions.push(`Investigate HTTP ${probe.httpStatus} response`);
    if (slow) recommendedActions.push('Investigate high response time');

    return buildHealthAssessment({
      status,
      confidence: unreachable ? 0.95 : 0.9,
      summary: unreachable
        ? `Website unreachable: ${probe.error}`
        : httpError
          ? `Website returning HTTP ${probe.httpStatus}`
          : slow
            ? `Website slow: ${probe.responseTimeMs}ms`
            : 'Website healthy',
      observedAt,
      signals,
      recommendedActions,
    });
  }

  // ── diagnose ──
  // Deeper inspection that produces structured findings and a scenario.

  async diagnose(_context: AgentContext): Promise<DiagnosisResult> {
    const probe = await this.backend.probe();
    const config = await this.backend.getConfig();

    if (!probe.reachable) {
      return {
        healthy: false,
        scenario: 'endpoint_unreachable',
        summary: `Website at ${probe.url} is unreachable: ${probe.error}`,
        findings: [
          {
            id: 'unreachable',
            severity: 'critical',
            title: 'Endpoint unreachable',
            detail: `Cannot connect to ${probe.url}. Error: ${probe.error}`,
          },
        ],
      };
    }

    if (probe.httpStatus !== null && probe.httpStatus >= 500) {
      return {
        healthy: false,
        scenario: 'http_error_response',
        summary: `Website returning HTTP ${probe.httpStatus}`,
        findings: [
          {
            id: 'http-error',
            severity: 'critical',
            title: 'Server error response',
            detail: `${probe.url} returned HTTP ${probe.httpStatus}`,
          },
        ],
      };
    }

    if (probe.responseTimeMs > config.maxResponseTimeMs) {
      return {
        healthy: false,
        scenario: 'high_response_time',
        summary: `Website response time ${probe.responseTimeMs}ms exceeds ${config.maxResponseTimeMs}ms threshold`,
        findings: [
          {
            id: 'slow-response',
            severity: 'warning',
            title: 'High response time',
            detail: `Response time ${probe.responseTimeMs}ms exceeds threshold of ${config.maxResponseTimeMs}ms`,
          },
        ],
      };
    }

    return {
      healthy: true,
      scenario: null,
      summary: `Website at ${probe.url} is healthy (HTTP ${probe.httpStatus}, ${probe.responseTimeMs}ms)`,
      findings: [],
    };
  }

  // ── plan ──
  // Build a recovery plan based on what diagnose found.
  // Plans are dynamic -- the steps vary based on the diagnosis scenario.

  async plan(
    _context: AgentContext,
    diagnosis: DiagnosisResult,
  ): Promise<RecoveryPlan> {
    const steps: RecoveryStep[] = [];

    // Step 1: Always start with a diagnosis action to gather current state
    steps.push({
      stepId: 'website-diag-1',
      type: 'diagnosis_action',
      name: 'Gather service status',
      description: 'Check the application process and recent logs',
      executionContext: 'website_read',
      command: { raw: 'systemctl status web-service && journalctl -u web-service --since "10 minutes ago" --no-pager | tail -50' },
    });

    // Step 2: Notify the on-call team
    steps.push({
      stepId: 'website-notify-1',
      type: 'human_notification',
      name: 'Notify on-call',
      description: `Website issue detected: ${diagnosis.summary}`,
      channel: 'default',
      message: `CrisisMode detected a website issue:\n\nScenario: ${diagnosis.scenario}\nSummary: ${diagnosis.summary}`,
      templateName: 'incident_start',
    });

    // Step 3: Capture pre-recovery state
    steps.push({
      stepId: 'website-checkpoint-1',
      type: 'checkpoint',
      name: 'Capture pre-recovery state',
      description: 'Snapshot service state before recovery actions',
      captures: [
        {
          name: 'service-status',
          target: 'application-service',
          capturePolicy: 'best_effort',
        },
      ],
    });

    // Step 4: Recovery action depends on the scenario
    if (diagnosis.scenario === 'endpoint_unreachable' || diagnosis.scenario === 'http_error_response') {
      steps.push({
        stepId: 'website-action-1',
        type: 'system_action',
        name: 'Restart the service',
        description: 'Restart the application service to restore availability',
        executionContext: 'website_admin',
        command: { raw: 'systemctl restart web-service' },
        riskLevel: 'elevated',
        blastRadius: {
          affectedComponents: ['application-service'],
          maxAffectedInstances: 1,
        },
        statePreservation: {
          before: [
            {
              name: 'pre-restart-state',
              target: 'application-service',
              capturePolicy: 'required',
            },
          ],
        },
        precondition: { raw: 'systemctl is-enabled web-service' },
        successCriteria: { raw: 'status_200' },
        rollback: { raw: 'systemctl stop web-service' },
      });
    } else if (diagnosis.scenario === 'high_response_time') {
      steps.push({
        stepId: 'website-action-1',
        type: 'system_action',
        name: 'Reload service configuration',
        description: 'Reload the service to clear stale connections',
        executionContext: 'website_admin',
        command: { raw: 'systemctl reload web-service' },
        riskLevel: 'routine',
        blastRadius: {
          affectedComponents: ['application-service'],
          maxAffectedInstances: 1,
        },
        precondition: { raw: 'reachable' },
        successCriteria: { raw: 'status_200' },
      });
    }

    // Step 5: Replanning checkpoint -- reassess after the action
    steps.push({
      stepId: 'website-replan-1',
      type: 'replanning_checkpoint',
      name: 'Reassess after recovery action',
      description: 'Check whether the recovery action resolved the issue',
      timeoutSeconds: 60,
    });

    // Step 6: Completion notification
    steps.push({
      stepId: 'website-notify-2',
      type: 'human_notification',
      name: 'Recovery summary',
      description: 'Notify the team of recovery outcome',
      channel: 'default',
      message: 'Website recovery actions completed. Check the health dashboard.',
      templateName: 'incident_update',
    });

    return createPlanEnvelope({
      name: `website-recovery-${diagnosis.scenario ?? 'unknown'}`,
      description: `Recovery plan for: ${diagnosis.summary}`,
      steps,
      rollbackStrategy: {
        description: 'Stop the service and page the on-call engineer for manual investigation.',
      },
    });
  }

  // ── replan ──
  // Called at replanning_checkpoint steps. Use defaultReplan for simple agents.

  async replan(
    context: AgentContext,
    diagnosis: DiagnosisResult,
    executionState: ExecutionState,
  ): Promise<ReplanResult> {
    // Re-probe the system to see if the recovery action helped
    const probe = await this.backend.probe();

    if (probe.reachable && probe.httpStatus === 200) {
      return { action: 'continue' };
    }

    // If still unhealthy, abort and let the human take over
    return {
      action: 'abort',
      reason: `Website still unhealthy after recovery action (HTTP ${probe.httpStatus ?? 'unreachable'}). Escalating to human operator.`,
    };
  }
}
```

### Safety rules to remember

The framework validator will reject plans that violate these rules:

- Every `system_action` at `elevated` risk or higher **must** have `statePreservation.before`.
- Plans with `elevated+` steps **must** include a `human_notification` step.
- Plans **must** have a `rollbackStrategy`.
- Step IDs must be unique.
- Risk levels cannot exceed the manifest's `maxRiskLevel`.

## Step 5: Create the Registration

The registration provides a lazy factory so your agent's dependencies are only imported when it is actually needed.

Create `src/agent/website/registration.ts`:

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentRegistration } from '../../config/agent-registration.js';
import { websiteManifest } from './manifest.js';

export const websiteRecoveryRegistration: AgentRegistration = {
  kind: 'http',
  name: 'website-health-recovery',
  manifest: websiteManifest,

  async createAgent(target) {
    const { WebsiteHealthAgent } = await import('./agent.js');
    const { WebsiteSimulator } = await import('./simulator.js');

    const backend = new WebsiteSimulator();
    const agent = new WebsiteHealthAgent(backend);
    return { agent, backend, target };
  },
};
```

The `kind` field determines which detected services this agent handles. Dynamic `import()` ensures the agent's code is only loaded when needed.

## Step 6: Register the Agent

Add your registration to `src/config/builtin-agents.ts`:

```typescript
import { websiteRecoveryRegistration } from '../agent/website/registration.js';

export const builtinAgents: AgentRegistration[] = [
  // ...existing agents...
  websiteRecoveryRegistration,
];
```

This is the only file outside your agent directory that you need to modify.

## Step 7: Test It

### Run the demo

The simulator powers the demo command:

```bash
npx tsx src/cli/index.ts demo
```

Select your agent from the list to see the full diagnosis-plan-execute cycle running against simulated data.

### Write unit tests

Create tests in `src/__tests__/` that exercise your agent through the simulator. At minimum, test:

- `assessHealth` returns correct status for healthy, degraded, and recovered states.
- `diagnose` identifies the right scenario and produces appropriate findings.
- `plan` generates a valid recovery plan that passes the validator.
- `replan` handles continuation and abort cases.
- Simulator state transitions advance correctly.

Example test structure:

```typescript
import { describe, it, expect } from 'vitest';
import { WebsiteHealthAgent } from '../agent/website/agent.js';
import { WebsiteSimulator } from '../agent/website/simulator.js';

describe('WebsiteHealthAgent', () => {
  it('diagnoses unreachable endpoint', async () => {
    const simulator = new WebsiteSimulator();
    const agent = new WebsiteHealthAgent(simulator);

    const result = await agent.diagnose({} as any);
    expect(result.healthy).toBe(false);
    expect(result.scenario).toBe('endpoint_unreachable');
  });

  it('reports healthy after recovery', async () => {
    const simulator = new WebsiteSimulator();
    simulator.transition('recovered');
    const agent = new WebsiteHealthAgent(simulator);

    const health = await agent.assessHealth({} as any);
    expect(health.status).toBe('healthy');
  });

  it('builds valid recovery plan', async () => {
    const simulator = new WebsiteSimulator();
    const agent = new WebsiteHealthAgent(simulator);

    const diagnosis = await agent.diagnose({} as any);
    const plan = await agent.plan({} as any, diagnosis);

    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.rollbackStrategy).toBeDefined();

    // Verify elevated steps have statePreservation
    const elevatedSteps = plan.steps.filter(
      (s) => s.type === 'system_action' && s.riskLevel !== 'routine'
    );
    for (const step of elevatedSteps) {
      expect(step.statePreservation?.before).toBeDefined();
    }
  });
});
```

### Run the tests

```bash
pnpm test                # All tests
pnpm run test:watch      # Watch mode during development
pnpm run typecheck       # Verify type safety
```

## Adding a Live Client

Once your agent works against the simulator, you can add a live client that talks to real infrastructure. Create `src/agent/website/live-client.ts` implementing `WebsiteBackend` with real HTTP calls.

Update `registration.ts` to use the live client when a real target is available:

```typescript
async createAgent(target) {
  const { WebsiteHealthAgent } = await import('./agent.js');

  const hasLiveTarget = target.primary.host !== 'simulator'
    && target.primary.host !== 'default'
    && target.primary.host !== '';

  if (hasLiveTarget) {
    try {
      const { WebsiteLiveClient } = await import('./live-client.js');
      const backend = new WebsiteLiveClient(target.primary.host, target.primary.port);
      return { agent: new WebsiteHealthAgent(backend), backend, target };
    } catch {
      // Fall back to simulator
    }
  }

  const { WebsiteSimulator } = await import('./simulator.js');
  const backend = new WebsiteSimulator();
  return { agent: new WebsiteHealthAgent(backend), backend, target };
},
```

Update the manifest's `plugin.maturity` from `"simulator_only"` to `"beta"` once the live client is working.

## Distributing as a Plugin

To distribute your agent as a standalone package (outside the CrisisMode repo), create a `crisismode-agent.json` manifest at the package root:

```json
{
  "name": "website-health-recovery",
  "version": "1.0.0",
  "description": "Website availability and response time recovery",
  "kind": "agent",
  "entryPoint": "./dist/agent.js",
  "targetKinds": ["http"],
  "crisismode": { "minVersion": "0.3.0" }
}
```

Users install to `~/.crisismode/agents/` and CrisisMode discovers it automatically. See `src/framework/registry/types.ts` for the full `AgentPluginManifest` schema.

## Summary

You built a complete recovery agent:

1. **backend.ts** -- defined the queries the agent needs
2. **simulator.ts** -- modeled healthy and degraded states in memory
3. **manifest.ts** -- declared capabilities, risk profile, and triggers
4. **agent.ts** -- implemented `assessHealth`, `diagnose`, `plan`, and `replan`
5. **registration.ts** -- created a lazy factory for the registry
6. **builtin-agents.ts** -- registered the agent

## Next Steps

- Study `src/agent/pg-replication/` for a full reference implementation with all seven step types.
- Read the [Agent Development Guide](creating-a-recovery-agent.md) for the complete contract, safety checklist, and manifest reference.
- Read the [Recovery Agent Contract](../../specs/foundational/recovery-agent-contract.md) for the authoritative specification.
- Browse `src/agent/redis/` and `src/agent/tls/` for simpler agent examples.
