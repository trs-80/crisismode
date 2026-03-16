// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';
import { MemorySaver } from '@langchain/langgraph';

// Mock the Anthropic SDK so agent.ts can be imported without the dependency
vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }));

// Mock the coordinator so human_approval steps don't block on stdin
vi.mock('../framework/coordinator.js', () => ({
  requestApproval: vi.fn(async () => 'approved'),
  shouldAutoApprove: vi.fn(() => true),
}));

import { RecoveryGraphEngine } from '../framework/graph-engine.js';
import { PgReplicationAgent } from '../agent/pg-replication/agent.js';
import { PgSimulator } from '../agent/pg-replication/simulator.js';
import { RedisMemoryAgent } from '../agent/redis/agent.js';
import { RedisSimulator } from '../agent/redis/simulator.js';
import { ForensicRecorder } from '../framework/forensics.js';
import { assembleContext } from '../framework/context.js';
import type { AgentContext } from '../types/agent-context.js';
import type { ExecutionBackend } from '../framework/backend.js';
import type { RecoveryPlan } from '../types/recovery-plan.js';
import type { SystemActionStep } from '../types/step-types.js';

function setup() {
  const simulator = new PgSimulator();
  const agent = new PgReplicationAgent(simulator);
  const trigger: AgentContext['trigger'] = {
    type: 'alert',
    source: 'prometheus',
    payload: {
      alertname: 'PostgresReplicationLagCritical',
      instance: 'pg-primary-us-east-1',
      severity: 'critical',
    },
    receivedAt: new Date().toISOString(),
  };
  const context = assembleContext(trigger, agent.manifest);
  const recorder = new ForensicRecorder();
  recorder.setContext(context);

  return { simulator, agent, context, recorder };
}

function setupRedis() {
  const simulator = new RedisSimulator();
  const agent = new RedisMemoryAgent(simulator);
  const trigger: AgentContext['trigger'] = {
    type: 'alert',
    source: 'prometheus',
    payload: {
      alertname: 'RedisMemoryPressureCritical',
      instance: 'redis-primary-us-east-1',
      severity: 'critical',
    },
    receivedAt: new Date().toISOString(),
  };
  const context = assembleContext(trigger, agent.manifest);
  const recorder = new ForensicRecorder();
  recorder.setContext(context);

  return { simulator, agent, context, recorder };
}

describe('RecoveryGraphEngine', () => {
  it('executes a full plan in dry-run mode', async () => {
    const { simulator, agent, context, recorder } = setup();
    const diagnosis = await agent.diagnose(context);
    const plan = await agent.plan(context, diagnosis);
    recorder.setDiagnosis(diagnosis);
    recorder.addPlan(plan);

    const engine = new RecoveryGraphEngine(
      context,
      agent.manifest,
      agent,
      recorder,
      simulator,
      'dry-run',
      { checkpointer: new MemorySaver() },
    );
    engine.setCoveredRiskLevels(['routine', 'elevated']);

    const results = await engine.executePlan(plan, diagnosis);
    expect(results.length).toBe(plan.steps.length);

    const failedSteps = results.filter((r) => r.status === 'failed');
    expect(failedSteps.length).toBe(0);
  });

  it('triggers state transitions via stateTransition field', async () => {
    const { simulator, agent, context, recorder } = setup();
    const diagnosis = await agent.diagnose(context);
    const plan = await agent.plan(context, diagnosis);
    recorder.setDiagnosis(diagnosis);
    recorder.addPlan(plan);

    const engine = new RecoveryGraphEngine(
      context,
      agent.manifest,
      agent,
      recorder,
      simulator,
      'dry-run',
      { checkpointer: new MemorySaver() },
    );
    engine.setCoveredRiskLevels(['routine', 'elevated']);

    expect(simulator.getState()).toBe('degraded');
    await engine.executePlan(plan, diagnosis);
    expect(simulator.getState()).toBe('recovered');
  });

  it('invokes callbacks during execution', async () => {
    const { simulator, agent, context, recorder } = setup();
    const diagnosis = await agent.diagnose(context);
    const plan = await agent.plan(context, diagnosis);
    recorder.setDiagnosis(diagnosis);
    recorder.addPlan(plan);

    const stepsStarted: string[] = [];
    const engine = new RecoveryGraphEngine(
      context,
      agent.manifest,
      agent,
      recorder,
      simulator,
      'dry-run',
      {
        checkpointer: new MemorySaver(),
        callbacks: {
          onStepStart: (step) => stepsStarted.push(step.stepId),
        },
      },
    );
    engine.setCoveredRiskLevels(['routine', 'elevated']);

    await engine.executePlan(plan, diagnosis);
    expect(stepsStarted.length).toBeGreaterThanOrEqual(plan.steps.length);
  });

  it('stops execution on step failure', async () => {
    const { simulator, agent, context, recorder } = setup();
    const diagnosis = await agent.diagnose(context);
    const plan = await agent.plan(context, diagnosis);
    recorder.setDiagnosis(diagnosis);
    recorder.addPlan(plan);

    // Break the simulator so preconditions fail for step-004
    const origEval = simulator.evaluateCheck.bind(simulator);
    let callCount = 0;
    simulator.evaluateCheck = async (check) => {
      callCount++;
      if (check.statement?.includes("client_addr = '10.0.1.52'") && !check.statement.includes("state = 'streaming'") && callCount <= 5) {
        return false;
      }
      return origEval(check);
    };

    const engine = new RecoveryGraphEngine(
      context,
      agent.manifest,
      agent,
      recorder,
      simulator,
      'dry-run',
      { checkpointer: new MemorySaver() },
    );
    engine.setCoveredRiskLevels(['routine', 'elevated']);

    const results = await engine.executePlan(plan, diagnosis);
    const failed = results.find((r) => r.status === 'failed');
    expect(failed).toBeDefined();

    // Execution should stop after the failed step
    expect(results.length).toBeLessThan(plan.steps.length);
  });

  it('executes a Redis plan through the graph engine', async () => {
    const { simulator, agent, context, recorder } = setupRedis();
    const diagnosis = await agent.diagnose(context);
    const plan = await agent.plan(context, diagnosis);
    recorder.setDiagnosis(diagnosis);
    recorder.addPlan(plan);

    const engine = new RecoveryGraphEngine(
      context,
      agent.manifest,
      agent,
      recorder,
      simulator,
      'dry-run',
      { checkpointer: new MemorySaver() },
    );

    const results = await engine.executePlan(plan, diagnosis);
    expect(results).toHaveLength(plan.steps.length);
    expect(results.every((result) => result.status !== 'failed')).toBe(true);
  });

  it('blocks system actions when blast radius validation fails', async () => {
    const { simulator, agent, context, recorder } = setup();
    const diagnosis = await agent.diagnose(context);
    const plan = await agent.plan(context, diagnosis);
    recorder.setDiagnosis(diagnosis);
    recorder.addPlan(plan);

    const invalidStep = plan.steps.find((step) => step.stepId === 'step-004');
    if (!invalidStep || invalidStep.type !== 'system_action') {
      throw new Error('expected step-004 system_action in PostgreSQL recovery plan');
    }
    invalidStep.executionContext = 'unsupported_context';

    const engine = new RecoveryGraphEngine(
      context,
      agent.manifest,
      agent,
      recorder,
      simulator,
      'dry-run',
      { checkpointer: new MemorySaver() },
    );
    engine.setCoveredRiskLevels(['routine', 'elevated']);

    const results = await engine.executePlan(plan, diagnosis);
    const failed = results.find((result) => result.stepId === 'step-004');
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toContain('Blast radius validation failed');
  });

  it('stops execution when replanning aborts the run', async () => {
    const { simulator, agent, context, recorder } = setup();
    const diagnosis = await agent.diagnose(context);
    const plan = await agent.plan(context, diagnosis);
    recorder.setDiagnosis(diagnosis);
    recorder.addPlan(plan);

    agent.replan = async () => ({ action: 'abort', reason: 'manual escalation required' });

    const engine = new RecoveryGraphEngine(
      context,
      agent.manifest,
      agent,
      recorder,
      simulator,
      'dry-run',
      { checkpointer: new MemorySaver() },
    );
    engine.setCoveredRiskLevels(['routine', 'elevated']);

    const results = await engine.executePlan(plan, diagnosis);
    const checkpoint = results.find((result) => result.stepId === 'step-006');
    expect(checkpoint?.status).toBe('failed');
    expect(checkpoint?.error).toContain('manual escalation required');
    expect(results.at(-1)?.stepId).toBe('step-006');
  });

  it('marks a conditional step as skipped when the false branch is skip', async () => {
    const { agent, context, recorder } = setup();
    const diagnosis = await agent.diagnose(context);
    recorder.setDiagnosis(diagnosis);

    const executeCommand = vi.fn(async () => ({ ok: true }));
    const backend: ExecutionBackend = {
      executeCommand,
      evaluateCheck: async () => false,
      close: async () => {},
    };
    const plan: RecoveryPlan = {
      apiVersion: 'v0.2.1',
      kind: 'RecoveryPlan',
      metadata: {
        planId: 'conditional-skip',
        agentName: agent.manifest.metadata.name,
        agentVersion: agent.manifest.metadata.version,
        scenario: diagnosis.scenario ?? 'replication_lag_cascade',
        createdAt: new Date().toISOString(),
        estimatedDuration: 'PT1M',
        summary: 'Skip an optional branch and continue',
        supersedes: null,
      },
      impact: {
        affectedSystems: [],
        affectedServices: [],
        estimatedUserImpact: 'none',
        dataLossRisk: 'none',
      },
      steps: [
        {
          stepId: 'step-001',
          type: 'conditional',
          name: 'Skip optional action',
          condition: {
            description: 'Optional action is still required',
            check: {
              type: 'sql',
              statement: 'SELECT 0;',
              expect: { operator: 'eq', value: 1 },
            },
          },
          thenStep: {
            stepId: 'step-001a',
            type: 'human_notification',
            name: 'Optional notify',
            recipients: [{ role: 'on_call_dba', urgency: 'medium' }],
            message: { summary: 'Optional path', detail: 'Executed optional path', actionRequired: false },
            channel: 'auto',
          },
          elseStep: 'skip',
        },
        {
          stepId: 'step-002',
          type: 'human_notification',
          name: 'Follow-up notify',
          recipients: [{ role: 'on_call_dba', urgency: 'high' }],
          message: { summary: 'Follow-up', detail: 'Workflow continued', actionRequired: false },
          channel: 'auto',
        },
      ],
      rollbackStrategy: {
        type: 'stepwise',
        description: 'No rollback required for notifications.',
      },
    };

    const engine = new RecoveryGraphEngine(
      context,
      agent.manifest,
      agent,
      recorder,
      backend,
      'dry-run',
      { checkpointer: new MemorySaver() },
    );

    const results = await engine.executePlan(plan, diagnosis);
    expect(results).toHaveLength(2);
    expect(results[0].status).toBe('skipped');
    expect(results[1].status).toBe('success');
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('checkpoints state and allows inspection via getState', async () => {
    const { simulator, agent, context, recorder } = setup();
    const diagnosis = await agent.diagnose(context);
    const plan = await agent.plan(context, diagnosis);
    recorder.setDiagnosis(diagnosis);
    recorder.addPlan(plan);

    const checkpointer = new MemorySaver();
    const threadId = `test-checkpoint-${Date.now()}`;

    const engine = new RecoveryGraphEngine(
      context,
      agent.manifest,
      agent,
      recorder,
      simulator,
      'dry-run',
      { checkpointer, threadId },
    );
    engine.setCoveredRiskLevels(['routine', 'elevated']);

    await engine.executePlan(plan, diagnosis);

    const state = await engine.getState();
    expect(state).toBeDefined();
    expect(state!.completedSteps.length).toBe(plan.steps.length);
    expect(state!.plan.metadata.planId).toBe(plan.metadata.planId);
  });

  it('executes structured commands in execute mode via the backend contract', async () => {
    const { agent, context, recorder } = setup();
    const diagnosis = await agent.diagnose(context);
    const executeCommand = vi.fn(async () => ({ ok: true }));
    const backend: ExecutionBackend = {
      executeCommand,
      evaluateCheck: async () => true,
      close: async () => {},
      transition: () => {},
      listCapabilityProviders: () => [
        {
          id: 'test-load-balancer',
          kind: 'capability_provider',
          name: 'Test Load Balancer Provider',
          maturity: 'dry_run_only',
          capabilities: ['traffic.backend.detach'],
          executionContexts: ['linux_process'],
          targetKinds: ['linux'],
          commandTypes: ['structured_command'],
          supportsDryRun: true,
          supportsExecute: true,
        },
      ],
    };
    const structuredStep: SystemActionStep = {
      stepId: 'step-001',
      type: 'system_action',
      name: 'Reload load balancer config',
      executionContext: 'linux_process',
      target: 'load-balancer',
      riskLevel: 'routine',
      requiredCapabilities: ['traffic.backend.detach'],
      command: {
        type: 'structured_command',
        operation: 'config_reload',
        parameters: { service: 'load-balancer' },
      },
      statePreservation: { before: [], after: [] },
      successCriteria: {
        description: 'Service remains healthy',
        check: {
          type: 'structured_command',
          operation: 'service_status',
          parameters: { service: 'load-balancer' },
          expect: { operator: 'eq', value: 'running' },
        },
      },
      blastRadius: {
        directComponents: ['load-balancer'],
        indirectComponents: [],
        maxImpact: 'config_reload',
        cascadeRisk: 'none',
      },
      timeout: 'PT30S',
    };
    const plan: RecoveryPlan = {
      apiVersion: 'v0.2.1',
      kind: 'RecoveryPlan',
      metadata: {
        planId: 'structured-command-execute',
        agentName: agent.manifest.metadata.name,
        agentVersion: agent.manifest.metadata.version,
        scenario: diagnosis.scenario ?? 'replication_lag_cascade',
        createdAt: new Date().toISOString(),
        estimatedDuration: 'PT1M',
        summary: 'Execute a structured command',
        supersedes: null,
      },
      impact: {
        affectedSystems: [],
        affectedServices: [],
        estimatedUserImpact: 'none',
        dataLossRisk: 'none',
      },
      steps: [structuredStep],
      rollbackStrategy: {
        type: 'stepwise',
        description: 'Restore the previous config if needed.',
      },
    };

    const engine = new RecoveryGraphEngine(
      context,
      agent.manifest,
      agent,
      recorder,
      backend,
      'execute',
      { checkpointer: new MemorySaver() },
    );

    const results = await engine.executePlan(plan, diagnosis);
    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(executeCommand).toHaveBeenCalledWith(structuredStep.command);
    expect(results[0].status).toBe('success');
    expect(results[0].providerResolution).toEqual([
      {
        capability: 'traffic.backend.detach',
        resolved: true,
        providerId: 'test-load-balancer',
      },
    ]);
  });
});
