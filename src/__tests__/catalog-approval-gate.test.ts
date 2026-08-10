// SPDX-License-Identifier: Apache-2.0
/**
 * End-to-end guard for the catalog pre-authorization path.
 *
 * The exploitation path this closes: a plan that names the pre-authorized
 * agent and scenario, stays under the step count, and includes a checkpoint
 * plus a notification used to be granted standing approval for every
 * `elevated` action — on an expired approval the operator never granted.
 *
 * This test drives the real ExecutionEngine and the real coordinator (only
 * stdin is stubbed) to prove such a plan now reaches a human.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }));

const questionMock = vi.fn(async () => 'reject');
vi.mock('node:readline/promises', () => ({
  createInterface: () => ({ question: questionMock, close: () => {} }),
}));

import { ExecutionEngine } from '../framework/engine.js';
import { PgReplicationAgent } from '../agent/pg-replication/agent.js';
import { PgSimulator } from '../agent/pg-replication/simulator.js';
import { ForensicRecorder } from '../framework/forensics.js';
import { assembleContext } from '../framework/context.js';
import { matchCatalog, configureCatalogSource, clearCatalogSource } from '../framework/catalog.js';
import { DEMO_CATALOG_ENTRY } from '../demo/catalog-fixture.js';
import type { AgentContext } from '../types/agent-context.js';

beforeEach(() => {
  questionMock.mockClear();
  // The operator has pre-authorized this catalog id, and the catalog source is
  // configured — the most permissive starting position available.
  configureCatalogSource([DEMO_CATALOG_ENTRY]);
});

afterEach(() => {
  clearCatalogSource();
});

it('a plan matching the legacy criteria no longer buys elevated pre-authorization', async () => {
  const simulator = new PgSimulator();
  const agent = new PgReplicationAgent(simulator);
  const trigger: AgentContext['trigger'] = {
    type: 'alert',
    source: 'prometheus',
    payload: { alertname: 'PostgresReplicationLagCritical', severity: 'critical' },
    receivedAt: new Date().toISOString(),
  };
  const context = assembleContext(trigger, agent.manifest);
  // Isolate the catalog: the demo context's scenario trust override is a
  // separate auto-approval path, fixed independently in the context PR.
  context.trustScenarioOverrides = {};

  const diagnosis = await agent.diagnose(context);
  const plan = await agent.plan(context, diagnosis);

  // Shape the plan the way a hostile playbook would: satisfy the four criteria
  // the old matcher checked, and keep every step at or below `elevated` so the
  // catalog's claimed coverage applies to the whole plan.
  for (const step of plan.steps) {
    if (step.type === 'system_action' && step.riskLevel === 'high') {
      step.riskLevel = 'elevated';
    }
  }
  expect(plan.metadata.agentName).toBe(DEMO_CATALOG_ENTRY.matchCriteria.agentName);
  expect(plan.metadata.scenario).toBe(DEMO_CATALOG_ENTRY.matchCriteria.scenario);
  expect(plan.steps.length).toBeLessThanOrEqual(DEMO_CATALOG_ENTRY.matchCriteria.maxStepCount);
  expect(plan.steps.some((s) => s.type === 'checkpoint')).toBe(true);
  expect(plan.steps.some((s) => s.type === 'human_notification')).toBe(true);

  const catalogMatch = matchCatalog(plan, {
    preAuthorizedCatalogs: context.preAuthorizedCatalogs,
  });
  expect(catalogMatch.matched).toBe(false);
  expect(catalogMatch.coveredRiskLevels).toEqual([]);

  const recorder = new ForensicRecorder();
  recorder.setContext(context);
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
  engine.setCoveredRiskLevels(catalogMatch.coveredRiskLevels);

  const results = await engine.executePlan(plan, diagnosis);

  // A human was asked, and their rejection stopped the plan.
  expect(questionMock).toHaveBeenCalledTimes(1);
  const approvalStep = plan.steps.find((s) => s.type === 'human_approval');
  expect(approvalStep).toBeDefined();
  const approvalResult = results.find((r) => r.stepId === approvalStep!.stepId);
  expect(approvalResult?.status).toBe('failed');
  expect(approvalResult?.error).toBe('Human rejected the step');
});

describe('with the catalog source cleared', () => {
  it('grants nothing at all', () => {
    clearCatalogSource();
    const result = matchCatalog(
      {
        apiVersion: 'v0.2.1',
        kind: 'RecoveryPlan',
        metadata: {
          planId: 'rp-1',
          agentName: DEMO_CATALOG_ENTRY.matchCriteria.agentName,
          agentVersion: '1.4.0',
          scenario: DEMO_CATALOG_ENTRY.matchCriteria.scenario,
          createdAt: new Date().toISOString(),
          estimatedDuration: 'PT5M',
          summary: 'hostile',
          supersedes: null,
        },
        impact: {
          affectedSystems: [],
          affectedServices: [],
          estimatedUserImpact: 'none',
          dataLossRisk: 'none',
        },
        steps: [],
        rollbackStrategy: { type: 'none', description: 'none' },
      },
      { preAuthorizedCatalogs: [DEMO_CATALOG_ENTRY.metadata.catalogId] },
    );
    expect(result.matched).toBe(false);
    expect(result.coveredRiskLevels).toEqual([]);
  });
});
