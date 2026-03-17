// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';

vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }));
vi.mock('../framework/coordinator.js', () => ({
  requestApproval: async () => 'approved',
  shouldAutoApprove: () => true,
}));

import { DeployRollbackAgent } from '../agent/deploy-rollback/agent.js';
import { DeploySimulator } from '../agent/deploy-rollback/simulator.js';
import { assembleContext } from '../framework/context.js';
import type { AgentContext } from '../types/agent-context.js';

function setup() {
  const simulator = new DeploySimulator();
  const agent = new DeployRollbackAgent(simulator);
  const trigger: AgentContext['trigger'] = {
    type: 'alert',
    source: 'monitoring',
    payload: { alertname: 'HighErrorRate', severity: 'critical' },
    receivedAt: new Date().toISOString(),
  };
  const context = assembleContext(trigger, agent.manifest);
  return { simulator, agent, context };
}

describe('DeployRollbackAgent', () => {
  describe('assessHealth', () => {
    it('reports unhealthy when deploy has high error rate', async () => {
      const { agent, context } = setup();
      const health = await agent.assessHealth(context);
      expect(health.status).toBe('unhealthy');
      expect(health.confidence).toBeGreaterThan(0);
      expect(health.signals.length).toBeGreaterThan(0);
    });

    it('reports healthy after recovery', async () => {
      const { simulator, agent, context } = setup();
      simulator.transition('stabilized');
      const health = await agent.assessHealth(context);
      expect(health.status).toBe('healthy');
    });
  });

  describe('diagnose', () => {
    it('identifies bad deploy scenario', async () => {
      const { agent, context } = setup();
      const diagnosis = await agent.diagnose(context);
      expect(diagnosis.status).toBe('identified');
      expect(diagnosis.scenario).toBeTruthy();
      expect(diagnosis.findings.length).toBeGreaterThan(0);
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
      expect(plan.impact).toBeDefined();

      // Must have human_notification for elevated risk plans
      const hasNotification = plan.steps.some((s) => s.type === 'human_notification');
      expect(hasNotification).toBe(true);

      // Step IDs must be unique
      const ids = plan.steps.map((s) => s.stepId);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });
});
