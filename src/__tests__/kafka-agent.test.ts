// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';

// Mock the Anthropic SDK so agent.ts can be imported without the dependency
vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }));

// Mock the coordinator so human_approval steps don't block on stdin
vi.mock('../framework/coordinator.js', () => ({
  requestApproval: async () => 'approved',
  shouldAutoApprove: () => true,
}));

// Mock AI diagnosis to return null (forces rule-based fallback in all tests)
vi.mock('../agent/kafka/ai-diagnosis.js', () => ({
  aiDiagnose: async () => null,
}));

import { KafkaRecoveryAgent } from '../agent/kafka/agent.js';
import { KafkaSimulator } from '../agent/kafka/simulator.js';
import type { KafkaScenario } from '../agent/kafka/simulator.js';
import { ExecutionEngine } from '../framework/engine.js';
import { ForensicRecorder } from '../framework/forensics.js';
import { assembleContext } from '../framework/context.js';
import type { AgentContext } from '../types/agent-context.js';
import type { ExecutionState } from '../types/execution-state.js';

function makeExecutionState(overrides: Partial<ExecutionState> = {}): ExecutionState {
  return {
    completedSteps: [],
    currentStepIndex: 0,
    captures: {},
    startedAt: new Date().toISOString(),
    elapsedMs: 0,
    ...overrides,
  } as ExecutionState;
}

function setup(scenario: KafkaScenario = 'urp') {
  const simulator = new KafkaSimulator(scenario);
  const agent = new KafkaRecoveryAgent(simulator);
  const trigger: AgentContext['trigger'] = {
    type: 'alert',
    source: 'prometheus',
    payload: {
      alertname: 'KafkaUnderReplicatedPartitions',
      instance: 'kafka-cluster-us-east-1',
      severity: 'critical',
    },
    receivedAt: new Date().toISOString(),
  };
  const context = assembleContext(trigger, agent.manifest);
  const recorder = new ForensicRecorder();
  recorder.setContext(context);
  return { simulator, agent, context, recorder };
}

// ---------------------------------------------------------------------------
// URP scenario (original behavior)
// ---------------------------------------------------------------------------

describe('KafkaRecoveryAgent — URP scenario', () => {
  describe('assessHealth', () => {
    it('reports unhealthy when cluster is degraded', async () => {
      const { agent, context } = setup();
      const health = await agent.assessHealth(context);

      expect(health.status).toBe('unhealthy');
      expect(health.summary).toContain('unhealthy');
    });

    it('reports healthy after the simulator transitions to recovered state', async () => {
      const { simulator, agent, context } = setup();
      simulator.transition('recovered');

      const health = await agent.assessHealth(context);

      expect(health.status).toBe('healthy');
    });
  });

  describe('diagnose', () => {
    it('returns identified status with findings', async () => {
      const { agent, context } = setup();
      const result = await agent.diagnose(context);

      expect(result.status).toBe('identified');
      expect(result.scenario).toBe('under_replicated_partitions');
      expect(result.findings.length).toBeGreaterThan(0);
      expect(result.confidence).toBeGreaterThan(0);
    });
  });

  describe('plan', () => {
    it('generates a valid recovery plan', async () => {
      const { agent, context } = setup();
      const diagnosis = await agent.diagnose(context);
      const plan = await agent.plan(context, diagnosis);

      expect(plan.kind).toBe('RecoveryPlan');
      expect(plan.steps.length).toBeGreaterThan(0);
      expect(plan.rollbackStrategy).toBeDefined();
    });

    it('declares required capabilities on all system actions', async () => {
      const { agent, context } = setup();
      const diagnosis = await agent.diagnose(context);
      const plan = await agent.plan(context, diagnosis);

      const systemActions = plan.steps.filter((step) => step.type === 'system_action');
      expect(systemActions.length).toBeGreaterThan(0);
      for (const step of systemActions) {
        if (step.type === 'system_action') {
          expect(step.requiredCapabilities.length).toBeGreaterThan(0);
        }
      }
    });

    it('includes stateTransition on leader elect and reassign steps', async () => {
      const { agent, context } = setup();
      const diagnosis = await agent.diagnose(context);
      const plan = await agent.plan(context, diagnosis);

      const leaderElectStep = plan.steps.find((s) => s.stepId === 'step-004');
      expect(leaderElectStep).toBeDefined();
      expect(leaderElectStep!.type).toBe('system_action');
      if (leaderElectStep!.type === 'system_action') {
        expect(leaderElectStep!.stateTransition).toBe('recovering');
      }

      const reassignStep = plan.steps.find((s) => s.stepId === 'step-005');
      expect(reassignStep).toBeDefined();
      if (reassignStep!.type === 'system_action') {
        expect(reassignStep!.stateTransition).toBe('recovered');
      }
    });
  });

  describe('engine', () => {
    it('executes a full plan in dry-run mode without failures', async () => {
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
  });
});

// ---------------------------------------------------------------------------
// Broker-down scenario
// ---------------------------------------------------------------------------

describe('KafkaRecoveryAgent — broker_down scenario', () => {
  describe('assessHealth', () => {
    it('reports unhealthy when a broker is down', async () => {
      const { agent, context } = setup('broker_down');
      const health = await agent.assessHealth(context);

      expect(health.status).toBe('unhealthy');
      expect(health.signals[0].detail).toContain('2/3');
    });
  });

  describe('diagnose', () => {
    it('identifies broker_down scenario', async () => {
      const { agent, context } = setup('broker_down');
      const result = await agent.diagnose(context);

      expect(result.status).toBe('identified');
      expect(result.scenario).toBe('broker_down');
      expect(result.confidence).toBe(0.96);
    });

    it('reports dead broker and leaderless partitions in findings', async () => {
      const { agent, context } = setup('broker_down');
      const result = await agent.diagnose(context);

      const livenessFinding = result.findings.find((f) => f.source === 'kafka_broker_liveness');
      expect(livenessFinding).toBeDefined();
      expect(livenessFinding!.severity).toBe('critical');
      expect(livenessFinding!.observation).toContain('broker-2');
      expect(livenessFinding!.observation).toContain('leaderless');
    });
  });

  describe('plan', () => {
    it('generates a broker_down recovery plan', async () => {
      const { agent, context } = setup('broker_down');
      const diagnosis = await agent.diagnose(context);
      const plan = await agent.plan(context, diagnosis);

      expect(plan.kind).toBe('RecoveryPlan');
      expect(plan.metadata.planId).toContain('kafka-broker-down');
    });

    it('includes human_approval step', async () => {
      const { agent, context } = setup('broker_down');
      const diagnosis = await agent.diagnose(context);
      const plan = await agent.plan(context, diagnosis);

      const approvalStep = plan.steps.find((s) => s.type === 'human_approval');
      expect(approvalStep).toBeDefined();
      expect(approvalStep!.stepId).toBe('step-005');
    });

    it('includes unclean leader election step', async () => {
      const { agent, context } = setup('broker_down');
      const diagnosis = await agent.diagnose(context);
      const plan = await agent.plan(context, diagnosis);

      const electionStep = plan.steps.find((s) => s.stepId === 'step-004');
      expect(electionStep).toBeDefined();
      expect(electionStep!.type).toBe('system_action');
      if (electionStep!.type === 'system_action') {
        expect(electionStep!.command.operation).toBe('unclean_leader_elect');
        expect(electionStep!.riskLevel).toBe('elevated');
        expect(electionStep!.stateTransition).toBe('recovering');
      }
    });

    it('mentions the dead broker in the plan summary', async () => {
      const { agent, context } = setup('broker_down');
      const diagnosis = await agent.diagnose(context);
      const plan = await agent.plan(context, diagnosis);

      expect(plan.metadata.summary).toContain('broker-2');
    });
  });

  describe('engine', () => {
    it('executes the full broker_down plan in dry-run mode without failures', async () => {
      const { simulator, agent, context, recorder } = setup('broker_down');
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
  });
});

// ---------------------------------------------------------------------------
// Consumer lag cascade scenario
// ---------------------------------------------------------------------------

describe('KafkaRecoveryAgent — consumer_lag_cascade scenario', () => {
  describe('assessHealth', () => {
    it('reports unhealthy with extreme lag', async () => {
      const { agent, context } = setup('consumer_lag_cascade');
      const health = await agent.assessHealth(context);

      expect(health.status).toBe('unhealthy');
    });
  });

  describe('diagnose', () => {
    it('identifies consumer_lag_cascade scenario', async () => {
      const { agent, context } = setup('consumer_lag_cascade');
      const result = await agent.diagnose(context);

      expect(result.status).toBe('identified');
      expect(result.scenario).toBe('consumer_lag_cascade');
      expect(result.confidence).toBe(0.85);
    });
  });

  describe('plan', () => {
    it('generates a consumer lag cascade recovery plan', async () => {
      const { agent, context } = setup('consumer_lag_cascade');
      const diagnosis = await agent.diagnose(context);
      const plan = await agent.plan(context, diagnosis);

      expect(plan.kind).toBe('RecoveryPlan');
      expect(plan.metadata.planId).toContain('kafka-lag-cascade');
    });

    it('includes increase_replica_fetchers and consumer_group_reset steps', async () => {
      const { agent, context } = setup('consumer_lag_cascade');
      const diagnosis = await agent.diagnose(context);
      const plan = await agent.plan(context, diagnosis);

      const fetcherStep = plan.steps.find(
        (s) => s.type === 'system_action' && s.command.operation === 'increase_replica_fetchers',
      );
      expect(fetcherStep).toBeDefined();

      const resetStep = plan.steps.find(
        (s) => s.type === 'system_action' && s.command.operation === 'consumer_group_reset',
      );
      expect(resetStep).toBeDefined();
    });

    it('fetcher step is routine risk, reset step is elevated risk', async () => {
      const { agent, context } = setup('consumer_lag_cascade');
      const diagnosis = await agent.diagnose(context);
      const plan = await agent.plan(context, diagnosis);

      const fetcherStep = plan.steps.find(
        (s) => s.type === 'system_action' && s.command.operation === 'increase_replica_fetchers',
      );
      if (fetcherStep?.type === 'system_action') {
        expect(fetcherStep.riskLevel).toBe('routine');
      }

      const resetStep = plan.steps.find(
        (s) => s.type === 'system_action' && s.command.operation === 'consumer_group_reset',
      );
      if (resetStep?.type === 'system_action') {
        expect(resetStep.riskLevel).toBe('elevated');
      }
    });
  });

  describe('engine', () => {
    it('executes the full consumer_lag_cascade plan in dry-run mode without failures', async () => {
      const { simulator, agent, context, recorder } = setup('consumer_lag_cascade');
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
      expect(results.length).toBeGreaterThan(0);

      const failedSteps = results.filter((r) => r.status === 'failed');
      expect(failedSteps.length).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Replan
// ---------------------------------------------------------------------------

describe('KafkaRecoveryAgent — replan', () => {
  it('detects broker return and returns revised plan with rebalance', async () => {
    const { simulator, agent, context } = setup('broker_down');
    const diagnosis = await agent.diagnose(context);
    // Transition to recovering — dead broker comes back
    simulator.transition('recovering');

    const executionState = makeExecutionState({
      completedSteps: [{ stepId: 'step-004', status: 'success', startedAt: '', completedAt: '', durationMs: 0 }] as ExecutionState['completedSteps'],
      currentStepIndex: 6,
      elapsedMs: 30_000,
    });

    const result = await agent.replan(context, diagnosis, executionState);

    expect(result.action).toBe('revised_plan');
    if (result.action === 'revised_plan') {
      expect(result.plan.metadata.summary).toContain('returned');
      const reassignStep = result.plan.steps.find(
        (s) => s.type === 'system_action' && s.command.operation === 'partition_reassign',
      );
      expect(reassignStep).toBeDefined();
    }
  });

  it('returns continue when no secondary issues found', async () => {
    // Use consumer_lag_cascade scenario — its recovering state has all groups Stable
    const { agent, context } = setup('consumer_lag_cascade');
    const diagnosis = await agent.diagnose(context);

    const executionState = makeExecutionState({
      currentStepIndex: 5,
      elapsedMs: 15_000,
    });

    const result = await agent.replan(context, diagnosis, executionState);

    expect(result.action).toBe('continue');
  });
});
