// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the Anthropic SDK so agent.ts can be imported without the dependency
vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }));

import {
  getCatalogEntry,
  matchCatalog,
  isCatalogCovered,
  configureCatalogSource,
  clearCatalogSource,
  type CatalogMatchInput,
} from '../framework/catalog.js';
import { PgReplicationAgent } from '../agent/pg-replication/agent.js';
import { PgSimulator } from '../agent/pg-replication/simulator.js';
import { assembleContext } from '../framework/context.js';
import type { AgentContext } from '../types/agent-context.js';
import type { CatalogEntry } from '../types/catalog-entry.js';
import type { RecoveryPlan } from '../types/recovery-plan.js';
import type { Command, RiskLevel } from '../types/common.js';
import type { RecoveryStep, SystemActionStep } from '../types/step-types.js';

const NOW = new Date('2026-08-09T12:00:00Z');
const CATALOG_ID = 'test-standard-recovery';

// --- Fixtures -------------------------------------------------------------

function makeCatalogEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    apiVersion: 'v0.2.1',
    kind: 'CatalogEntry',
    metadata: {
      catalogId: CATALOG_ID,
      name: 'Test Standard Recovery',
      description: 'Pre-authorized recovery used by the catalog decision table.',
      approvedBy: 'operator@example.test',
      approvedAt: '2026-06-01T10:00:00Z',
      reviewSchedule: 'P90D',
      expiresAt: '2026-12-01T10:00:00Z',
      ...(overrides.metadata ?? {}),
    },
    matchCriteria: {
      agentName: 'postgresql-replication-recovery',
      agentVersionConstraint: '>=1.2.0 <2.0.0',
      scenario: 'replication_lag_cascade',
      environment: 'production',
      maxRiskLevel: 'elevated',
      requiredStepPatterns: [
        { type: 'checkpoint', position: 'before_first_mutation' },
        { type: 'human_notification', position: 'any' },
      ],
      forbiddenOperations: ['ddl', 'admin_privilege'],
      maxStepCount: 15,
      maxEstimatedDuration: 'PT30M',
      ...(overrides.matchCriteria ?? {}),
    },
    authorization: {
      satisfiesApprovalFor: ['routine', 'elevated'],
      notificationRequired: true,
      notificationRecipients: [{ role: 'on_call_dba', urgency: 'high' }],
      ...(overrides.authorization ?? {}),
    },
  };
}

function makeSystemAction(
  stepId: string,
  riskLevel: RiskLevel,
  command: Command = { type: 'sql', statement: 'SELECT pg_terminate_backend(1)' },
): SystemActionStep {
  return {
    stepId,
    type: 'system_action',
    name: `Action ${stepId}`,
    executionContext: 'psql_cli',
    target: 'pg-primary',
    riskLevel,
    requiredCapabilities: ['db.query.read'],
    command,
    statePreservation: { before: [], after: [] },
    successCriteria: {
      description: 'OK',
      check: { type: 'sql', statement: 'SELECT 1', expect: { operator: 'eq', value: 1 } },
    },
    blastRadius: {
      directComponents: ['pg-primary'],
      indirectComponents: [],
      maxImpact: 'test',
      cascadeRisk: 'low',
    },
    timeout: 'PT30S',
  };
}

function makeCheckpoint(stepId: string): RecoveryStep {
  return { stepId, type: 'checkpoint', name: `Checkpoint ${stepId}`, stateCaptures: [] };
}

function makeNotification(stepId: string): RecoveryStep {
  return {
    stepId,
    type: 'human_notification',
    name: `Notify ${stepId}`,
    recipients: [{ role: 'dba', urgency: 'high' }],
    message: { summary: 'test', detail: 'test', actionRequired: false },
    channel: 'auto',
  };
}

/** A plan that satisfies every declared criterion of the fixture catalog entry. */
function makeConformingPlan(): RecoveryPlan {
  return {
    apiVersion: 'v0.2.1',
    kind: 'RecoveryPlan',
    metadata: {
      planId: 'rp-test-001',
      agentName: 'postgresql-replication-recovery',
      agentVersion: '1.4.0',
      scenario: 'replication_lag_cascade',
      createdAt: NOW.toISOString(),
      estimatedDuration: 'PT15M',
      summary: 'Conforming plan',
      supersedes: null,
    },
    impact: {
      affectedSystems: [],
      affectedServices: [],
      estimatedUserImpact: 'none',
      dataLossRisk: 'none',
    },
    steps: [
      makeNotification('step-001'),
      makeCheckpoint('step-002'),
      makeSystemAction('step-003', 'elevated'),
    ],
    rollbackStrategy: { type: 'stepwise', description: 'stepwise' },
  };
}

function makeInput(overrides: Partial<CatalogMatchInput> = {}): CatalogMatchInput {
  return {
    preAuthorizedCatalogs: [CATALOG_ID],
    environment: 'production',
    now: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  clearCatalogSource();
});

afterEach(() => {
  clearCatalogSource();
});

// --- Fail-closed default --------------------------------------------------

describe('catalog fails closed when no catalog source is configured', () => {
  it('getCatalogEntry returns null on the production path', () => {
    expect(getCatalogEntry()).toBeNull();
  });

  it('matchCatalog covers nothing when no catalog source is configured', () => {
    const result = matchCatalog(makeConformingPlan(), makeInput());
    expect(result.matched).toBe(false);
    expect(result.catalogEntry).toBeNull();
    expect(result.coveredRiskLevels).toEqual([]);
    expect(result.matchDetails.join(' ')).toMatch(/no pre-authorized catalog source is configured/i);
  });

  it('matchCatalog covers nothing when called without operator consent evidence', () => {
    configureCatalogSource([makeCatalogEntry()]);
    const result = matchCatalog(makeConformingPlan());
    expect(result.matched).toBe(false);
    expect(result.coveredRiskLevels).toEqual([]);
  });

  it('the shipped PostgreSQL replication plan is not pre-authorized by default', async () => {
    const agent = new PgReplicationAgent(new PgSimulator());
    const trigger: AgentContext['trigger'] = {
      type: 'alert',
      source: 'prometheus',
      payload: { alertname: 'PostgresReplicationLagCritical' },
      receivedAt: new Date().toISOString(),
    };
    const context = assembleContext(trigger, agent.manifest);
    const diagnosis = await agent.diagnose(context);
    const plan = await agent.plan(context, diagnosis);

    const result = matchCatalog(plan, {
      preAuthorizedCatalogs: context.preAuthorizedCatalogs,
    });

    expect(result.matched).toBe(false);
    expect(result.coveredRiskLevels).toEqual([]);
  });
});

// --- Happy path -----------------------------------------------------------

describe('matchCatalog with a configured, unexpired, operator-authorized catalog', () => {
  it('matches when every declared criterion is satisfied', () => {
    configureCatalogSource([makeCatalogEntry()]);
    const result = matchCatalog(makeConformingPlan(), makeInput());
    expect(result.matchDetails.join('\n')).not.toMatch(/rejected/i);
    expect(result.matched).toBe(true);
    expect(result.coveredRiskLevels).toEqual(['routine', 'elevated']);
  });

  it('never covers a risk level above the catalog maxRiskLevel, even if authorization claims it', () => {
    configureCatalogSource([
      makeCatalogEntry({
        authorization: {
          satisfiesApprovalFor: ['routine', 'elevated', 'high', 'critical'],
          notificationRequired: true,
          notificationRecipients: [{ role: 'on_call_dba', urgency: 'high' }],
        },
      }),
    ]);
    const result = matchCatalog(makeConformingPlan(), makeInput());
    expect(result.matched).toBe(true);
    expect(result.coveredRiskLevels).toEqual(['routine', 'elevated']);
  });
});

// --- Decision table: every declared criterion must reject ------------------

interface RejectionRow {
  readonly name: string;
  readonly entry?: CatalogEntry;
  readonly mutatePlan?: (plan: RecoveryPlan) => void;
  readonly input?: Partial<CatalogMatchInput>;
  readonly reason: RegExp;
}

const rejectionRows: RejectionRow[] = [
  {
    name: 'an expired catalog entry pre-authorizes nothing',
    entry: makeCatalogEntry({
      metadata: {
        catalogId: CATALOG_ID,
        name: 'Test Standard Recovery',
        description: 'Expired.',
        approvedBy: 'operator@example.test',
        approvedAt: '2026-02-15T10:00:00Z',
        reviewSchedule: 'P90D',
        expiresAt: '2026-05-15T10:00:00Z',
      },
    }),
    reason: /expired/i,
  },
  {
    name: 'a catalog entry with an unparseable expiry pre-authorizes nothing',
    entry: makeCatalogEntry({
      metadata: {
        catalogId: CATALOG_ID,
        name: 'Test Standard Recovery',
        description: 'Bad expiry.',
        approvedBy: 'operator@example.test',
        approvedAt: '2026-02-15T10:00:00Z',
        reviewSchedule: 'P90D',
        expiresAt: 'whenever',
      },
    }),
    reason: /unparseable expiresAt 'whenever'/i,
  },
  {
    name: 'a catalogId the operator never pre-authorized is not applied',
    input: { preAuthorizedCatalogs: [] },
    reason: /not pre-authorized by the operator/i,
  },
  {
    name: 'a DDL statement in a step command trips forbiddenOperations',
    mutatePlan: (plan) => {
      plan.steps.push(
        makeSystemAction('step-ddl', 'elevated', {
          type: 'sql',
          statement: 'ALTER TABLE orders ADD COLUMN backfilled boolean',
        }),
      );
    },
    reason: /forbidden operation 'ddl'/i,
  },
  {
    name: 'a privilege grant in a step command trips forbiddenOperations',
    mutatePlan: (plan) => {
      plan.steps.push(
        makeSystemAction('step-grant', 'elevated', {
          type: 'sql',
          statement: 'GRANT ALL PRIVILEGES ON DATABASE app TO recovery_bot',
        }),
      );
    },
    reason: /forbidden operation 'admin_privilege'/i,
  },
  {
    name: 'CREATE ROLE counts as DDL even though it is also a privilege change',
    entry: makeCatalogEntry({
      matchCriteria: { ...makeCatalogEntry().matchCriteria, forbiddenOperations: ['ddl'] },
    }),
    mutatePlan: (plan) => {
      plan.steps.push(
        makeSystemAction('step-create-role', 'elevated', {
          type: 'sql',
          statement: 'CREATE ROLE recovery_bot LOGIN',
        }),
      );
    },
    reason: /forbidden operation 'ddl'/i,
  },
  {
    name: 'a DDL statement after a semicolon is still caught',
    mutatePlan: (plan) => {
      plan.steps.push(
        makeSystemAction('step-multi', 'elevated', {
          type: 'sql',
          statement: 'SELECT 1; DROP TABLE orders',
        }),
      );
    },
    reason: /forbidden operation 'ddl'/i,
  },
  {
    name: 'a DDL statement hidden behind a leading block comment is still caught',
    mutatePlan: (plan) => {
      plan.steps.push(
        makeSystemAction('step-comment', 'elevated', {
          type: 'sql',
          statement: '/* routine cleanup */ DROP TABLE orders',
        }),
      );
    },
    reason: /forbidden operation 'ddl'/i,
  },
  {
    name: 'a DDL statement hidden behind a leading line comment is still caught',
    mutatePlan: (plan) => {
      plan.steps.push(
        makeSystemAction('step-line-comment', 'elevated', {
          type: 'sql',
          statement: '-- routine cleanup\nDROP TABLE orders',
        }),
      );
    },
    reason: /forbidden operation 'ddl'/i,
  },
  {
    name: 'DDL hidden inside a DO block is caught',
    mutatePlan: (plan) => {
      plan.steps.push(
        makeSystemAction('step-do', 'elevated', {
          type: 'sql',
          statement: 'DO $$ BEGIN DROP TABLE orders; END $$;',
        }),
      );
    },
    reason: /forbidden operation 'ddl'/i,
  },
  {
    name: 'DDL hidden inside a dollar-quoted body is caught',
    mutatePlan: (plan) => {
      plan.steps.push(
        makeSystemAction('step-dollar', 'elevated', {
          type: 'sql',
          statement: "SELECT run_maintenance($body$ DROP TABLE orders $body$)",
        }),
      );
    },
    reason: /forbidden operation 'ddl'/i,
  },
  {
    name: 'DDL hidden inside dynamic EXECUTE is caught',
    mutatePlan: (plan) => {
      plan.steps.push(
        makeSystemAction('step-execute', 'elevated', {
          type: 'sql',
          statement: "EXECUTE format('DROP TABLE %I', 'orders')",
        }),
      );
    },
    reason: /forbidden operation 'ddl'/i,
  },
  {
    name: 'a DDL command inside a conditional branch is caught',
    mutatePlan: (plan) => {
      plan.steps.push({
        stepId: 'step-cond',
        type: 'conditional',
        name: 'Branch',
        condition: {
          description: 'always',
          check: { type: 'sql', statement: 'SELECT 1', expect: { operator: 'eq', value: 1 } },
        },
        thenStep: makeSystemAction('step-cond-then', 'elevated', {
          type: 'sql',
          statement: 'TRUNCATE TABLE orders',
        }),
        elseStep: 'skip',
      });
    },
    reason: /forbidden operation 'ddl'/i,
  },
  {
    name: 'a DDL command inside a nested conditional branch is caught',
    mutatePlan: (plan) => {
      // Nested conditionals are not representable in NonConditionalStep and the
      // validator rejects them — this guards matchCatalog against plans that
      // never went through the validator (playbooks, third-party plugins).
      const inner = {
        stepId: 'step-inner-cond',
        type: 'conditional',
        name: 'Inner branch',
        condition: {
          description: 'always',
          check: { type: 'sql', statement: 'SELECT 1', expect: { operator: 'eq', value: 1 } },
        },
        thenStep: makeSystemAction('step-inner-then', 'elevated', {
          type: 'sql',
          statement: 'DROP TABLE orders',
        }),
        elseStep: 'skip',
      };
      plan.steps.push({
        stepId: 'step-outer-cond',
        type: 'conditional',
        name: 'Outer branch',
        condition: {
          description: 'always',
          check: { type: 'sql', statement: 'SELECT 1', expect: { operator: 'eq', value: 1 } },
        },
        thenStep: inner,
        elseStep: 'skip',
      } as unknown as RecoveryStep);
    },
    reason: /forbidden operation 'ddl'/i,
  },
  {
    name: 'a prerelease agent version is rejected with a prerelease-specific reason',
    mutatePlan: (plan) => {
      plan.metadata.agentVersion = '1.4.0-rc.1';
    },
    reason: /'1\.4\.0-rc\.1' is a prerelease build/i,
  },
  {
    name: 'a forbidden operation declared as a command subtype is caught',
    mutatePlan: (plan) => {
      plan.steps.push(
        makeSystemAction('step-sub', 'elevated', {
          type: 'structured_command',
          subtype: 'ddl',
          operation: 'create_index',
        }),
      );
    },
    reason: /forbidden operation 'ddl'/i,
  },
  {
    name: 'a plan whose risk exceeds the catalog maxRiskLevel is rejected',
    mutatePlan: (plan) => {
      plan.steps.push(makeSystemAction('step-high', 'high'));
    },
    reason: /risk level 'high' exceeds catalog maxRiskLevel 'elevated'/i,
  },
  {
    name: 'a plan running in a different environment than the catalog declares is rejected',
    input: { environment: 'staging' },
    reason: /environment 'staging'.*'production'/i,
  },
  {
    name: 'an unknown environment fails closed against a catalog that declares one',
    input: { environment: undefined },
    reason: /environment is unknown/i,
  },
  {
    name: 'an agent version outside agentVersionConstraint is rejected',
    mutatePlan: (plan) => {
      plan.metadata.agentVersion = '2.1.0';
    },
    reason: /2\.1\.0.*>=1\.2\.0 <2\.0\.0/,
  },
  {
    name: 'an unparseable agent version fails closed',
    mutatePlan: (plan) => {
      plan.metadata.agentVersion = 'nightly';
    },
    reason: /'nightly' is not a valid semantic version/i,
  },
  {
    name: 'an estimated duration above maxEstimatedDuration is rejected',
    mutatePlan: (plan) => {
      plan.metadata.estimatedDuration = 'PT45M';
    },
    reason: /duration 'PT45M'.*'PT30M'/i,
  },
  {
    name: 'an unparseable estimated duration fails closed',
    mutatePlan: (plan) => {
      plan.metadata.estimatedDuration = 'about an hour';
    },
    reason: /'about an hour' is not a parseable ISO-8601 duration/i,
  },
  {
    name: 'a different agent is rejected',
    mutatePlan: (plan) => {
      plan.metadata.agentName = 'wrong-agent-name';
    },
    reason: /agent name 'wrong-agent-name' does not match/i,
  },
  {
    name: 'a different scenario is rejected',
    mutatePlan: (plan) => {
      plan.metadata.scenario = 'wrong_scenario';
    },
    reason: /scenario 'wrong_scenario' does not match/i,
  },
  {
    name: 'a plan with more steps than maxStepCount is rejected',
    mutatePlan: (plan) => {
      while (plan.steps.length <= 15) {
        plan.steps.push(makeNotification(`step-extra-${plan.steps.length}`));
      }
    },
    reason: /step count 16 exceeds maxStepCount 15/i,
  },
  {
    name: 'a plan missing a required checkpoint step is rejected',
    mutatePlan: (plan) => {
      plan.steps = plan.steps.filter((s) => s.type !== 'checkpoint');
    },
    reason: /required step pattern 'checkpoint'/i,
  },
  {
    name: 'a plan missing a required notification step is rejected',
    mutatePlan: (plan) => {
      plan.steps = plan.steps.filter((s) => s.type !== 'human_notification');
    },
    reason: /required step pattern 'human_notification'/i,
  },
  {
    name: 'a checkpoint that lands after the first mutation violates before_first_mutation',
    mutatePlan: (plan) => {
      plan.steps = [
        makeNotification('step-001'),
        makeSystemAction('step-003', 'elevated'),
        makeCheckpoint('step-002'),
      ];
    },
    reason: /before_first_mutation/i,
  },
];

describe('matchCatalog rejects on every declared criterion', () => {
  it.each(rejectionRows)('$name', ({ entry, mutatePlan, input, reason }) => {
    configureCatalogSource([entry ?? makeCatalogEntry()]);
    const plan = makeConformingPlan();
    mutatePlan?.(plan);

    const result = matchCatalog(plan, makeInput(input));

    expect(result.matched).toBe(false);
    expect(result.coveredRiskLevels).toEqual([]);
    // Match only the rejection lines: an accepted-criterion line such as
    // "agent version 1.4.0 satisfies ..." must never satisfy a row's pattern.
    const rejections = result.matchDetails.filter((d) => d.includes('rejected:'));
    expect(rejections.join('\n')).toMatch(reason);
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
