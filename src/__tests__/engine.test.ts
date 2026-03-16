// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from 'vitest';

// Mock the Anthropic SDK so agent.ts can be imported without the dependency
vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }));

// Mock the coordinator so human_approval steps don't block on stdin
vi.mock('../framework/coordinator.js', () => ({
  requestApproval: vi.fn(async () => 'approved'),
  shouldAutoApprove: vi.fn(() => true),
}));
import { ExecutionEngine } from '../framework/engine.js';
import { PgReplicationAgent } from '../agent/pg-replication/agent.js';
import { PgSimulator } from '../agent/pg-replication/simulator.js';
import { RedisMemoryAgent } from '../agent/redis/agent.js';
import { RedisSimulator } from '../agent/redis/simulator.js';
import { requestApproval, shouldAutoApprove } from '../framework/coordinator.js';
import { ForensicRecorder } from '../framework/forensics.js';
import { assembleContext } from '../framework/context.js';
import type { AgentContext } from '../types/agent-context.js';
import type { EngineCallbacks } from '../framework/engine.js';
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

afterEach(() => {
  vi.mocked(requestApproval).mockReset();
  vi.mocked(requestApproval).mockResolvedValue('approved');
  vi.mocked(shouldAutoApprove).mockReset();
  vi.mocked(shouldAutoApprove).mockReturnValue(true);
});

describe('ExecutionEngine', () => {
  it('executes a full plan in dry-run mode', async () => {
    const { simulator, agent, context, recorder } = setup();
    const diagnosis = await agent.diagnose(context);
    const plan = await agent.plan(context, diagnosis);
    recorder.setDiagnosis(diagnosis);
    recorder.addPlan(plan);

    const engine = new ExecutionEngine(
      context,
      agent.manifest,
      agent,
      recorder,
      simulator,
      {},
      'dry-run',
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

    const engine = new ExecutionEngine(
      context,
      agent.manifest,
      agent,
      recorder,
      simulator,
      {},
      'dry-run',
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
    const callbacks: EngineCallbacks = {
      onStepStart: (step) => stepsStarted.push(step.stepId),
    };

    const engine = new ExecutionEngine(
      context,
      agent.manifest,
      agent,
      recorder,
      simulator,
      callbacks,
      'dry-run',
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
      // Fail the first precondition check for the disconnect step
      if (check.statement?.includes("client_addr = '10.0.1.52'") && !check.statement.includes("state = 'streaming'") && callCount <= 5) {
        return false;
      }
      return origEval(check);
    };

    const engine = new ExecutionEngine(
      context,
      agent.manifest,
      agent,
      recorder,
      simulator,
      {},
      'dry-run',
    );
    engine.setCoveredRiskLevels(['routine', 'elevated']);

    const results = await engine.executePlan(plan, diagnosis);
    const failed = results.find((r) => r.status === 'failed');
    expect(failed).toBeDefined();

    // Execution should stop after the failed step
    expect(results.length).toBeLessThan(plan.steps.length);
  });

  it('executes a Redis plan through the generic engine backend contract', async () => {
    const { simulator, agent, context, recorder } = setupRedis();
    const diagnosis = await agent.diagnose(context);
    const plan = await agent.plan(context, diagnosis);
    recorder.setDiagnosis(diagnosis);
    recorder.addPlan(plan);

    const engine = new ExecutionEngine(
      context,
      agent.manifest,
      agent,
      recorder,
      simulator,
      {},
      'dry-run',
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

    const engine = new ExecutionEngine(
      context,
      agent.manifest,
      agent,
      recorder,
      simulator,
      {},
      'dry-run',
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

    const engine = new ExecutionEngine(
      context,
      agent.manifest,
      agent,
      recorder,
      simulator,
      {},
      'dry-run',
    );
    engine.setCoveredRiskLevels(['routine', 'elevated']);

    const results = await engine.executePlan(plan, diagnosis);
    const checkpoint = results.find((result) => result.stepId === 'step-006');
    expect(checkpoint?.status).toBe('failed');
    expect(checkpoint?.error).toContain('manual escalation required');
    expect(results.at(-1)?.stepId).toBe('step-006');
  });

  it('stops execution when a revised plan step fails', async () => {
    const { simulator, agent, context, recorder } = setup();
    const diagnosis = await agent.diagnose(context);
    const plan = await agent.plan(context, diagnosis);
    recorder.setDiagnosis(diagnosis);
    recorder.addPlan(plan);

    const revisedPlan: RecoveryPlan = {
      apiVersion: 'v0.2.1',
      kind: 'RecoveryPlan',
      metadata: {
        planId: 'replan-failure',
        agentName: agent.manifest.metadata.name,
        agentVersion: agent.manifest.metadata.version,
        scenario: diagnosis.scenario ?? plan.metadata.scenario,
        createdAt: new Date().toISOString(),
        estimatedDuration: 'PT1M',
        summary: 'Inject a failing revised step',
        supersedes: plan.metadata.planId,
      },
      impact: plan.impact,
      steps: [
        {
          stepId: 'revised-step-001',
          type: 'system_action',
          name: 'Fail blast radius validation',
          executionContext: 'unsupported_context',
          target: 'bad-target',
          riskLevel: 'elevated',
          requiredCapabilities: ['traffic.backend.detach'],
          command: {
            type: 'structured_command',
            operation: 'config_reload',
            parameters: { service: 'load-balancer' },
          },
          statePreservation: {
            before: [
              {
                name: 'pre-check',
                captureType: 'command_output',
                statement: 'echo pre-check',
                captureCost: 'negligible',
                capturePolicy: 'required',
              },
            ],
            after: [],
          },
          successCriteria: {
            description: 'Should never reach success evaluation',
            check: {
              type: 'structured_command',
              expect: { operator: 'eq', value: 'running' },
            },
          },
          blastRadius: {
            directComponents: ['bad-target'],
            indirectComponents: [],
            maxImpact: 'test_only',
            cascadeRisk: 'low',
          },
          timeout: 'PT30S',
        },
      ],
      rollbackStrategy: {
        type: 'stepwise',
        description: 'Not needed for test',
      },
    };

    agent.replan = async () => ({ action: 'revised_plan', plan: revisedPlan });

    const engine = new ExecutionEngine(
      context,
      agent.manifest,
      agent,
      recorder,
      simulator,
      {},
      'dry-run',
    );
    engine.setCoveredRiskLevels(['routine', 'elevated']);

    const results = await engine.executePlan(plan, diagnosis);
    const checkpoint = results.find((result) => result.stepId === 'step-006');
    expect(checkpoint?.status).toBe('failed');
    expect(checkpoint?.error).toContain('revised-step-001');
    expect(results.at(-1)?.stepId).toBe('step-006');
  });

  it('halts the run when a human approver rejects the plan', async () => {
    const { simulator, agent, context, recorder } = setup();
    const diagnosis = await agent.diagnose(context);
    const plan = await agent.plan(context, diagnosis);
    recorder.setDiagnosis(diagnosis);
    recorder.addPlan(plan);

    vi.mocked(shouldAutoApprove).mockReturnValue(false);
    vi.mocked(requestApproval).mockResolvedValue('rejected');

    const engine = new ExecutionEngine(
      context,
      agent.manifest,
      agent,
      recorder,
      simulator,
      {},
      'dry-run',
    );
    engine.setCoveredRiskLevels([]);

    const results = await engine.executePlan(plan, diagnosis);
    const approval = results.find((result) => result.step.type === 'human_approval');
    expect(vi.mocked(requestApproval)).toHaveBeenCalledTimes(1);
    expect(approval?.status).toBe('failed');
    expect(approval?.error).toContain('Human rejected the step');
    expect(results.at(-1)?.step.type).toBe('human_approval');
  });

  it('halts the run when a human approver skips the plan at an approval gate', async () => {
    const { simulator, agent, context, recorder } = setup();
    const diagnosis = await agent.diagnose(context);
    const plan = await agent.plan(context, diagnosis);
    recorder.setDiagnosis(diagnosis);
    recorder.addPlan(plan);

    vi.mocked(shouldAutoApprove).mockReturnValue(false);
    vi.mocked(requestApproval).mockResolvedValue('skipped');

    const engine = new ExecutionEngine(
      context,
      agent.manifest,
      agent,
      recorder,
      simulator,
      {},
      'dry-run',
    );
    engine.setCoveredRiskLevels([]);

    const results = await engine.executePlan(plan, diagnosis);
    const approval = results.find((result) => result.step.type === 'human_approval');
    expect(vi.mocked(requestApproval)).toHaveBeenCalledTimes(1);
    expect(approval?.status).toBe('skipped');
    expect(results.at(-1)?.step.type).toBe('human_approval');
  });

  it('marks a conditional step as skipped when the false branch is skip and continues execution', async () => {
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

    const engine = new ExecutionEngine(
      context,
      agent.manifest,
      agent,
      recorder,
      backend,
      {},
      'dry-run',
    );

    const results = await engine.executePlan(plan, diagnosis);
    expect(results).toHaveLength(2);
    expect(results[0].status).toBe('skipped');
    expect(results[1].status).toBe('success');
    expect(executeCommand).not.toHaveBeenCalled();
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

    const engine = new ExecutionEngine(
      context,
      agent.manifest,
      agent,
      recorder,
      backend,
      {},
      'execute',
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

  it('fails execute mode before command execution when provider resolution is unresolved', async () => {
    const { agent, context, recorder } = setup();
    const diagnosis = await agent.diagnose(context);
    const executeCommand = vi.fn(async () => ({ ok: true }));
    const backend: ExecutionBackend = {
      executeCommand,
      evaluateCheck: async () => true,
      close: async () => {},
      transition: () => {},
      listCapabilityProviders: () => [],
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
        planId: 'structured-command-unresolved-provider',
        agentName: agent.manifest.metadata.name,
        agentVersion: agent.manifest.metadata.version,
        scenario: diagnosis.scenario ?? 'replication_lag_cascade',
        createdAt: new Date().toISOString(),
        estimatedDuration: 'PT1M',
        summary: 'Block a structured command with no provider',
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

    const engine = new ExecutionEngine(
      context,
      agent.manifest,
      agent,
      recorder,
      backend,
      {},
      'execute',
    );

    const results = await engine.executePlan(plan, diagnosis);
    expect(executeCommand).not.toHaveBeenCalled();
    expect(results[0].status).toBe('failed');
    expect(results[0].error).toContain('Provider resolution failed');
    expect(results[0].providerResolution).toEqual([
      {
        capability: 'traffic.backend.detach',
        resolved: false,
        reason: "no provider is registered for capability 'traffic.backend.detach'",
      },
    ]);
  });

  it('allows dry-run execution to proceed even when live providers are unresolved', async () => {
    const { agent, context, recorder } = setup();
    const diagnosis = await agent.diagnose(context);
    const executeCommand = vi.fn(async () => ({ ok: true }));
    const backend: ExecutionBackend = {
      executeCommand,
      evaluateCheck: async () => true,
      close: async () => {},
      transition: () => {},
      listCapabilityProviders: () => [],
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
        planId: 'structured-command-dry-run-unresolved-provider',
        agentName: agent.manifest.metadata.name,
        agentVersion: agent.manifest.metadata.version,
        scenario: diagnosis.scenario ?? 'replication_lag_cascade',
        createdAt: new Date().toISOString(),
        estimatedDuration: 'PT1M',
        summary: 'Allow unresolved providers in dry-run mode',
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

    const engine = new ExecutionEngine(
      context,
      agent.manifest,
      agent,
      recorder,
      backend,
      {},
      'dry-run',
    );

    const results = await engine.executePlan(plan, diagnosis);
    expect(executeCommand).not.toHaveBeenCalled();
    expect(results[0].status).toBe('success');
    expect(results[0].output).toEqual({ dryRun: true });
    expect(results[0].providerResolution).toEqual([
      {
        capability: 'traffic.backend.detach',
        resolved: false,
        reason: "no provider is registered for capability 'traffic.backend.detach'",
      },
    ]);
  });

  it('fails system actions whose targets are not represented in manifest, trigger, topology, or blast radius', async () => {
    const { simulator, agent, context, recorder } = setup();
    const diagnosis = await agent.diagnose(context);
    const plan = await agent.plan(context, diagnosis);
    recorder.setDiagnosis(diagnosis);
    recorder.addPlan(plan);

    const invalidStep = plan.steps.find((step) => step.stepId === 'step-004');
    if (!invalidStep || invalidStep.type !== 'system_action') {
      throw new Error('expected step-004 system_action in PostgreSQL recovery plan');
    }
    invalidStep.target = 'mystery-target';

    const engine = new ExecutionEngine(
      context,
      agent.manifest,
      agent,
      recorder,
      simulator,
      {},
      'dry-run',
    );
    engine.setCoveredRiskLevels(['routine', 'elevated']);

    const results = await engine.executePlan(plan, diagnosis);
    const failed = results.find((result) => result.stepId === 'step-004');
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toContain('Blast radius validation failed');
    expect(failed?.error).toContain('mystery-target');
  });
});
