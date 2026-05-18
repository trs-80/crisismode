// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Phase 3 integration tests — bundle → plan for class 2/3 mutating
 * actions. Verifies that the generated plan satisfies the existing
 * CrisisMode plan validator's safety rules without further patching.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { adapterResponseToPlan } from '../framework/bundle-to-plan.js';
import { resetBuiltInActionTemplates } from '../framework/action-template-registry.js';
import type { AdapterRequest, AdapterResponse } from '../types/evidence-bundle.js';

const BUNDLE: AdapterRequest = {
  schema_version: 'incident-generator.agent-adapter-request/v1',
  request_id: 'req-mut-1',
  benchmark_set_id: 'bench',
  case_id: 'pg-replication-cascade',
  created_at: '2026-05-17T00:00:00Z',
  incident_session_id: 'session-mut-1',
  collection_mode: 'fixture',
  input_mode: 'redacted_evidence_bundle',
  skill_domains: ['database'],
  visibility: {
    internal_evidence_roles_visible: false,
    expected_hypotheses_visible: false,
    forbidden_hypotheses_visible: false,
    redaction_required: true,
  },
  evidence_items: [
    {
      evidence_id: 'pg.replication.lag',
      adapter_id: 'database.replication_status',
      title: 'Replication lag',
      source_kind: 'metric',
      content_type: 'metric_series',
      content: { format: 'metric_series', body: 'replica1 lag=636s' },
      redacted: true,
      untrusted: false,
    },
  ],
  action_policy: {
    proposed_actions_allowed: true,
    max_action_class: 3,
    allowed_action_classes: [0, 1, 2, 3],
    allowed_action_ids: [],
    requires_human_approval_for_mutation: true,
  },
  output_contract: {
    response_schema: 'incident-generator.agent-adapter-response/v1',
    required_sections: [
      'hypotheses_ranked',
      'evidence_refs',
      'recommended_next_steps',
      'proposed_actions',
      'abstention',
      'uncertainty',
      'unsafe_actions_avoided',
    ],
  },
};

function response(
  actionId: string,
  actionClass: 0 | 1 | 2 | 3,
  mutation: 'none' | 'external_side_effect' | 'state_mutation',
): AdapterResponse {
  return {
    schema_version: 'incident-generator.agent-adapter-response/v1',
    response_id: 'resp',
    request_id: 'req-mut-1',
    created_at: '2026-05-17T01:00:00Z',
    agent: {
      adapter_id: 'crisismode',
      display_name: 'CrisisMode',
      adapter_version: null,
      execution_mode: 'real',
      model: null,
    },
    state: 'succeeded',
    primary_hypothesis_id: 'h-1',
    hypotheses_ranked: [
      {
        hypothesis_id: 'h-1',
        rank: 1,
        summary: 'Replication lag cascade',
        confidence: 'high',
        hypothesis_type: 'root_cause',
        evidence_refs: ['pg.replication.lag'],
        missing_evidence: [],
        competing_hypotheses: [],
      },
    ],
    evidence_refs: [
      { evidence_id: 'pg.replication.lag', relevance: 'supports', claim: 'lag=636s' },
    ],
    recommended_next_steps: [],
    proposed_actions: [
      {
        action_id: actionId,
        summary: 'Recover',
        action_class: actionClass,
        mutation_type: mutation,
        dry_run_only: false,
        requires_human_approval: true,
        evidence_refs: ['pg.replication.lag'],
        params: { target: 'pg-primary' },
      },
    ],
    abstention: { abstained: false, reason: null, required_before_action: [] },
    uncertainty: { stated: false, summary: null, unknowns: [] },
    unsafe_actions_avoided: [],
    duration_ms: 0,
    artifact_refs: [],
    error: null,
  };
}

const OPTS = {
  uuid: () => '00000000-0000-0000-0000-000000000ccc',
  now: () => new Date('2026-05-17T02:00:00Z'),
};

describe('adapterResponseToPlan — class 2/3 mutating actions', () => {
  beforeEach(() => {
    resetBuiltInActionTemplates();
  });

  it('disconnect_replica produces an elevated SystemActionStep with statePreservation, success criteria, and rollback', () => {
    const { plan, rejected } = adapterResponseToPlan(
      BUNDLE,
      response('disconnect_replica', 2, 'state_mutation'),
      OPTS,
    );
    expect(rejected).toEqual([]);
    const sysStep = plan.steps.find((s) => s.type === 'system_action');
    expect(sysStep).toBeDefined();
    if (!sysStep || sysStep.type !== 'system_action') return;
    expect(sysStep.riskLevel).toBe('elevated');
    expect(sysStep.requiredCapabilities).toEqual(['db.replica.disconnect']);
    expect(sysStep.statePreservation.before.length).toBeGreaterThan(0);
    expect(sysStep.statePreservation.before[0].name).toBe('replication_status_before');
    expect(sysStep.successCriteria.description).toContain('WAL sender');
    expect(sysStep.rollback?.type).toBe('manual');
    expect(sysStep.rollback?.description).toContain('replica rebuild');
  });

  it('rollback_deploy produces a high-risk SystemActionStep', () => {
    const { plan } = adapterResponseToPlan(
      BUNDLE,
      response('rollback_deploy', 3, 'state_mutation'),
      OPTS,
    );
    const sysStep = plan.steps.find((s) => s.type === 'system_action');
    if (!sysStep || sysStep.type !== 'system_action') return;
    expect(sysStep.riskLevel).toBe('high');
    expect(sysStep.requiredCapabilities).toEqual(['deploy.rollback']);
  });

  it('drain_node carries a kubernetes_api rollback command', () => {
    const { plan } = adapterResponseToPlan(
      BUNDLE,
      response('drain_node', 2, 'state_mutation'),
      OPTS,
    );
    const sysStep = plan.steps.find((s) => s.type === 'system_action');
    if (!sysStep || sysStep.type !== 'system_action') return;
    expect(sysStep.rollback?.type).toBe('command');
    expect(sysStep.rollback?.command?.type).toBe('kubernetes_api');
  });

  it('emits human_notification + human_approval + system_action for any mutating plan', () => {
    const { plan } = adapterResponseToPlan(
      BUNDLE,
      response('evict_pod', 2, 'state_mutation'),
      OPTS,
    );
    const types = plan.steps.map((s) => s.type);
    expect(types).toContain('human_notification');
    expect(types).toContain('human_approval');
    expect(types).toContain('system_action');
    // notification must precede approval which must precede mutation
    const notifIdx = types.indexOf('human_notification');
    const approvalIdx = types.indexOf('human_approval');
    const sysIdx = types.indexOf('system_action');
    expect(notifIdx).toBeLessThan(approvalIdx);
    expect(approvalIdx).toBeLessThan(sysIdx);
  });

  it('rollbackStrategy references per-step directives when present', () => {
    const { plan } = adapterResponseToPlan(
      BUNDLE,
      response('disconnect_replica', 2, 'state_mutation'),
      OPTS,
    );
    expect(plan.rollbackStrategy.type).toBe('stepwise');
    expect(plan.rollbackStrategy.description).toContain('rollback directive');
  });

  it('reset_consumer_group is elevated and carries lag captures', () => {
    const { plan } = adapterResponseToPlan(
      BUNDLE,
      response('reset_consumer_group', 2, 'state_mutation'),
      OPTS,
    );
    const sysStep = plan.steps.find((s) => s.type === 'system_action');
    if (!sysStep || sysStep.type !== 'system_action') return;
    expect(sysStep.riskLevel).toBe('elevated');
    expect(
      sysStep.statePreservation.before.some((c) => c.name === 'consumer_group_lag_before'),
    ).toBe(true);
  });

  it('class 0 read plans do NOT get a notification step injected', () => {
    const { plan } = adapterResponseToPlan(
      BUNDLE,
      response('inspect_database_pool', 0, 'none'),
      OPTS,
    );
    const types = plan.steps.map((s) => s.type);
    expect(types).not.toContain('human_notification');
    expect(types).toEqual(['diagnosis_action']);
  });
});

describe('adapterResponseToPlan — plan passes existing validator checks', () => {
  beforeEach(() => {
    resetBuiltInActionTemplates();
  });

  it('disconnect_replica plan satisfies state-preservation and rollback rules', async () => {
    const { plan } = adapterResponseToPlan(
      BUNDLE,
      response('disconnect_replica', 2, 'state_mutation'),
      OPTS,
    );
    const { validatePlan } = await import('../framework/validator.js');
    const manifest = {
      apiVersion: 'v0.2.1',
      kind: 'AgentManifest',
      metadata: {
        name: 'bundle-adapter',
        version: '0.1.0',
        description: 'Bundle adapter',
      },
      spec: {
        targetSystems: [{ technology: 'postgresql', components: ['primary'] }],
        triggerConditions: [],
        failureScenarios: [plan.metadata.scenario],
        executionContexts: [
          { name: 'database_write', requires: ['db.replica.disconnect'] },
          { name: 'database_read', requires: [] },
          { name: 'kubernetes_write', requires: [] },
          { name: 'kubernetes_read', requires: [] },
          { name: 'audit_read', requires: [] },
          { name: 'state_capture', requires: [] },
        ],
        riskProfile: {
          maxRiskLevel: 'high',
          dataLossPossible: true,
          serviceDisruptionPossible: true,
        },
        requiredCapabilities: ['db.replica.disconnect'],
      },
    } as unknown as import('../types/manifest.js').AgentManifest;
    const result = validatePlan(plan, manifest);
    const stateCheck = result.checks.find((c) => c.name.includes('State preservation'));
    const notifCheck = result.checks.find((c) => c.name.includes('Human notification'));
    const rollbackCheck = result.checks.find((c) => c.name.includes('Rollback strategy'));
    expect(stateCheck?.passed).toBe(true);
    expect(notifCheck?.passed).toBe(true);
    expect(rollbackCheck?.passed).toBe(true);
  });
});
