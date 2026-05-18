// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, beforeEach } from 'vitest';

import { createActionPolicyHook } from '../framework/hooks/action-policy.js';
import { HookRegistry } from '../framework/hooks/registry.js';
import { resetBuiltInActionTemplates } from '../framework/action-template-registry.js';
import { adapterResponseToPlan } from '../framework/bundle-to-plan.js';
import type { ActionPolicy, AdapterRequest, AdapterResponse } from '../types/evidence-bundle.js';
import type { RecoveryPlan } from '../types/recovery-plan.js';

const BUNDLE: AdapterRequest = {
  schema_version: 'incident-generator.agent-adapter-request/v1',
  request_id: 'req-hook',
  benchmark_set_id: 'bench',
  case_id: 'case',
  created_at: '2026-05-17T00:00:00Z',
  incident_session_id: 'session-hook',
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
      evidence_id: 'ev-1',
      adapter_id: 'database.pool_status',
      title: 'Pool',
      source_kind: 'metric',
      content_type: 'metric_series',
      content: { format: 'metric_series', body: 'active=95 max=100' },
      redacted: true,
      untrusted: false,
    },
  ],
  action_policy: {
    proposed_actions_allowed: true,
    max_action_class: 1,
    allowed_action_classes: [0, 1],
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

function makeResponse(actions: AdapterResponse['proposed_actions']): AdapterResponse {
  return {
    schema_version: 'incident-generator.agent-adapter-response/v1',
    response_id: 'resp',
    request_id: 'req-hook',
    created_at: '2026-05-17T00:01:00Z',
    agent: {
      adapter_id: 'crisismode',
      display_name: 'CrisisMode',
      adapter_version: null,
      execution_mode: 'real',
      model: null,
    },
    state: 'succeeded',
    primary_hypothesis_id: null,
    hypotheses_ranked: [],
    evidence_refs: [],
    recommended_next_steps: [],
    proposed_actions: actions,
    abstention: { abstained: false, reason: null, required_before_action: [] },
    uncertainty: { stated: false, summary: null, unknowns: [] },
    unsafe_actions_avoided: [],
    duration_ms: 0,
    artifact_refs: [],
    error: null,
  };
}

const READ_ACTION = {
  action_id: 'inspect_database_pool',
  summary: 'Inspect',
  action_class: 0 as const,
  mutation_type: 'none' as const,
  dry_run_only: true,
  requires_human_approval: false,
  evidence_refs: ['ev-1'],
  params: { target: 'pg-primary' },
};

const MUTATING_ACTION = {
  action_id: 'capture_state_snapshot',
  summary: 'Snapshot',
  action_class: 1 as const,
  mutation_type: 'external_side_effect' as const,
  dry_run_only: true,
  requires_human_approval: true,
  evidence_refs: ['ev-1'],
  params: { target: 'snap-store' },
};

const PLAN_OPTS = {
  uuid: () => '00000000-0000-0000-0000-000000000bbb',
  now: () => new Date('2026-05-17T02:00:00Z'),
};

describe('createActionPolicyHook', () => {
  beforeEach(() => {
    resetBuiltInActionTemplates();
  });

  it('does NOT abort a plan that satisfies the policy', async () => {
    const { plan, stepIdToActionId } = adapterResponseToPlan(
      BUNDLE,
      makeResponse([READ_ACTION]),
      PLAN_OPTS,
    );
    const hook = createActionPolicyHook(BUNDLE.action_policy, stepIdToActionId);
    const registry = new HookRegistry();
    registry.register(hook);
    const result = await registry.fire('plan:validate', { plan });
    expect(result.abort).not.toBe(true);
  });

  it('aborts when a step exceeds max_action_class', async () => {
    const { plan, stepIdToActionId } = adapterResponseToPlan(
      BUNDLE,
      makeResponse([MUTATING_ACTION]),
      PLAN_OPTS,
    );
    const policy: ActionPolicy = {
      ...BUNDLE.action_policy,
      max_action_class: 0,
      allowed_action_classes: [0],
    };
    const hook = createActionPolicyHook(policy, stepIdToActionId);
    const registry = new HookRegistry();
    registry.register(hook);
    const result = await registry.fire('plan:validate', { plan });
    expect(result.abort).toBe(true);
    expect(result.reason).toContain('action_class 1 > max 0');
  });

  it('aborts when an action_id is not in allowed_action_ids', async () => {
    const { plan, stepIdToActionId } = adapterResponseToPlan(
      BUNDLE,
      makeResponse([READ_ACTION]),
      PLAN_OPTS,
    );
    const policy: ActionPolicy = {
      ...BUNDLE.action_policy,
      allowed_action_ids: ['inspect_service_logs'], // only logs allowed
    };
    const hook = createActionPolicyHook(policy, stepIdToActionId);
    const registry = new HookRegistry();
    registry.register(hook);
    const result = await registry.fire('plan:validate', { plan });
    expect(result.abort).toBe(true);
    expect(result.reason).toContain('not in allowed_action_ids whitelist');
  });

  it('aborts when proposed_actions_allowed=false with mutating step', async () => {
    const { plan, stepIdToActionId } = adapterResponseToPlan(
      BUNDLE,
      makeResponse([MUTATING_ACTION]),
      PLAN_OPTS,
    );
    const policy: ActionPolicy = {
      ...BUNDLE.action_policy,
      proposed_actions_allowed: false,
    };
    const hook = createActionPolicyHook(policy, stepIdToActionId);
    const registry = new HookRegistry();
    registry.register(hook);
    const result = await registry.fire('plan:validate', { plan });
    expect(result.abort).toBe(true);
    expect(result.reason).toContain('mutating system_action when policy.proposed_actions_allowed=false');
  });

  it('aborts when a mutating step is missing a preceding human_approval', async () => {
    // Synthesize a plan that bypasses the translator's auto-injection.
    const { plan, stepIdToActionId } = adapterResponseToPlan(
      BUNDLE,
      makeResponse([MUTATING_ACTION]),
      PLAN_OPTS,
    );
    // Strip the human_approval step (which our translator injects)
    const stripped: RecoveryPlan = {
      ...plan,
      steps: plan.steps.filter((s) => s.type !== 'human_approval'),
    };
    const hook = createActionPolicyHook(BUNDLE.action_policy, stepIdToActionId);
    const registry = new HookRegistry();
    registry.register(hook);
    const result = await registry.fire('plan:validate', { plan: stripped });
    expect(result.abort).toBe(true);
    expect(result.reason).toContain('lacks a preceding human_approval gate');
  });

  it('does NOT require approval gate when policy.requires_human_approval_for_mutation=false (hypothetical)', async () => {
    // The schema pins this to true, but the hook should still respect
    // the value programmatically.
    const { plan, stepIdToActionId } = adapterResponseToPlan(
      BUNDLE,
      makeResponse([MUTATING_ACTION]),
      PLAN_OPTS,
    );
    const stripped: RecoveryPlan = {
      ...plan,
      steps: plan.steps.filter((s) => s.type !== 'human_approval'),
    };
    const relaxed = {
      ...BUNDLE.action_policy,
      requires_human_approval_for_mutation: false as unknown as true,
    };
    const hook = createActionPolicyHook(relaxed, stepIdToActionId);
    const registry = new HookRegistry();
    registry.register(hook);
    const result = await registry.fire('plan:validate', { plan: stripped });
    expect(result.abort).not.toBe(true);
  });

  it('abstains (no abort) on plans that did not come from a bundle', async () => {
    // Empty stepIdToActionId means "I don't recognize any step in this plan".
    const { plan } = adapterResponseToPlan(
      BUNDLE,
      makeResponse([READ_ACTION]),
      PLAN_OPTS,
    );
    const hook = createActionPolicyHook(BUNDLE.action_policy, {}); // empty map
    const registry = new HookRegistry();
    registry.register(hook);
    const result = await registry.fire('plan:validate', { plan });
    expect(result.abort).not.toBe(true);
  });

  it('does nothing when there is no plan in context', async () => {
    const hook = createActionPolicyHook(BUNDLE.action_policy, {});
    const registry = new HookRegistry();
    registry.register(hook);
    const result = await registry.fire('plan:validate', {});
    expect(result.abort).not.toBe(true);
  });
});
