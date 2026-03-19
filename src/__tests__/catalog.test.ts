// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';

// Mock the Anthropic SDK so agent.ts can be imported without the dependency
vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }));

import { getCatalogEntry, matchCatalog, isCatalogCovered } from '../framework/catalog.js';
import { PgReplicationAgent } from '../agent/pg-replication/agent.js';
import { PgSimulator } from '../agent/pg-replication/simulator.js';
import { assembleContext } from '../framework/context.js';
import type { AgentContext } from '../types/agent-context.js';
import type { RecoveryPlan } from '../types/recovery-plan.js';

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

async function makeMatchingPlan(): Promise<RecoveryPlan> {
  const agent = new PgReplicationAgent(new PgSimulator());
  const context = makeContext(agent);
  const diagnosis = await agent.diagnose(context);
  return agent.plan(context, diagnosis);
}

describe('catalog', () => {
  describe('getCatalogEntry', () => {
    it('returns a valid catalog entry with expected structure', () => {
      const entry = getCatalogEntry();
      expect(entry.apiVersion).toBe('v0.2.1');
      expect(entry.kind).toBe('CatalogEntry');
      expect(entry.metadata.catalogId).toBe('pg-replication-standard-recovery');
      expect(entry.matchCriteria.agentName).toBe('postgresql-replication-recovery');
      expect(entry.matchCriteria.scenario).toBe('replication_lag_cascade');
      expect(entry.authorization.satisfiesApprovalFor).toContain('routine');
      expect(entry.authorization.satisfiesApprovalFor).toContain('elevated');
    });
  });

  describe('matchCatalog', () => {
    it('returns matched=true for a valid PG replication plan', async () => {
      const plan = await makeMatchingPlan();
      const result = matchCatalog(plan);
      expect(result.matched).toBe(true);
      expect(result.catalogEntry).not.toBeNull();
      expect(result.coveredRiskLevels).toContain('routine');
      expect(result.coveredRiskLevels).toContain('elevated');
    });

    it('returns matched=false when agent name does not match', async () => {
      const plan = await makeMatchingPlan();
      plan.metadata.agentName = 'wrong-agent-name';
      const result = matchCatalog(plan);
      expect(result.matched).toBe(false);
      expect(result.matchDetails.some((d) => d.includes('Agent name mismatch'))).toBe(true);
    });

    it('returns matched=false when scenario does not match', async () => {
      const plan = await makeMatchingPlan();
      plan.metadata.scenario = 'wrong_scenario';
      const result = matchCatalog(plan);
      expect(result.matched).toBe(false);
      expect(result.matchDetails.some((d) => d.includes('Scenario mismatch'))).toBe(true);
    });

    it('returns matched=false when step count exceeds the limit', async () => {
      const plan = await makeMatchingPlan();
      // Add enough dummy steps to exceed maxStepCount (15)
      while (plan.steps.length <= 15) {
        plan.steps.push({
          stepId: `step-extra-${plan.steps.length}`,
          type: 'human_notification',
          name: 'Extra notification',
          recipients: [{ role: 'test', urgency: 'low' }],
          message: {
            summary: 'Extra',
            detail: 'Extra step to exceed limit',
            actionRequired: false,
          },
          channel: 'auto',
        });
      }
      const result = matchCatalog(plan);
      expect(result.matched).toBe(false);
      expect(result.matchDetails.some((d) => d.includes('exceeds max'))).toBe(true);
    });

    it('returns matched=false when checkpoint or notification steps are missing', async () => {
      const plan = await makeMatchingPlan();
      // Remove all checkpoint and notification steps
      plan.steps = plan.steps.filter(
        (s) => s.type !== 'checkpoint' && s.type !== 'human_notification',
      );
      const result = matchCatalog(plan);
      expect(result.matched).toBe(false);
      expect(result.matchDetails.some((d) => d.includes('Missing required step patterns'))).toBe(true);
    });
  });

  describe('isCatalogCovered', () => {
    it('returns true when the risk level is in the covered levels', () => {
      expect(isCatalogCovered('routine', ['routine', 'elevated'])).toBe(true);
    });

    it('returns false when the risk level is not in the covered levels', () => {
      expect(isCatalogCovered('high', ['routine', 'elevated'])).toBe(false);
    });
  });
});
