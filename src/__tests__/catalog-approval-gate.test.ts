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
import type { CatalogEntry } from '../types/catalog-entry.js';
import type { RiskLevel } from '../types/common.js';
import type { RecoveryPlan } from '../types/recovery-plan.js';
import type { StepResult } from '../types/execution-state.js';

/** Pinned evaluation time, so the live entries below are unambiguously unexpired. */
const NOW = new Date('2026-08-10T12:00:00Z');
const CATALOG_ID = 'pg-replication-standard-recovery';

/**
 * A catalog entry that genuinely matches the PostgreSQL plan: unexpired,
 * operator-authorized, and covering up to `maxRisk`. Used to prove the gates
 * that must hold *even when the catalog really does apply*.
 */
function makeLiveEntry(maxRisk: RiskLevel, covers: RiskLevel[]): CatalogEntry {
  return {
    ...DEMO_CATALOG_ENTRY,
    metadata: {
      ...DEMO_CATALOG_ENTRY.metadata,
      catalogId: CATALOG_ID,
      expiresAt: '2027-01-01T00:00:00Z',
    },
    matchCriteria: { ...DEMO_CATALOG_ENTRY.matchCriteria, maxRiskLevel: maxRisk },
    authorization: { ...DEMO_CATALOG_ENTRY.authorization, satisfiesApprovalFor: covers },
  };
}

async function buildPgPlan(): Promise<{
  simulator: PgSimulator;
  agent: PgReplicationAgent;
  context: AgentContext;
  diagnosis: Awaited<ReturnType<PgReplicationAgent['diagnose']>>;
  plan: RecoveryPlan;
}> {
  const simulator = new PgSimulator();
  const agent = new PgReplicationAgent(simulator);
  const trigger: AgentContext['trigger'] = {
    type: 'alert',
    source: 'prometheus',
    payload: { alertname: 'PostgresReplicationLagCritical', severity: 'critical' },
    receivedAt: NOW.toISOString(),
  };
  const context = assembleContext(trigger, agent.manifest);
  // Isolate the catalog: the demo context's scenario trust override is a
  // separate auto-approval path, fixed independently in the context PR.
  context.trustScenarioOverrides = {};
  const diagnosis = await agent.diagnose(context);
  const plan = await agent.plan(context, diagnosis);
  return { simulator, agent, context, diagnosis, plan };
}

async function runPlan(
  built: Awaited<ReturnType<typeof buildPgPlan>>,
  coveredRiskLevels: RiskLevel[],
): Promise<StepResult[]> {
  const { simulator, agent, context, diagnosis, plan } = built;
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
  engine.setCoveredRiskLevels(coveredRiskLevels);
  return engine.executePlan(plan, diagnosis);
}

beforeEach(() => {
  questionMock.mockClear();
  // The operator has pre-authorized this catalog id, and the catalog source is
  // configured — the most permissive starting position available.
  configureCatalogSource([DEMO_CATALOG_ENTRY]);
});

afterEach(() => {
  clearCatalogSource();
});

describe('a catalog that genuinely matches still cannot bypass the hard gates', () => {
  it('covers what it declares — the baseline these gates are tested against', async () => {
    configureCatalogSource([makeLiveEntry('high', ['routine', 'elevated', 'high'])]);
    const built = await buildPgPlan();

    const match = matchCatalog(built.plan, {
      preAuthorizedCatalogs: built.context.preAuthorizedCatalogs,
      environment: 'production',
      now: NOW,
    });

    expect(match.matchDetails.filter((d) => d.includes('rejected:'))).toEqual([]);
    expect(match.matched).toBe(true);
    expect(match.coveredRiskLevels).toEqual(['routine', 'elevated', 'high']);
  });

  it('a high-risk plan still reaches a human even when the catalog covers high', async () => {
    configureCatalogSource([makeLiveEntry('high', ['routine', 'elevated', 'high'])]);
    const built = await buildPgPlan();

    const match = matchCatalog(built.plan, {
      preAuthorizedCatalogs: built.context.preAuthorizedCatalogs,
      environment: 'production',
      now: NOW,
    });
    // The catalog really does apply, and really does claim `high`.
    expect(match.matched).toBe(true);
    expect(match.coveredRiskLevels).toContain('high');

    const results = await runPlan(built, match.coveredRiskLevels);

    // Only the high/critical check standing above the catalog short-circuit in
    // shouldAutoApprove keeps this from auto-approving.
    expect(questionMock).toHaveBeenCalledTimes(1);
    const approvalStep = built.plan.steps.find((s) => s.type === 'human_approval');
    const approvalResult = results.find((r) => r.stepId === approvalStep!.stepId);
    expect(approvalResult?.error).toBe('Human rejected the step');
  });

  it('an elevated plan still reaches a human when requireApprovalForAllElevated is set', async () => {
    configureCatalogSource([makeLiveEntry('elevated', ['routine', 'elevated'])]);
    const built = await buildPgPlan();
    built.context.organizationalPolicies.requireApprovalForAllElevated = true;
    // Keep every step at or below `elevated` so catalog coverage applies to the
    // whole plan and only the policy check can stop it.
    for (const step of built.plan.steps) {
      if (step.type === 'system_action' && step.riskLevel === 'high') step.riskLevel = 'elevated';
    }

    const match = matchCatalog(built.plan, {
      preAuthorizedCatalogs: built.context.preAuthorizedCatalogs,
      environment: 'production',
      now: NOW,
    });
    expect(match.matched).toBe(true);
    expect(match.coveredRiskLevels).toEqual(['routine', 'elevated']);

    const results = await runPlan(built, match.coveredRiskLevels);

    expect(questionMock).toHaveBeenCalledTimes(1);
    const approvalStep = built.plan.steps.find((s) => s.type === 'human_approval');
    const approvalResult = results.find((r) => r.stepId === approvalStep!.stepId);
    expect(approvalResult?.error).toBe('Human rejected the step');
  });
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
