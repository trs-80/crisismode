// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';

// Mock the Anthropic SDK so agent.ts can be imported without the dependency
vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }));

// Mock the coordinator so human_approval steps don't block on stdin
vi.mock('../framework/coordinator.js', () => ({
  requestApproval: async () => 'approved',
  shouldAutoApprove: () => true,
}));

import { KafkaRecoveryAgent } from '../agent/kafka/agent.js';
import { KafkaSimulator } from '../agent/kafka/simulator.js';
import { ExecutionEngine } from '../framework/engine.js';
import { ForensicRecorder } from '../framework/forensics.js';
import { assembleContext } from '../framework/context.js';
import type { AgentContext } from '../types/agent-context.js';

function setup() {
  const simulator = new KafkaSimulator();
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

describe('KafkaRecoveryAgent', () => {
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
