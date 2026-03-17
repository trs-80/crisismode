// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';

vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }));
vi.mock('../framework/coordinator.js', () => ({
  requestApproval: async () => 'approved',
  shouldAutoApprove: () => true,
}));

import { DbMigrationAgent } from '../agent/db-migration/agent.js';
import { DbMigrationSimulator } from '../agent/db-migration/simulator.js';
import { assembleContext } from '../framework/context.js';
import type { AgentContext } from '../types/agent-context.js';

function setup() {
  const simulator = new DbMigrationSimulator();
  const agent = new DbMigrationAgent(simulator);
  const trigger: AgentContext['trigger'] = {
    type: 'alert',
    source: 'monitoring',
    payload: { alertname: 'DatabaseConnectionExhaustion', severity: 'critical' },
    receivedAt: new Date().toISOString(),
  };
  const context = assembleContext(trigger, agent.manifest);
  return { simulator, agent, context };
}

describe('DbMigrationAgent', () => {
  describe('assessHealth', () => {
    it('reports unhealthy when migration is stuck', async () => {
      const { agent, context } = setup();
      const health = await agent.assessHealth(context);
      expect(health.status).toBe('unhealthy');
      expect(health.signals.length).toBeGreaterThan(0);
    });

    it('reports healthy after recovery', async () => {
      const { simulator, agent, context } = setup();
      simulator.transition('recovered');
      const health = await agent.assessHealth(context);
      expect(health.status).toBe('healthy');
    });
  });

  describe('diagnose', () => {
    it('identifies migration lock scenario', async () => {
      const { agent, context } = setup();
      const diagnosis = await agent.diagnose(context);
      expect(diagnosis.status).toBe('identified');
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

      const hasNotification = plan.steps.some((s) => s.type === 'human_notification');
      expect(hasNotification).toBe(true);

      // Must have human_approval for high-risk migration rollback
      const hasApproval = plan.steps.some((s) => s.type === 'human_approval');
      expect(hasApproval).toBe(true);

      const ids = plan.steps.map((s) => s.stepId);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });
});
