// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';

// Mock the Anthropic SDK so agent.ts can be imported without the dependency
vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }));
import { PgReplicationAgent } from '../agent/pg-replication/agent.js';
import { PgSimulator } from '../agent/pg-replication/simulator.js';
import { assembleContext } from '../framework/context.js';
import type { AgentContext } from '../types/agent-context.js';

function makeContext(agent: PgReplicationAgent): AgentContext {
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
  return assembleContext(trigger, agent.manifest);
}

describe('PgReplicationAgent', () => {
  describe('assessHealth', () => {
    it('reports unhealthy when replica lag is above the healthy threshold', async () => {
      const agent = new PgReplicationAgent(new PgSimulator());
      const context = makeContext(agent);
      const health = await agent.assessHealth(context);

      expect(health.status).toBe('unhealthy');
      expect(health.summary).toContain('unhealthy');
      expect(health.signals.find((signal) => signal.source === 'pg_stat_replication')?.status).toBe('critical');
    });

    it('reports healthy after the simulator transitions to recovered state', async () => {
      const simulator = new PgSimulator();
      simulator.transition('recovered');
      simulator.markSlotRecreated();

      const agent = new PgReplicationAgent(simulator);
      const context = makeContext(agent);
      const health = await agent.assessHealth(context);

      expect(health.status).toBe('healthy');
      expect(health.recommendedActions[0]).toContain('No action required');
    });
  });

  describe('diagnose', () => {
    it('returns identified status with findings', async () => {
      const agent = new PgReplicationAgent(new PgSimulator());
      const context = makeContext(agent);
      const result = await agent.diagnose(context);

      expect(result.status).toBe('identified');
      expect(result.findings.length).toBeGreaterThan(0);
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('includes replica data in findings', async () => {
      const agent = new PgReplicationAgent(new PgSimulator());
      const context = makeContext(agent);
      const result = await agent.diagnose(context);

      const replFinding = result.findings.find((f) => f.source === 'pg_stat_replication');
      expect(replFinding).toBeDefined();
      expect(replFinding!.data).toHaveProperty('replicas');
    });
  });

  describe('plan', () => {
    it('generates a valid recovery plan', async () => {
      const agent = new PgReplicationAgent(new PgSimulator());
      const context = makeContext(agent);
      const diagnosis = await agent.diagnose(context);
      const plan = await agent.plan(context, diagnosis);

      expect(plan.kind).toBe('RecoveryPlan');
      expect(plan.steps.length).toBeGreaterThan(0);
      expect(plan.rollbackStrategy).toBeDefined();
    });

    it('targets the worst-lagging replica', async () => {
      const agent = new PgReplicationAgent(new PgSimulator());
      const context = makeContext(agent);
      const diagnosis = await agent.diagnose(context);
      const plan = await agent.plan(context, diagnosis);

      // The worst replica in the simulator is 10.0.1.52 with 342s lag
      expect(plan.metadata.summary).toContain('10.0.1.52');
    });

    it('includes stateTransition on disconnect and resync steps', async () => {
      const agent = new PgReplicationAgent(new PgSimulator());
      const context = makeContext(agent);
      const diagnosis = await agent.diagnose(context);
      const plan = await agent.plan(context, diagnosis);

      const disconnectStep = plan.steps.find((s) => s.stepId === 'step-004');
      expect(disconnectStep).toBeDefined();
      expect(disconnectStep!.type).toBe('system_action');
      if (disconnectStep!.type === 'system_action') {
        expect(disconnectStep!.stateTransition).toBe('recovering');
      }

      const resyncStep = plan.steps.find((s) => s.stepId === 'step-008');
      expect(resyncStep).toBeDefined();
      if (resyncStep!.type === 'system_action') {
        expect(resyncStep!.stateTransition).toBe('recovered');
      }
    });

    it('declares required capabilities on all system actions', async () => {
      const agent = new PgReplicationAgent(new PgSimulator());
      const context = makeContext(agent);
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

    it('rejects invalid IP addresses', async () => {
      const simulator = new PgSimulator();
      // Override to return a malicious IP
      const origQuery = simulator.queryReplicationStatus.bind(simulator);
      simulator.queryReplicationStatus = async () => {
        const results = await origQuery();
        results[2].client_addr = "10.0.1.52'; DROP TABLE users; --";
        return results;
      };

      const agent = new PgReplicationAgent(simulator);
      const context = makeContext(agent);
      const diagnosis = await agent.diagnose(context);

      await expect(agent.plan(context, diagnosis)).rejects.toThrow('Invalid IPv4 address');
    });

    it('normalizes CIDR-suffixed replica addresses returned by PostgreSQL inet fields', async () => {
      const simulator = new PgSimulator();
      const origQuery = simulator.queryReplicationStatus.bind(simulator);
      simulator.queryReplicationStatus = async () => {
        const results = await origQuery();
        results[2].client_addr = '10.89.0.5/32';
        results[2].lag_seconds = 342;
        return results;
      };

      const agent = new PgReplicationAgent(simulator);
      const context = makeContext(agent);
      const diagnosis = await agent.diagnose(context);
      const plan = await agent.plan(context, diagnosis);

      expect(plan.metadata.summary).toContain('10.89.0.5');
      const disconnectStep = plan.steps.find((step) => step.stepId === 'step-004');
      expect(disconnectStep).toBeDefined();
      if (disconnectStep?.type === 'system_action' && disconnectStep.command.type === 'sql') {
        expect(disconnectStep.command.statement).toContain("client_addr = '10.89.0.5'");
      }
    });
  });

  describe('replan', () => {
    it('detects invalid slots and returns revised plan', async () => {
      const simulator = new PgSimulator();
      const agent = new PgReplicationAgent(simulator);
      const context = makeContext(agent);
      const diagnosis = await agent.diagnose(context);

      const executionState = {
        completedSteps: [],
        currentStepIndex: 0,
        captures: {},
        startedAt: new Date().toISOString(),
        elapsedMs: 0,
      };

      const result = await agent.replan(context, diagnosis, executionState);
      expect(result.action).toBe('revised_plan');
      if (result.action === 'revised_plan') {
        expect(result.plan.steps.length).toBe(2);
        expect(result.plan.metadata.summary).toContain('replica_us_east_1b');
      }
    });
  });
});
