// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * `explainPlan`'s degradation paths.
 *
 * `ai-response-budgets.test.ts` pins the budget (enough tokens and time for the
 * real explanation to arrive). This file pins what the operator gets when it
 * does not: the structural fallback, and the response-shape defaults that keep
 * a partially-shaped AI reply usable instead of throwing.
 *
 * That matters because the fallback is indistinguishable from a real answer in
 * the terminal apart from `source`. The truncation bug this arc fixed was
 * exactly that failure — a fallback presented as an explanation — so the
 * fallback itself has to stay correct and complete for every step type.
 *
 * Hermetic: the SDK is mocked and the network profile is written directly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as AnthropicSdk from '@anthropic-ai/sdk';
import type { NetworkProfile } from '@crisismode/agent-sdk';
import { explainPlan } from '../framework/ai-explainer.js';
import { validatePlan } from '../framework/validator.js';
import { safetyManifestFor } from './ai-explainer-plan-fixtures.js';
import { resetNetworkProfile, setNetworkProfile } from '../framework/network-profile.js';
import type { RecoveryPlan } from '../types/recovery-plan.js';
import type { DiagnosisResult } from '../types/diagnosis-result.js';

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof AnthropicSdk>();
  return {
    ...actual,
    default: class {
      messages = { create: createMock };
    },
  };
});

const DIAGNOSIS: DiagnosisResult = {
  status: 'identified',
  scenario: 'replication_lag_cascade',
  confidence: 0.78,
  findings: [],
  diagnosticPlanNeeded: false,
};

/**
 * One step of every type, so the fallback's switch is exercised end to end.
 *
 * Contract-compliant as well as complete: the elevated-risk `system_action`
 * carries `statePreservation.before` captures and the plan carries a
 * `human_notification`, per CLAUDE.md's safety rules and
 * src/framework/validator.ts. `explainPlan` never validates what it is handed,
 * so `passes the real plan validator` below is what keeps that true — a plan
 * fixture with one step of every type is the one most likely to be copied as a
 * starting point, which makes being wrong here expensive.
 *
 * The trailing cast covers only plan-envelope fields nothing here reads
 * (agentName, createdAt, affectedSystems, ...).
 */
function makeAllStepTypesPlan(overrides: Partial<RecoveryPlan> = {}): RecoveryPlan {
  return {
    planId: 'rp-fallback-001',
    metadata: {
      scenario: 'replication_lag_cascade',
      summary: 'Resync the lagging replica',
      estimatedDuration: 'PT15M',
    },
    steps: [
      {
        stepId: 'step-001',
        type: 'diagnosis_action',
        name: 'Assess replication lag',
        executionContext: 'postgresql_read',
        target: 'prod-db-primary',
        // No `operation`: the AI prompt builder has to tolerate a command that
        // only names its type.
        command: { type: 'sql' },
      },
      {
        stepId: 'step-002',
        type: 'human_notification',
        name: 'Page the on-call DBA',
        recipients: [{ role: 'dba-oncall', urgency: 'high' }],
        message: {
          summary: 'Replication recovery starting',
          detail: 'The lagging replica will be disconnected and resynced.',
          actionRequired: false,
        },
        channel: 'slack',
      },
      {
        stepId: 'step-003',
        type: 'checkpoint',
        name: 'Pre-recovery checkpoint',
        stateCaptures: [
          {
            name: 'replication_state',
            captureType: 'sql_query',
            statement: 'SELECT * FROM pg_stat_replication;',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
          {
            name: 'replication_slots',
            captureType: 'sql_query',
            statement: 'SELECT * FROM pg_replication_slots;',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      },
      {
        stepId: 'step-004',
        type: 'system_action',
        name: 'Disconnect the lagging replica',
        executionContext: 'postgresql_write',
        target: 'prod-db-primary',
        riskLevel: 'elevated',
        requiredCapabilities: ['db.replica.disconnect'],
        command: { type: 'sql', operation: 'SELECT pg_terminate_backend(pid)' },
        // Required at elevated risk or higher: the pre-mutation snapshot is
        // what a rollback and the forensic trail are reconstructed from.
        statePreservation: {
          before: [
            {
              name: 'replication_state_snapshot',
              captureType: 'sql_query',
              statement: 'SELECT * FROM pg_stat_replication;',
              captureCost: 'negligible',
              capturePolicy: 'required',
              retention: 'P30D',
            },
          ],
          after: [
            {
              name: 'replication_state_post_disconnect',
              captureType: 'sql_query',
              statement: 'SELECT * FROM pg_stat_replication;',
              captureCost: 'negligible',
              capturePolicy: 'best_effort',
              retention: 'P30D',
            },
          ],
        },
        blastRadius: {
          directComponents: ['pg-replica-52', 'read-pool'],
          indirectComponents: ['reporting-jobs'],
          maxImpact: 'single_replica_disconnected',
          cascadeRisk: 'low',
        },
      },
      {
        stepId: 'step-005',
        type: 'human_approval',
        name: 'Approve resynchronization',
        approvers: [{ role: 'dba-oncall', required: true }],
        requiredApprovals: 1,
        presentation: { summary: 'Rebuild replica 10.0.1.52 from a base backup?' },
        timeout: 'PT10M',
        timeoutAction: 'escalate',
      },
      {
        stepId: 'step-006',
        type: 'replanning_checkpoint',
        name: 'Reassess before rebuild',
        fastReplan: true,
        replanTimeout: 'PT30S',
      },
      {
        stepId: 'step-007',
        type: 'conditional',
        name: 'Restore traffic if healthy',
        condition: { description: 'replica lag below 10s' },
        thenStep: {
          stepId: 'step-007-then',
          type: 'human_notification',
          name: 'Confirm the replica is serving reads again',
          recipients: [{ role: 'dba-oncall', urgency: 'low' }],
          message: {
            summary: 'Replica 10.0.1.52 is back in the read pool',
            detail: 'Lag is below the 10s threshold and traffic has been restored.',
            actionRequired: false,
          },
          channel: 'slack',
        },
        elseStep: 'skip',
      },
      {
        stepId: 'step-008',
        type: 'system_action',
        name: 'Reattach the replica to the read pool',
        executionContext: 'load_balancer',
        target: 'read-pool',
        riskLevel: 'routine',
        requiredCapabilities: ['traffic.backend.attach'],
        // No `operation` — the prompt builder must not emit a trailing space.
        command: { type: 'configuration_change' },
        statePreservation: { before: [], after: [] },
        blastRadius: {
          directComponents: ['pgbouncer'],
          indirectComponents: [],
          maxImpact: 'read_pool_membership_changed',
          cascadeRisk: 'none',
        },
      },
    ],
    rollbackStrategy: {
      type: 'stepwise',
      description: 'Undo each completed step in reverse order.',
    },
    impact: {
      dataLossRisk: 'none',
      estimatedUserImpact: 'Read queries may be slower',
    },
    ...overrides,
  } as unknown as RecoveryPlan;
}

function offlineProfile(): NetworkProfile {
  const checkedAt = '2026-08-09T12:00:00.000Z';
  return {
    internet: { status: 'unavailable', probes: [], checkedAt },
    hub: { status: 'unknown', probes: [], checkedAt },
    targets: { status: 'available', probes: [], checkedAt },
    dns: { available: false, latencyMs: 0 },
    mode: 'private_only',
    profiledAt: checkedAt,
  };
}

/**
 * The mechanical guard: assert the whole validation result rather than a
 * hand-picked subset of checks, so a rule added to the validator later applies
 * to this fixture automatically instead of needing a reviewer to remember it.
 */
describe('all-step-types plan fixture', () => {
  it('passes the real plan validator', () => {
    const result = validatePlan(
      makeAllStepTypesPlan(),
      safetyManifestFor({
        scenario: 'replication_lag_cascade',
        executionContexts: ['postgresql_read', 'postgresql_write', 'load_balancer'],
        maxRiskLevel: 'elevated',
      }),
    );

    expect(result.checks.filter((c) => !c.passed)).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

describe('explainPlan — when the AI cannot be used', () => {
  let originalApiKey: string | undefined;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    createMock.mockReset();
    resetNetworkProfile();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    resetNetworkProfile();
    if (originalApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('falls back without an API key and never reaches the SDK', async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const result = await explainPlan(makeAllStepTypesPlan(), DIAGNOSIS);

    expect(result.source).toBe('fallback');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('falls back when the network profile reports no internet', async () => {
    setNetworkProfile(offlineProfile());

    const result = await explainPlan(makeAllStepTypesPlan(), DIAGNOSIS);

    expect(result.source).toBe('fallback');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('falls back and reports the reason on an API failure', async () => {
    createMock.mockRejectedValue(new Error('overloaded_error'));

    const result = await explainPlan(makeAllStepTypesPlan(), DIAGNOSIS);

    expect(result.source).toBe('fallback');
    expect(errorSpy).toHaveBeenCalledWith(
      'AI plan explanation failed, using fallback:',
      'overloaded_error',
    );
  });

  it('logs a non-Error rejection as-is', async () => {
    const thrown: unknown = 'socket hang up';
    createMock.mockRejectedValue(thrown);

    const result = await explainPlan(makeAllStepTypesPlan(), DIAGNOSIS);

    expect(result.source).toBe('fallback');
    expect(errorSpy).toHaveBeenCalledWith(
      'AI plan explanation failed, using fallback:',
      'socket hang up',
    );
  });
});

describe('explainPlan — structural fallback content', () => {
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    createMock.mockReset();
    resetNetworkProfile();
  });

  afterEach(() => {
    resetNetworkProfile();
    if (originalApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('explains every step type, leaving none blank', async () => {
    const result = await explainPlan(makeAllStepTypesPlan(), DIAGNOSIS);

    expect(result.stepExplanations).toHaveLength(8);
    for (const se of result.stepExplanations) {
      expect(se.explanation.length).toBeGreaterThan(0);
    }

    const byId = Object.fromEntries(result.stepExplanations.map((s) => [s.stepId, s.explanation]));
    expect(byId['step-001']).toContain('Gather diagnostic data');
    expect(byId['step-002']).toContain('Replication recovery starting');
    expect(byId['step-003']).toContain('2 capture(s)');
    expect(byId['step-004']).toContain('elevated-risk');
    expect(byId['step-004']).toContain('pg-replica-52, read-pool');
    // The approval step's own presentation text, not a generic placeholder —
    // this is what an operator reads before deciding.
    expect(byId['step-005']).toContain('Rebuild replica 10.0.1.52 from a base backup?');
    expect(byId['step-006']).toContain('needs revision');
    expect(byId['step-007']).toContain('replica lag below 10s');
  });

  it('summarizes duration, rollback and scenario', async () => {
    const result = await explainPlan(makeAllStepTypesPlan(), DIAGNOSIS);

    expect(result.summary).toContain('replication_lag_cascade');
    expect(result.summary).toContain('PT15M');
    expect(result.summary).toContain('stepwise');
  });

  it('says "unknown scenario" rather than "null" when the diagnosis has none', async () => {
    const result = await explainPlan(makeAllStepTypesPlan(), { ...DIAGNOSIS, scenario: null });

    expect(result.summary).toContain('unknown scenario');
    expect(result.summary).not.toContain('null');
  });

  it('raises data loss as its own risk line when the plan carries any', async () => {
    const plan = makeAllStepTypesPlan({
      impact: {
        dataLossRisk: 'possible',
        estimatedUserImpact: 'Writes rejected during failover',
      },
    } as unknown as Partial<RecoveryPlan>);

    const result = await explainPlan(plan, DIAGNOSIS);

    expect(result.risks).toContain('Data loss risk: possible');
    expect(result.risks).toContain('1 step(s) at elevated risk or higher');
    expect(result.risks).toContain('User impact: Writes rejected during failover');
  });

  it('omits the data loss line when the plan risks none', async () => {
    const result = await explainPlan(makeAllStepTypesPlan(), DIAGNOSIS);

    expect(result.risks.some((r) => r.startsWith('Data loss risk'))).toBe(false);
  });
});

describe('explainPlan — tolerating a partially shaped AI reply', () => {
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    createMock.mockReset();
    resetNetworkProfile();
  });

  afterEach(() => {
    resetNetworkProfile();
    if (originalApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  /**
   * Parseable but incomplete: the reply is JSON, so `explainPlan` reports
   * `source: 'ai'` and the operator is told this is the model's explanation.
   * It therefore must not render `undefined` for the fields the model skipped —
   * it substitutes the plan's own summary and one row per real step.
   */
  it('substitutes the plan summary and a row per step when both are missing', async () => {
    createMock.mockResolvedValue({ content: [{ type: 'text', text: '{}' }] });

    const result = await explainPlan(makeAllStepTypesPlan(), DIAGNOSIS);

    expect(result.source).toBe('ai');
    expect(result.summary).toBe('Resync the lagging replica');
    expect(result.stepExplanations).toHaveLength(8);
    expect(result.stepExplanations.map((s) => s.stepId)).toEqual([
      'step-001',
      'step-002',
      'step-003',
      'step-004',
      'step-005',
      'step-006',
      'step-007',
      'step-008',
    ]);
    expect(result.risks).toEqual([]);
  });

  it('drops a stepExplanations value that is not an array', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: '{"summary":"s","stepExplanations":"nope","risks":"nope"}' }],
    });

    const result = await explainPlan(makeAllStepTypesPlan(), DIAGNOSIS);

    expect(result.stepExplanations).toHaveLength(8);
    expect(result.risks).toEqual([]);
  });

  it('fills in blanks inside individual step explanations', async () => {
    createMock.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: '{"summary":"s","stepExplanations":[{}],"risks":[1,true]}',
        },
      ],
    });

    const result = await explainPlan(makeAllStepTypesPlan(), DIAGNOSIS);

    expect(result.stepExplanations).toEqual([{ stepId: '', name: '', explanation: '' }]);
    // Risks are coerced to strings so the renderer never prints "[object Object]".
    expect(result.risks).toEqual(['1', 'true']);
  });

  it('sends the command type alone when a step has no operation', async () => {
    createMock.mockResolvedValue({ content: [{ type: 'text', text: '{"summary":"s"}' }] });

    await explainPlan(makeAllStepTypesPlan(), DIAGNOSIS);

    const [params] = createMock.mock.calls[0]!;
    const userMessage = String(params.messages[0].content);
    expect(userMessage).toContain('"command": "sql SELECT pg_terminate_backend(pid)"');
    // step-008 has no operation: the command reads as the bare type, with no
    // trailing space to make the prompt look like a truncated command.
    expect(userMessage).toContain('"command": "configuration_change"');
    expect(userMessage).not.toMatch(/"command": "\w+ "/);
  });
});
