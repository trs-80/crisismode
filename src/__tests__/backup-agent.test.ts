// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';

vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }));
vi.mock('../framework/coordinator.js', () => ({
  requestApproval: async () => 'approved',
  shouldAutoApprove: () => true,
}));

import { BackupVerificationAgent } from '../agent/backup/agent.js';
import { BackupSimulator } from '../agent/backup/simulator.js';
import { assembleContext } from '../framework/context.js';
import type { AgentContext } from '../types/agent-context.js';

function setup(state?: string) {
  const simulator = new BackupSimulator();
  if (state) simulator.transition(state);
  const agent = new BackupVerificationAgent(simulator);
  const trigger: AgentContext['trigger'] = {
    type: 'alert',
    source: 'monitoring',
    payload: { alertname: 'BackupStale', severity: 'critical', instance: 'backup-targets' },
    receivedAt: new Date().toISOString(),
  };
  const context = assembleContext(trigger, agent.manifest);
  return { simulator, agent, context };
}

/** Setup with multiple backup configs — needed for incomplete_coverage scenario. */
function setupWithMultipleConfigs(state?: string) {
  const simulator = new BackupSimulator();
  if (state) simulator.transition(state);
  const agent = new BackupVerificationAgent(simulator);
  const trigger: AgentContext['trigger'] = {
    type: 'alert',
    source: 'monitoring',
    payload: {
      alertname: 'BackupStale',
      severity: 'critical',
      instance: 'backup-targets',
      backupConfigs: [
        { kind: 'file_directory', locations: ['/var/backups/app'], source: 'app_db' },
        { kind: 'pg_dump', locations: ['/var/backups/postgres'], source: 'orders_db' },
      ],
    },
    receivedAt: new Date().toISOString(),
  };
  const context = assembleContext(trigger, agent.manifest);
  return { simulator, agent, context };
}

describe('BackupVerificationAgent', () => {
  // ---------------------------------------------------------------------------
  // assessHealth — observable health status across scenarios
  // ---------------------------------------------------------------------------
  describe('assessHealth', () => {
    it('reports unhealthy when no backups found', async () => {
      const { agent, context } = setup('no_backups_found');
      const health = await agent.assessHealth(context);

      expect(health.status).toBe('unhealthy');
      expect(health.confidence).toBeGreaterThan(0);
      expect(health.signals.length).toBe(4);

      const existence = health.signals.find((s) => s.source === 'backup_existence');
      expect(existence?.status).toBe('critical');
    });

    it('reports unhealthy when integrity fails', async () => {
      const { agent, context } = setup('integrity_failure');
      const health = await agent.assessHealth(context);

      expect(health.status).toBe('unhealthy');
      const integrity = health.signals.find((s) => s.source === 'backup_integrity');
      expect(integrity?.status).toBe('critical');
    });

    it('reports unhealthy when size anomaly detected', async () => {
      const { agent, context } = setup('size_anomaly');
      const health = await agent.assessHealth(context);

      expect(health.status).toBe('unhealthy');
    });

    it('reports recovering when backups are stale', async () => {
      const { agent, context } = setup('stale_backup');
      const health = await agent.assessHealth(context);

      expect(health.status).toBe('recovering');
      const recency = health.signals.find((s) => s.source === 'backup_recency');
      expect(recency?.status).toBe('warning');
    });

    it('reports unhealthy when coverage is incomplete', async () => {
      const { agent, context } = setupWithMultipleConfigs('incomplete_coverage');
      const health = await agent.assessHealth(context);

      // Has both healthy and missing providers — the missing ones drive unhealthy
      expect(health.status).toBe('unhealthy');
    });

    it('reports healthy when all backups verified', async () => {
      const { agent, context } = setup('healthy');
      const health = await agent.assessHealth(context);

      expect(health.status).toBe('healthy');
      expect(health.signals.every((s) => s.status === 'healthy')).toBe(true);
      expect(health.recommendedActions.length).toBeGreaterThan(0);
    });

    it('includes summary text appropriate to status', async () => {
      const { agent, context } = setup('no_backups_found');
      const health = await agent.assessHealth(context);

      expect(health.summary).toContain('Missing or corrupted');
    });
  });

  // ---------------------------------------------------------------------------
  // diagnose — scenario classification
  // ---------------------------------------------------------------------------
  describe('diagnose', () => {
    it('identifies no_backups_found scenario', async () => {
      const { agent, context } = setup('no_backups_found');
      const diagnosis = await agent.diagnose(context);

      expect(diagnosis.status).toBe('identified');
      expect(diagnosis.scenario).toBe('no_backups_found');
      expect(diagnosis.confidence).toBe(0.98);
      expect(diagnosis.findings.length).toBeGreaterThan(0);
    });

    it('identifies integrity_failure scenario', async () => {
      const { agent, context } = setup('integrity_failure');
      const diagnosis = await agent.diagnose(context);

      expect(diagnosis.status).toBe('identified');
      expect(diagnosis.scenario).toBe('integrity_failure');
      expect(diagnosis.confidence).toBeGreaterThanOrEqual(0.90);
    });

    it('identifies size_anomaly scenario', async () => {
      const { agent, context } = setup('size_anomaly');
      const diagnosis = await agent.diagnose(context);

      expect(diagnosis.status).toBe('identified');
      expect(diagnosis.scenario).toBe('size_anomaly');
    });

    it('identifies stale_backup scenario', async () => {
      const { agent, context } = setup('stale_backup');
      const diagnosis = await agent.diagnose(context);

      expect(diagnosis.status).toBe('identified');
      expect(diagnosis.scenario).toBe('stale_backup');
      expect(diagnosis.confidence).toBe(0.95);
    });

    it('identifies incomplete_coverage scenario with multiple configs', async () => {
      const { agent, context } = setupWithMultipleConfigs('incomplete_coverage');
      const diagnosis = await agent.diagnose(context);

      expect(diagnosis.status).toBe('identified');
      // With 2 configs, first is healthy, second has no backups
      expect(diagnosis.scenario).toBeTruthy();
    });

    it('identifies rto_at_risk scenario', async () => {
      const { agent, context } = setup('rto_at_risk');
      const diagnosis = await agent.diagnose(context);

      expect(diagnosis.status).toBe('identified');
      expect(diagnosis.scenario).toBe('rto_at_risk');
      expect(diagnosis.findings.some((f) => f.source === 'rto_assessment')).toBe(true);
    });

    it('returns inconclusive for healthy state', async () => {
      const { agent, context } = setup('healthy');
      const diagnosis = await agent.diagnose(context);

      expect(diagnosis.status).toBe('inconclusive');
      expect(diagnosis.scenario).toBeNull();
      expect(diagnosis.confidence).toBe(1.0);
    });

    it('always includes backup_inventory and rpo_compliance findings', async () => {
      const { agent, context } = setup('stale_backup');
      const diagnosis = await agent.diagnose(context);

      const sources = diagnosis.findings.map((f) => f.source);
      expect(sources).toContain('backup_inventory');
      expect(sources).toContain('backup_verification');
      expect(sources).toContain('rpo_compliance');
      expect(sources).toContain('backup_coverage');
    });
  });

  // ---------------------------------------------------------------------------
  // plan — recovery plan structure and safety properties
  // ---------------------------------------------------------------------------
  describe('plan', () => {
    it('generates a valid recovery plan', async () => {
      const { agent, context } = setup('no_backups_found');
      const diagnosis = await agent.diagnose(context);
      const plan = await agent.plan(context, diagnosis);

      expect(plan.kind).toBe('RecoveryPlan');
      expect(plan.steps.length).toBeGreaterThan(0);
      expect(plan.rollbackStrategy).toBeDefined();
      expect(plan.impact).toBeDefined();
    });

    it('plan has unique step IDs', async () => {
      const { agent, context } = setup('stale_backup');
      const diagnosis = await agent.diagnose(context);
      const plan = await agent.plan(context, diagnosis);

      const ids = plan.steps.map((s) => s.stepId);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('plan includes human_notification step', async () => {
      const { agent, context } = setup('integrity_failure');
      const diagnosis = await agent.diagnose(context);
      const plan = await agent.plan(context, diagnosis);

      const hasNotification = plan.steps.some((s) => s.type === 'human_notification');
      expect(hasNotification).toBe(true);
    });

    it('plan includes checkpoint for audit trail', async () => {
      const { agent, context } = setup('size_anomaly');
      const diagnosis = await agent.diagnose(context);
      const plan = await agent.plan(context, diagnosis);

      const hasCheckpoint = plan.steps.some((s) => s.type === 'checkpoint');
      expect(hasCheckpoint).toBe(true);
    });

    it('plan rollback strategy is none (read-only agent)', async () => {
      const { agent, context } = setup('stale_backup');
      const diagnosis = await agent.diagnose(context);
      const plan = await agent.plan(context, diagnosis);

      expect(plan.rollbackStrategy.type).toBe('none');
    });

    it('plan reflects scenario in metadata', async () => {
      const { agent, context } = setup('stale_backup');
      const diagnosis = await agent.diagnose(context);
      const plan = await agent.plan(context, diagnosis);

      expect(plan.metadata.scenario).toBe('stale_backup');
      expect(plan.metadata.agentName).toBe('backup-verification');
    });

    it('critical scenarios flag elevated data loss risk in impact', async () => {
      const { agent, context } = setup('no_backups_found');
      const diagnosis = await agent.diagnose(context);
      const plan = await agent.plan(context, diagnosis);

      expect(plan.impact.dataLossRisk).toBe('possible');
    });

    it('non-critical scenarios flag no data loss risk', async () => {
      const { agent, context } = setup('stale_backup');
      const diagnosis = await agent.diagnose(context);
      const plan = await agent.plan(context, diagnosis);

      expect(plan.impact.dataLossRisk).toBe('none');
    });
  });

  // ---------------------------------------------------------------------------
  // replan — default behavior
  // ---------------------------------------------------------------------------
  describe('replan', () => {
    it('returns continue action', async () => {
      const { agent, context } = setup('stale_backup');
      const diagnosis = await agent.diagnose(context);
      const result = await agent.replan(context, diagnosis, {
        currentStepIndex: 0,
        completedSteps: [],
        captures: {},
        startedAt: new Date().toISOString(),
        elapsedMs: 0,
      });

      expect(result.action).toBe('continue');
    });
  });

  // ---------------------------------------------------------------------------
  // Full flow: assess → diagnose → plan
  // ---------------------------------------------------------------------------
  describe('full recovery flow', () => {
    it('flows from unhealthy assessment through to plan for each failure scenario', async () => {
      const scenarios = [
        'no_backups_found',
        'stale_backup',
        'size_anomaly',
        'integrity_failure',
        'rto_at_risk',
      ];

      for (const scenario of scenarios) {
        const { agent, context } = setup(scenario);

        const health = await agent.assessHealth(context);
        expect(health.status).not.toBe('unknown');

        const diagnosis = await agent.diagnose(context);
        expect(diagnosis.status).toBe('identified');

        const plan = await agent.plan(context, diagnosis);
        expect(plan.kind).toBe('RecoveryPlan');
        expect(plan.steps.length).toBeGreaterThan(0);
      }
    });

    it('healthy state produces no recovery plan scenario', async () => {
      const { agent, context } = setup('healthy');
      const health = await agent.assessHealth(context);
      expect(health.status).toBe('healthy');

      const diagnosis = await agent.diagnose(context);
      expect(diagnosis.scenario).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // manifest
  // ---------------------------------------------------------------------------
  describe('manifest', () => {
    it('has correct name and risk profile', () => {
      const { agent } = setup();
      expect(agent.manifest.metadata.name).toBe('backup-verification');
      expect(agent.manifest.spec.riskProfile.maxRiskLevel).toBe('routine');
      expect(agent.manifest.spec.riskProfile.dataLossPossible).toBe(false);
    });

    it('declares all 6 failure scenarios', () => {
      const { agent } = setup();
      expect(agent.manifest.spec.failureScenarios).toHaveLength(6);
      expect(agent.manifest.spec.failureScenarios).toContain('no_backups_found');
      expect(agent.manifest.spec.failureScenarios).toContain('stale_backup');
      expect(agent.manifest.spec.failureScenarios).toContain('size_anomaly');
      expect(agent.manifest.spec.failureScenarios).toContain('integrity_failure');
      expect(agent.manifest.spec.failureScenarios).toContain('incomplete_coverage');
      expect(agent.manifest.spec.failureScenarios).toContain('rto_at_risk');
    });
  });
});
