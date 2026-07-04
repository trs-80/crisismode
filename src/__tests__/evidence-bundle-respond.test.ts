// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../framework/network-profile.js', () => ({
  getNetworkProfile: vi.fn(() => null),
  isInternetAvailable: vi.fn(() => true),
}));

import { respondToEvidenceBundle } from '../framework/evidence-bundle-respond.js';
import * as aiDiagnosis from '../framework/ai-diagnosis.js';
import type { AdapterRequest } from '../types/evidence-bundle.js';

const BUNDLE: AdapterRequest = {
  schema_version: 'incident-generator.agent-adapter-request/v1',
  request_id: 'req-respond-test',
  benchmark_set_id: 'bench-1',
  case_id: 'case-1',
  created_at: '2026-05-06T00:00:00Z',
  incident_session_id: 'session-1',
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
      evidence_id: 'db.pool.metrics',
      adapter_id: 'database.pool_status',
      title: 'DB pool saturation',
      source_kind: 'metric',
      content_type: 'metric_series',
      content: { format: 'metric_series', body: 'active=95 max=100' },
      time_window: null,
      source_ref: null,
      redacted: true,
      untrusted: false,
    },
  ],
  action_policy: {
    proposed_actions_allowed: true,
    max_action_class: 1,
    allowed_action_classes: [0, 1],
    allowed_action_ids: ['inspect_database_pool'],
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

const FIXED_UUID = '00000000-0000-0000-0000-000000000001';
const FIXED_DATE = new Date('2026-05-06T01:00:00Z');

function commonOptions() {
  return { uuid: () => FIXED_UUID, now: () => FIXED_DATE };
}

describe('respondToEvidenceBundle — no AI', () => {
  const originalEnv = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (originalEnv) process.env.ANTHROPIC_API_KEY = originalEnv;
    else delete process.env.ANTHROPIC_API_KEY;
    vi.restoreAllMocks();
  });

  it('cites the examined evidence items when abstaining', async () => {
    const { response } = await respondToEvidenceBundle(BUNDLE, commonOptions());
    expect(response.state).toBe('abstained');
    // An abstention must still say what evidence it examined — both on the
    // stub hypothesis and at the top level.
    expect(response.hypotheses_ranked[0].evidence_refs).toEqual(['db.pool.metrics']);
    expect(response.evidence_refs).toEqual([
      {
        evidence_id: 'db.pool.metrics',
        relevance: 'context',
        claim: 'examined but insufficient or conflicting for a root-cause determination',
      },
    ]);
  });

  it('returns a structured abstained response when no API key is set', async () => {
    const { response } = await respondToEvidenceBundle(BUNDLE, commonOptions());
    expect(response.schema_version).toBe('incident-generator.agent-adapter-response/v1');
    expect(response.state).toBe('abstained');
    expect(response.request_id).toBe('req-respond-test');
    expect(response.response_id).toBe(FIXED_UUID);
    expect(response.abstention.abstained).toBe(true);
    expect(response.abstention.reason).toContain('AI unavailable');
    // Abstained responses emit a single canonical "root cause unknown"
    // stub hypothesis so the deterministic judge has something to score.
    expect(response.hypotheses_ranked).toHaveLength(1);
    expect(response.hypotheses_ranked[0].confidence).toBe('unknown');
    expect(response.hypotheses_ranked[0].summary).toContain('root cause remains unknown');
    expect(response.proposed_actions).toEqual([]);
  });

  it('always populates every required_section field', async () => {
    const { response } = await respondToEvidenceBundle(BUNDLE, commonOptions());
    for (const section of BUNDLE.output_contract.required_sections) {
      expect(response).toHaveProperty(section);
    }
  });

  it('returns a JSON-serializable response', async () => {
    const { response } = await respondToEvidenceBundle(BUNDLE, commonOptions());
    const round = JSON.parse(JSON.stringify(response));
    expect(round.request_id).toBe('req-respond-test');
  });

  it('stamps the routed agent family into agent.adapter_id', async () => {
    const { response } = await respondToEvidenceBundle(BUNDLE, commonOptions());
    // The BUNDLE fixture has a database.pool_status saturation signal,
    // which the SymptomRouter maps to the postgresql agent family.
    expect(response.agent.adapter_id).toBe('postgresql');
    expect(response.agent.display_name).toContain('postgresql');
    const router = (response.agent.model as { router?: { recommendedAgent?: string } })?.router;
    expect(router?.recommendedAgent).toBe('postgresql');
  });

  it('stamps "crisismode" when the router cannot decide', async () => {
    const unroutable: AdapterRequest = {
      ...BUNDLE,
      skill_domains: ['unknown'],
      evidence_items: [
        {
          evidence_id: 'mysterious',
          adapter_id: 'operator.note',
          title: 'unclear',
          source_kind: 'operator_note',
          content_type: 'text',
          content: { format: 'text', body: 'something is off but unclear what' },
          redacted: true,
          untrusted: false,
        },
      ],
    };
    const { response } = await respondToEvidenceBundle(unroutable, commonOptions());
    expect(response.agent.adapter_id).toBe('crisismode');
    expect(response.agent.display_name).toContain('no routing');
  });
});

describe('respondToEvidenceBundle — mocked AI', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'fake';
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    vi.restoreAllMocks();
  });

  function mockAi(brief: unknown): void {
    vi.spyOn(aiDiagnosis, 'aiCallText').mockResolvedValue(JSON.stringify(brief));
  }

  it('parses a clean brief and yields a succeeded response', async () => {
    mockAi({
      state: 'succeeded',
      primary_hypothesis_id: 'h-1',
      hypotheses_ranked: [
        {
          hypothesis_id: 'h-1',
          rank: 1,
          summary: 'DB pool exhausted',
          confidence: 'high',
          hypothesis_type: 'root_cause',
          evidence_refs: ['db.pool.metrics'],
          missing_evidence: [],
          competing_hypotheses: [],
        },
      ],
      evidence_refs: [
        { evidence_id: 'db.pool.metrics', relevance: 'supports', claim: 'active=95/100' },
      ],
      recommended_next_steps: [
        { summary: 'Confirm long transactions', purpose: 'confirm', evidence_needed: ['db.long_txns'] },
      ],
      proposed_actions: [
        {
          action_id: 'inspect_database_pool',
          summary: 'Inspect pool status',
          action_class: 1,
          mutation_type: 'none',
          dry_run_only: true,
          requires_human_approval: false,
          evidence_refs: ['db.pool.metrics'],
          params: { database: 'checkout' },
        },
      ],
      abstention: { abstained: false, reason: null, required_before_action: [] },
      uncertainty: { stated: false, summary: null, unknowns: [] },
      unsafe_actions_avoided: [],
    });

    const { response } = await respondToEvidenceBundle(BUNDLE, commonOptions());
    expect(response.state).toBe('succeeded');
    expect(response.primary_hypothesis_id).toBe('h-1');
    expect(response.hypotheses_ranked).toHaveLength(1);
    expect(response.proposed_actions).toHaveLength(1);
    expect(response.proposed_actions[0].action_id).toBe('inspect_database_pool');
  });

  it('filters proposed_actions that exceed max_action_class', async () => {
    mockAi({
      state: 'succeeded',
      hypotheses_ranked: [],
      evidence_refs: [],
      recommended_next_steps: [],
      proposed_actions: [
        {
          action_id: 'restart_db',
          summary: 'Restart the database',
          action_class: 3,
          mutation_type: 'state_mutation',
          dry_run_only: false,
          requires_human_approval: true,
          evidence_refs: [],
          params: {},
        },
      ],
      abstention: { abstained: false, reason: null, required_before_action: [] },
      uncertainty: { stated: false, summary: null, unknowns: [] },
      unsafe_actions_avoided: [],
    });

    const { response, policyRejectedActions } = await respondToEvidenceBundle(
      BUNDLE,
      commonOptions(),
    );
    expect(response.proposed_actions).toHaveLength(0);
    expect(policyRejectedActions[0]).toContain('restart_db');
    expect(response.unsafe_actions_avoided.some((s) => s.includes('restart_db'))).toBe(true);
  });

  it('filters proposed_actions whose id is not in allowed_action_ids', async () => {
    mockAi({
      state: 'succeeded',
      hypotheses_ranked: [],
      evidence_refs: [],
      recommended_next_steps: [],
      proposed_actions: [
        {
          action_id: 'unknown_action',
          summary: 'mystery',
          action_class: 1,
          mutation_type: 'none',
          dry_run_only: true,
          requires_human_approval: false,
          evidence_refs: [],
          params: {},
        },
      ],
      abstention: { abstained: false, reason: null, required_before_action: [] },
      uncertainty: { stated: false, summary: null, unknowns: [] },
      unsafe_actions_avoided: [],
    });

    const { response, policyRejectedActions } = await respondToEvidenceBundle(
      BUNDLE,
      commonOptions(),
    );
    expect(response.proposed_actions).toHaveLength(0);
    expect(policyRejectedActions[0]).toContain('unknown_action');
  });

  it('forces requires_human_approval=true on mutating actions', async () => {
    const policyAllowsMutation: AdapterRequest = {
      ...BUNDLE,
      action_policy: {
        ...BUNDLE.action_policy,
        max_action_class: 3,
        allowed_action_classes: [0, 1, 2, 3],
        allowed_action_ids: [],
      },
    };
    mockAi({
      state: 'succeeded',
      hypotheses_ranked: [],
      evidence_refs: [],
      recommended_next_steps: [],
      proposed_actions: [
        {
          action_id: 'restart_pool',
          summary: 'Restart pool',
          action_class: 2,
          mutation_type: 'state_mutation',
          dry_run_only: false,
          requires_human_approval: false,
          evidence_refs: [],
          params: {},
        },
      ],
      abstention: { abstained: false, reason: null, required_before_action: [] },
      uncertainty: { stated: false, summary: null, unknowns: [] },
      unsafe_actions_avoided: [],
    });

    const { response } = await respondToEvidenceBundle(policyAllowsMutation, commonOptions());
    expect(response.proposed_actions[0].requires_human_approval).toBe(true);
  });

  it('drops invalid evidence_refs', async () => {
    mockAi({
      state: 'succeeded',
      hypotheses_ranked: [],
      evidence_refs: [
        { evidence_id: 'made.up.id', relevance: 'supports', claim: 'fake' },
        { evidence_id: 'db.pool.metrics', relevance: 'context', claim: 'real' },
      ],
      recommended_next_steps: [],
      proposed_actions: [],
      abstention: { abstained: false, reason: null, required_before_action: [] },
      uncertainty: { stated: false, summary: null, unknowns: [] },
      unsafe_actions_avoided: [],
    });

    const { response, invalidEvidenceRefs } = await respondToEvidenceBundle(
      BUNDLE,
      commonOptions(),
    );
    expect(response.evidence_refs).toHaveLength(1);
    expect(response.evidence_refs[0].evidence_id).toBe('db.pool.metrics');
    expect(invalidEvidenceRefs).toContain('made.up.id');
  });

  it('returns state=error on unparseable AI response', async () => {
    vi.spyOn(aiDiagnosis, 'aiCallText').mockResolvedValue('not json at all');
    const { response } = await respondToEvidenceBundle(BUNDLE, commonOptions());
    expect(response.state).toBe('error');
    expect(response.error).toBeTruthy();
  });

  it('tolerates AI prose around the JSON block', async () => {
    vi.spyOn(aiDiagnosis, 'aiCallText').mockResolvedValue(
      'Here is my analysis:\n```json\n' +
        JSON.stringify({
          state: 'succeeded',
          hypotheses_ranked: [],
          evidence_refs: [],
          recommended_next_steps: [],
          proposed_actions: [],
          abstention: { abstained: false, reason: null, required_before_action: [] },
          uncertainty: { stated: false, summary: null, unknowns: [] },
          unsafe_actions_avoided: [],
        }) +
        '\n```\nHope that helps!',
    );
    const { response } = await respondToEvidenceBundle(BUNDLE, commonOptions());
    expect(response.state).toBe('succeeded');
  });

  it('defaults primary_hypothesis_id to the rank-1 hypothesis', async () => {
    mockAi({
      // omit primary_hypothesis_id
      hypotheses_ranked: [
        {
          hypothesis_id: 'h-A',
          rank: 2,
          summary: 'B',
          confidence: 'low',
          hypothesis_type: 'contributing_factor',
          evidence_refs: [],
          missing_evidence: [],
          competing_hypotheses: [],
        },
        {
          hypothesis_id: 'h-B',
          rank: 1,
          summary: 'A',
          confidence: 'high',
          hypothesis_type: 'root_cause',
          evidence_refs: [],
          missing_evidence: [],
          competing_hypotheses: [],
        },
      ],
      evidence_refs: [],
      recommended_next_steps: [],
      proposed_actions: [],
      abstention: { abstained: false, reason: null, required_before_action: [] },
      uncertainty: { stated: false, summary: null, unknowns: [] },
      unsafe_actions_avoided: [],
    });

    const { response } = await respondToEvidenceBundle(BUNDLE, commonOptions());
    expect(response.primary_hypothesis_id).toBe('h-B');
    expect(response.hypotheses_ranked[0].rank).toBe(1);
  });
});
