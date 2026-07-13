// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';

// Mock the Anthropic SDK so agent.ts can be imported without the dependency
vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }));

import { PgReplicationAgent } from '../agent/pg-replication/agent.js';
import { PgSimulator } from '../agent/pg-replication/simulator.js';
import { PgLiveClient } from '../agent/pg-replication/live-client.js';
import { pgReplicationManifest } from '../agent/pg-replication/manifest.js';
import { validatePlan } from '../framework/validator.js';
import { assembleContext } from '../framework/context.js';
import type { AgentContext } from '../types/agent-context.js';
import type { SystemActionStep } from '../types/step-types.js';

function makeContext(agent: PgReplicationAgent): AgentContext {
  const trigger: AgentContext['trigger'] = {
    type: 'alert',
    source: 'prometheus',
    payload: {
      alertname: 'PostgresConnectionPoolExhausted',
      instance: 'pg-primary-us-east-1',
      severity: 'critical',
    },
    receivedAt: new Date().toISOString(),
  };
  return assembleContext(trigger, agent.manifest);
}

describe('PgReplicationAgent — connection_pool_exhaustion', () => {
  describe('diagnose', () => {
    it('returns scenario connection_pool_exhaustion when usage > 90% and idle-in-tx sessions are material', async () => {
      const simulator = new PgSimulator();
      simulator.setConnectionPoolExhausted();
      const agent = new PgReplicationAgent(simulator);
      const context = makeContext(agent);

      const result = await agent.diagnose(context);

      expect(result.status).toBe('identified');
      expect(result.scenario).toBe('connection_pool_exhaustion');
      expect(result.findings.length).toBeGreaterThan(0);
      expect(result.findings[0].data).toHaveProperty('connectionUsage');
    });

    it('does not return connection_pool_exhaustion under normal connection load (regression)', async () => {
      const agent = new PgReplicationAgent(new PgSimulator());
      const context = makeContext(agent);
      const result = await agent.diagnose(context);
      expect(result.scenario).not.toBe('connection_pool_exhaustion');
    });

    it('does not trigger when usage is high but idle-in-transaction sessions are not a material contributor', async () => {
      const simulator = new PgSimulator();
      simulator.setConnectionPoolExhausted(1, 23);
      const agent = new PgReplicationAgent(simulator);
      const context = makeContext(agent);
      const result = await agent.diagnose(context);
      expect(result.scenario).not.toBe('connection_pool_exhaustion');
    });

    it('precedence: connection_pool_exhaustion takes priority over wal_replay_paused when both are true, and notes the co-occurring replay pause', async () => {
      const simulator = new PgSimulator();
      simulator.setConnectionPoolExhausted();
      simulator.pauseReplay();
      const agent = new PgReplicationAgent(simulator);
      const context = makeContext(agent);

      const result = await agent.diagnose(context);

      expect(result.scenario).toBe('connection_pool_exhaustion');
      const notesReplayPause = result.findings.some(
        (f) => JSON.stringify(f).toLowerCase().includes('replay') && JSON.stringify(f).toLowerCase().includes('pause'),
      );
      expect(notesReplayPause).toBe(true);
    });

    it('wal_replay_paused still fires on its own when the pool is not exhausted (regression)', async () => {
      const simulator = new PgSimulator();
      simulator.pauseReplay();
      const agent = new PgReplicationAgent(simulator);
      const context = makeContext(agent);
      const result = await agent.diagnose(context);
      expect(result.scenario).toBe('wal_replay_paused');
    });
  });

  describe('plan', () => {
    it('generates a distinct, all-SQL, validator-passing plan with honest elevated risk terminate step', async () => {
      const simulator = new PgSimulator();
      simulator.setConnectionPoolExhausted();
      const agent = new PgReplicationAgent(simulator);
      const context = makeContext(agent);

      const diagnosis = await agent.diagnose(context);
      const plan = await agent.plan(context, diagnosis);

      expect(plan.metadata.scenario).toBe('connection_pool_exhaustion');
      expect(plan.rollbackStrategy).toBeDefined();
      // 'stepwise' would (falsely) imply the mutation can be undone by
      // executing an inverse step — it can't, so the plan-level strategy
      // must say so honestly rather than borrow the boilerplate value.
      expect(plan.rollbackStrategy.type).toBe('none');
      expect(plan.rollbackStrategy.description.toLowerCase()).not.toContain('fully reversible');
      expect(plan.impact.dataLossRisk).not.toBe('none');
      expect(plan.impact.estimatedUserImpact.toLowerCase()).toContain('reconnect');
      expect(plan.impact.estimatedUserImpact.toLowerCase()).not.toContain('fully reversible');

      const terminateStep = plan.steps.find(
        (s): s is SystemActionStep =>
          s.type === 'system_action' && s.command.type === 'sql' && !!s.command.statement?.includes('pg_terminate_backend'),
      );
      expect(terminateStep).toBeDefined();
      expect(terminateStep!.riskLevel).toBe('elevated');
      expect(terminateStep!.requiredCapabilities).toContain('db.connections.terminate');
      expect(terminateStep!.statePreservation.before.length).toBeGreaterThan(0);
      expect(terminateStep!.rollback?.type).toBe('manual');
      expect(terminateStep!.rollback?.description.toLowerCase()).not.toContain('fully reversible');

      const checkpointStep = plan.steps.find((s) => s.type === 'checkpoint');
      expect(checkpointStep).toBeDefined();

      const humanNotificationSteps = plan.steps.filter((s) => s.type === 'human_notification');
      expect(humanNotificationSteps.length).toBeGreaterThan(0);

      const result = validatePlan(plan, pgReplicationManifest, {
        backend: simulator,
        executionMode: 'execute',
        requireExecutableCapabilities: true,
      });
      expect(result.checks.filter((c) => !c.passed)).toEqual([]);
      expect(result.valid).toBe(true);
    });

    it('does not break the existing wal_replay_paused and replication_lag_cascade plan branches', async () => {
      const simulatorReplay = new PgSimulator();
      simulatorReplay.pauseReplay();
      const replayAgent = new PgReplicationAgent(simulatorReplay);
      const replayContext = makeContext(replayAgent);
      const replayDiagnosis = await replayAgent.diagnose(replayContext);
      const replayPlan = await replayAgent.plan(replayContext, replayDiagnosis);
      expect(replayPlan.metadata.scenario).toBe('wal_replay_paused');

      const lagAgent = new PgReplicationAgent(new PgSimulator());
      const lagContext = makeContext(lagAgent);
      const lagDiagnosis = await lagAgent.diagnose(lagContext);
      const lagPlan = await lagAgent.plan(lagContext, lagDiagnosis);
      expect(lagPlan.metadata.scenario).toBe('replication_lag_cascade');
    });
  });

  describe('simulator terminate round-trip', () => {
    it('terminating stale idle-in-transaction sessions via the planned command clears them and satisfies success criteria', async () => {
      const simulator = new PgSimulator();
      simulator.setConnectionPoolExhausted();
      const agent = new PgReplicationAgent(simulator);
      const context = makeContext(agent);
      const diagnosis = await agent.diagnose(context);
      const plan = await agent.plan(context, diagnosis);

      const terminateStep = plan.steps.find(
        (s): s is SystemActionStep =>
          s.type === 'system_action' && s.command.type === 'sql' && !!s.command.statement?.includes('pg_terminate_backend'),
      );
      expect(terminateStep).toBeDefined();

      const preTerminateUsage = await simulator.queryConnectionUsage();
      expect(preTerminateUsage!.idleInTransactionOldest.length).toBeGreaterThan(0);

      const preSuccess = await simulator.evaluateCheck(terminateStep!.successCriteria.check);
      expect(preSuccess).toBe(false);

      await simulator.executeCommand(terminateStep!.command);

      const successPassed = await simulator.evaluateCheck(terminateStep!.successCriteria.check);
      expect(successPassed).toBe(true);

      const postTerminateUsage = await simulator.queryConnectionUsage();
      expect(postTerminateUsage!.idleInTransactionOldest.length).toBe(0);
    });

    it('is idempotent — running the terminate command with nothing to terminate is a no-op', async () => {
      const simulator = new PgSimulator();
      await simulator.executeCommand({
        type: 'sql',
        statement:
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE state = 'idle in transaction' AND state_change < NOW() - INTERVAL '60 seconds';",
      });
      const usage = await simulator.queryConnectionUsage();
      expect(usage!.idleInTransactionOldest.length).toBe(0);
    });
  });
});

describe('PgLiveClient — connection usage', () => {
  it('queries pg_stat_activity and max_connections on the primary pool', async () => {
    const queries: string[] = [];
    class FakePool {
      async query(statement: string) {
        queries.push(statement);
        if (statement.includes('max_connections')) {
          return { rows: [{ total: 24, max_connections: 25 }] };
        }
        if (statement.includes('GROUP BY state')) {
          return {
            rows: [
              { state: 'active', count: 4 },
              { state: 'idle in transaction', count: 20 },
            ],
          };
        }
        return { rows: [{ pid: 1001, age_seconds: 120, application_name: 'checkout' }] };
      }
      async end() {}
    }

    const client = new PgLiveClient({ host: 'h', port: 5432, user: 'u', password: 'p', database: 'd' });
    (client as unknown as { primaryPool: FakePool }).primaryPool = new FakePool();

    const usage = await client.queryConnectionUsage();
    expect(usage).not.toBeNull();
    expect(usage!.max).toBe(25);
    expect(usage!.total).toBe(24);
    expect(usage!.byState['idle in transaction']).toBe(20);
    expect(usage!.idleInTransactionOldest[0].pid).toBe(1001);
    expect(usage!.idleInTransactionOldest[0].ageSeconds).toBe(120);
  });

  it('returns null when the query fails rather than throwing', async () => {
    class FailingPool {
      async query() {
        throw new Error('connection refused');
      }
      async end() {}
    }
    const client = new PgLiveClient({ host: 'h', port: 5432, user: 'u', password: 'p', database: 'd' });
    (client as unknown as { primaryPool: FailingPool }).primaryPool = new FailingPool();

    const usage = await client.queryConnectionUsage();
    expect(usage).toBeNull();
  });

  it('declares db.connections.terminate as a live, execute-capable SQL capability', () => {
    const client = new PgLiveClient({ host: 'h', port: 5432, user: 'u', password: 'p', database: 'd' });
    const providers = client.listCapabilityProviders();
    const provider = providers.find((p) => p.capabilities.includes('db.connections.terminate'));
    expect(provider).toBeDefined();
    expect(provider!.supportsExecute).toBe(true);
    expect(provider!.commandTypes).toContain('sql');
  });
});
