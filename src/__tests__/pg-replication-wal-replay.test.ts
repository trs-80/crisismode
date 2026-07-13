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
      alertname: 'PostgresReplicationLagCritical',
      instance: 'pg-primary-us-east-1',
      severity: 'critical',
    },
    receivedAt: new Date().toISOString(),
  };
  return assembleContext(trigger, agent.manifest);
}

describe('PgReplicationAgent — wal_replay_paused', () => {
  describe('diagnose', () => {
    it('returns scenario wal_replay_paused when WAL replay is paused on the replica', async () => {
      const simulator = new PgSimulator();
      simulator.pauseReplay();
      const agent = new PgReplicationAgent(simulator);
      const context = makeContext(agent);

      const result = await agent.diagnose(context);

      expect(result.status).toBe('identified');
      expect(result.scenario).toBe('wal_replay_paused');
      expect(result.findings.length).toBeGreaterThan(0);
      expect(result.findings[0].data).toHaveProperty('replicas');
    });

    it('does not return wal_replay_paused when replay is not paused (regression)', async () => {
      const agent = new PgReplicationAgent(new PgSimulator());
      const context = makeContext(agent);

      const result = await agent.diagnose(context);

      expect(result.scenario).not.toBe('wal_replay_paused');
    });
  });

  describe('plan', () => {
    it('generates a distinct, all-SQL, validator-passing plan for wal_replay_paused', async () => {
      const simulator = new PgSimulator();
      simulator.pauseReplay();
      const agent = new PgReplicationAgent(simulator);
      const context = makeContext(agent);

      const diagnosis = await agent.diagnose(context);
      const plan = await agent.plan(context, diagnosis);

      expect(plan.metadata.scenario).toBe('wal_replay_paused');
      expect(plan.rollbackStrategy).toBeDefined();

      const resumeStep = plan.steps.find(
        (s): s is SystemActionStep =>
          s.type === 'system_action' && s.command.type === 'sql' && !!s.command.statement?.includes('pg_wal_replay_resume'),
      );
      expect(resumeStep).toBeDefined();
      expect(resumeStep!.riskLevel).toBe('elevated');
      expect(resumeStep!.requiredCapabilities).toContain('db.wal_replay.resume');
      expect(resumeStep!.statePreservation.before.length).toBeGreaterThan(0);
      expect(resumeStep!.command.parameters).toEqual({ node: 'replica' });

      // Structural + execute-mode provider-resolution validation (against the
      // simulator's live capability provider list, matching how the torture
      // harness validates before executing).
      const result = validatePlan(plan, pgReplicationManifest, {
        backend: simulator,
        executionMode: 'execute',
        requireExecutableCapabilities: true,
      });
      expect(result.checks.filter((c) => !c.passed)).toEqual([]);
      expect(result.valid).toBe(true);
    });

    it('does not break the existing replication_lag_cascade plan/branch', async () => {
      const agent = new PgReplicationAgent(new PgSimulator());
      const context = makeContext(agent);
      const diagnosis = await agent.diagnose(context);
      const plan = await agent.plan(context, diagnosis);

      expect(plan.metadata.scenario).toBe('replication_lag_cascade');
      expect(plan.steps.some((s) => s.stepId === 'step-004')).toBe(true);
    });
  });

  describe('simulator resume round-trip', () => {
    it('resuming replay via the planned command clears the paused state and satisfies success criteria', async () => {
      const simulator = new PgSimulator();
      simulator.pauseReplay();
      expect(await simulator.queryReplayPaused()).toBe(true);

      const agent = new PgReplicationAgent(simulator);
      const context = makeContext(agent);
      const diagnosis = await agent.diagnose(context);
      const plan = await agent.plan(context, diagnosis);

      const resumeStep = plan.steps.find(
        (s): s is SystemActionStep =>
          s.type === 'system_action' && s.command.type === 'sql' && !!s.command.statement?.includes('pg_wal_replay_resume'),
      );
      expect(resumeStep).toBeDefined();

      await simulator.executeCommand(resumeStep!.command);

      expect(await simulator.queryReplayPaused()).toBe(false);
      const successPassed = await simulator.evaluateCheck(resumeStep!.successCriteria.check);
      expect(successPassed).toBe(true);
    });

    it('is idempotent — resuming an already-resumed replica stays unpaused', async () => {
      const simulator = new PgSimulator();
      // never paused
      await simulator.executeCommand({
        type: 'sql',
        statement: 'SELECT pg_wal_replay_resume();',
        parameters: { node: 'replica' },
      });
      expect(await simulator.queryReplayPaused()).toBe(false);
    });
  });
});

describe('PgLiveClient — replica routing', () => {
  it('routes commands with parameters.node === "replica" to the replica pool', async () => {
    const queries: Array<{ pool: 'primary' | 'replica'; statement: string }> = [];

    class FakePool {
      constructor(private label: 'primary' | 'replica') {}
      async query(statement: string) {
        queries.push({ pool: this.label, statement });
        return { rowCount: 1, rows: [{ paused: false }] };
      }
      async end() {}
    }

    const client = new PgLiveClient(
      { host: 'primary-host', port: 5432, user: 'u', password: 'p', database: 'd' },
      { host: 'replica-host', port: 5432, user: 'u', password: 'p', database: 'd' },
    );
    // Swap in fakes post-construction to avoid real network connections.
    (client as unknown as { primaryPool: FakePool }).primaryPool = new FakePool('primary');
    (client as unknown as { replicaPool: FakePool }).replicaPool = new FakePool('replica');

    await client.executeCommand({
      type: 'sql',
      statement: 'SELECT pg_wal_replay_resume();',
      parameters: { node: 'replica' },
    });
    await client.executeCommand({
      type: 'sql',
      statement: 'SELECT 1;',
    });
    await client.evaluateCheck({
      type: 'sql',
      statement: 'SELECT pg_is_wal_replay_paused();',
      parameters: { node: 'replica' },
      expect: { operator: 'eq', value: false },
    });

    expect(queries).toEqual([
      { pool: 'replica', statement: 'SELECT pg_wal_replay_resume();' },
      { pool: 'primary', statement: 'SELECT 1;' },
      { pool: 'replica', statement: 'SELECT pg_is_wal_replay_paused();' },
    ]);
  });

  it('throws a clear error when node=replica is requested but no replica is configured', async () => {
    const client = new PgLiveClient({
      host: 'primary-host',
      port: 5432,
      user: 'u',
      password: 'p',
      database: 'd',
    });

    await expect(
      client.executeCommand({
        type: 'sql',
        statement: 'SELECT pg_wal_replay_resume();',
        parameters: { node: 'replica' },
      }),
    ).rejects.toThrow(/no replica connection is configured/i);

    await client.close();
  });

  it('declares db.wal_replay.resume as a live, execute-capable SQL capability', () => {
    const client = new PgLiveClient({
      host: 'primary-host',
      port: 5432,
      user: 'u',
      password: 'p',
      database: 'd',
    });

    const providers = client.listCapabilityProviders();
    const provider = providers.find((p) => p.capabilities.includes('db.wal_replay.resume'));
    expect(provider).toBeDefined();
    expect(provider!.supportsExecute).toBe(true);
    expect(provider!.commandTypes).toContain('sql');
  });
});
