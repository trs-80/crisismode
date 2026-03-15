// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';

vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }));
vi.mock('../framework/coordinator.js', () => ({
  requestApproval: async () => 'approved',
  shouldAutoApprove: () => true,
}));

import { EtcdRecoveryAgent } from '../agent/etcd/agent.js';
import { EtcdSimulator } from '../agent/etcd/simulator.js';
import { ExecutionEngine } from '../framework/engine.js';
import { ForensicRecorder } from '../framework/forensics.js';
import { assembleContext } from '../framework/context.js';
import type { AgentContext } from '../types/agent-context.js';

function setup() {
  const simulator = new EtcdSimulator();
  const agent = new EtcdRecoveryAgent(simulator);
  const trigger: AgentContext['trigger'] = {
    type: 'alert',
    source: 'prometheus',
    payload: {
      alertname: 'EtcdLeaderElectionLoop',
      instance: 'etcd-cluster-us-east-1',
      severity: 'critical',
    },
    receivedAt: new Date().toISOString(),
  };
  const context = assembleContext(trigger, agent.manifest);
  const recorder = new ForensicRecorder();
  recorder.setContext(context);
  return { simulator, agent, context, recorder };
}

describe('EtcdRecoveryAgent', () => {
  describe('assessHealth', () => {
    it('reports unhealthy when cluster is degraded', async () => {
      const { agent, context } = setup();
      const health = await agent.assessHealth(context);

      expect(health.status).toBe('unhealthy');
      expect(health.summary).toContain('unhealthy');
    });

    it('reports recovering after the simulator transitions to recovered state', async () => {
      // Note: the recovered state still has a high raft term (849 > 100),
      // so the agent reports 'recovering' rather than 'healthy' — this is
      // correct behaviour since raft term instability takes time to settle.
      const simulator = new EtcdSimulator();
      simulator.transition('recovered');
      const agent = new EtcdRecoveryAgent(simulator);
      const trigger: AgentContext['trigger'] = {
        type: 'alert',
        source: 'prometheus',
        payload: {
          alertname: 'EtcdLeaderElectionLoop',
          instance: 'etcd-cluster-us-east-1',
          severity: 'critical',
        },
        receivedAt: new Date().toISOString(),
      };
      const context = assembleContext(trigger, agent.manifest);

      const health = await agent.assessHealth(context);

      expect(health.status).toBe('recovering');
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

    it('includes stateTransition on member remove and add steps', async () => {
      const { agent, context } = setup();
      const diagnosis = await agent.diagnose(context);
      const plan = await agent.plan(context, diagnosis);

      const removeStep = plan.steps.find((s) => s.stepId === 'step-005');
      expect(removeStep).toBeDefined();
      expect(removeStep!.type).toBe('system_action');
      if (removeStep!.type === 'system_action') {
        expect(removeStep!.stateTransition).toBe('recovering');
      }

      const addStep = plan.steps.find((s) => s.stepId === 'step-007');
      expect(addStep).toBeDefined();
      if (addStep!.type === 'system_action') {
        expect(addStep!.stateTransition).toBe('recovered');
      }
    });
  });

  describe('engine', () => {
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
      engine.setCoveredRiskLevels(['routine', 'elevated', 'high']);

      const results = await engine.executePlan(plan, diagnosis);
      expect(results.length).toBe(plan.steps.length);

      const failedSteps = results.filter((r) => r.status === 'failed');
      expect(failedSteps.length).toBe(0);
    });
  });
});
