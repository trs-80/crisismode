// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  buildPromptFromBundle,
  ingestEvidenceBundle,
  validateAdapterRequest,
} from '../framework/evidence-bundle-ingest.js';
import type { AdapterRequest } from '../types/evidence-bundle.js';

/**
 * Bundle derived from sre-incident-agent-skills'
 * harness/agent-adapter-abstention-example.json — a low-signal
 * handoff where the expected behavior is explicit uncertainty.
 */
const ABSTENTION_BUNDLE: AdapterRequest = {
  schema_version: 'incident-generator.agent-adapter-request/v1',
  request_id: 'req-test-abstention',
  benchmark_set_id: 'external-agent-adapter-smoke-20260506',
  case_id: 'missing-evidence-abstention',
  created_at: '2026-05-06T00:00:00Z',
  incident_session_id: '20260506-fixture-missing-evidence-abstention',
  collection_mode: 'fixture',
  input_mode: 'redacted_evidence_bundle',
  skill_domains: ['service', 'database'],
  visibility: {
    internal_evidence_roles_visible: false,
    expected_hypotheses_visible: false,
    forbidden_hypotheses_visible: false,
    redaction_required: true,
  },
  evidence_items: [
    {
      evidence_id: 'service.checkout_low_signal',
      adapter_id: 'service.logs',
      title: 'Checkout low-signal errors',
      source_kind: 'log',
      content_type: 'log_excerpt',
      content: {
        format: 'log_excerpt',
        body: 'checkout-api returned intermittent 503s, but the sample has no database pool metric window and no deployment diff.',
        redaction_summary: 'request ids removed',
      },
      time_window: { start: '2026-05-06T00:00:00Z', end: '2026-05-06T00:04:00Z' },
      source_ref: 'docs/incident-generator/benchmark/missing-evidence-red-herring-combos.md',
      redacted: true,
      untrusted: false,
      metadata: { namespace: 'checkout', sample_count: 4 },
    },
    {
      evidence_id: 'operator.missing_database_pool',
      adapter_id: 'operator.note',
      title: 'Missing database pool evidence',
      source_kind: 'operator_note',
      content_type: 'text',
      content: {
        format: 'text',
        body: 'A database issue is suspected, but the pool evidence adapter did not return data for this window.',
        redaction_summary: 'operator name removed',
      },
      time_window: null,
      source_ref: 'docs/incident-generator/benchmark/missing-evidence-red-herring-combos.md',
      redacted: true,
      untrusted: false,
      metadata: { missing_adapter: 'database.pool_status' },
    },
  ],
  action_policy: {
    proposed_actions_allowed: true,
    max_action_class: 1,
    allowed_action_classes: [0, 1],
    allowed_action_ids: ['inspect_service_logs', 'inspect_database_pool'],
    requires_human_approval_for_mutation: true,
  },
  output_contract: {
    response_schema: 'incident-generator.agent-adapter-response/v1',
    schema_ref: 'schemas/incident-generator-agent-adapter.schema.json#/$defs/adapter_response',
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

describe('validateAdapterRequest', () => {
  it('accepts the abstention-example bundle', () => {
    const result = validateAdapterRequest(ABSTENTION_BUNDLE);
    expect(result.request_id).toBe('req-test-abstention');
    expect(result.evidence_items).toHaveLength(2);
  });

  it('rejects wrong schema_version', () => {
    const bad = { ...ABSTENTION_BUNDLE, schema_version: 'something-else/v1' };
    expect(() => validateAdapterRequest(bad)).toThrow(/Unsupported schema_version/);
  });

  it('rejects wrong input_mode', () => {
    const bad = { ...ABSTENTION_BUNDLE, input_mode: 'raw_logs' };
    expect(() => validateAdapterRequest(bad)).toThrow(/Unsupported input_mode/);
  });

  it('rejects empty evidence_items', () => {
    const bad = { ...ABSTENTION_BUNDLE, evidence_items: [] };
    expect(() => validateAdapterRequest(bad)).toThrow(/evidence_items must be a non-empty array/);
  });

  it('rejects evidence_item missing required field', () => {
    const bad = JSON.parse(JSON.stringify(ABSTENTION_BUNDLE));
    delete bad.evidence_items[0].adapter_id;
    expect(() => validateAdapterRequest(bad)).toThrow(/evidence_items\[0\]\.adapter_id is required/);
  });

  it('rejects evidence_item missing content.body', () => {
    const bad = JSON.parse(JSON.stringify(ABSTENTION_BUNDLE));
    bad.evidence_items[0].content.body = '';
    expect(() => validateAdapterRequest(bad)).toThrow(/content\.body is required/);
  });

  it('rejects non-object input', () => {
    expect(() => validateAdapterRequest(null)).toThrow();
    expect(() => validateAdapterRequest('string')).toThrow();
  });
});

describe('buildPromptFromBundle', () => {
  it('cites every evidence item by id', () => {
    const { userMessage, citedEvidenceIds } = buildPromptFromBundle(ABSTENTION_BUNDLE);
    expect(citedEvidenceIds).toEqual([
      'service.checkout_low_signal',
      'operator.missing_database_pool',
    ]);
    expect(userMessage).toContain('[service.checkout_low_signal]');
    expect(userMessage).toContain('[operator.missing_database_pool]');
  });

  it('includes the bundle session id and case id', () => {
    const { userMessage } = buildPromptFromBundle(ABSTENTION_BUNDLE);
    expect(userMessage).toContain('20260506-fixture-missing-evidence-abstention');
    expect(userMessage).toContain('missing-evidence-abstention');
  });

  it('surfaces the action policy in the prompt', () => {
    const { userMessage } = buildPromptFromBundle(ABSTENTION_BUNDLE);
    expect(userMessage).toContain('Max action class: 1');
    expect(userMessage).toContain('inspect_service_logs');
  });

  it('flags untrusted evidence as a warning', () => {
    const bundle = JSON.parse(JSON.stringify(ABSTENTION_BUNDLE));
    bundle.evidence_items[0].untrusted = true;
    const { warnings, userMessage } = buildPromptFromBundle(bundle);
    expect(warnings.some((w) => w.code === 'untrusted_evidence')).toBe(true);
    expect(userMessage).toContain('UNTRUSTED');
  });

  it('flags unredacted evidence as a warning', () => {
    const bundle = JSON.parse(JSON.stringify(ABSTENTION_BUNDLE));
    bundle.evidence_items[1].redacted = false;
    const { warnings, userMessage } = buildPromptFromBundle(bundle);
    expect(warnings.some((w) => w.code === 'unredacted_evidence')).toBe(true);
    expect(userMessage).toContain('NOT REDACTED');
  });

  it('flags read-only action policies', () => {
    const bundle = JSON.parse(JSON.stringify(ABSTENTION_BUNDLE));
    bundle.action_policy.proposed_actions_allowed = false;
    bundle.action_policy.max_action_class = 0;
    bundle.action_policy.allowed_action_classes = [0];
    const { warnings } = buildPromptFromBundle(bundle);
    expect(warnings.some((w) => w.code === 'tight_action_policy')).toBe(true);
  });

  it('renders time_window when present', () => {
    const { userMessage } = buildPromptFromBundle(ABSTENTION_BUNDLE);
    expect(userMessage).toContain('time_window: 2026-05-06T00:00:00Z → 2026-05-06T00:04:00Z');
  });
});

describe('ingestEvidenceBundle', () => {
  const originalEnv = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (originalEnv) {
      process.env.ANTHROPIC_API_KEY = originalEnv;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('returns null diagnosis with no_ai_available warning when no API key', async () => {
    const result = await ingestEvidenceBundle(ABSTENTION_BUNDLE);
    expect(result.diagnosis).toBeNull();
    expect(result.warnings.some((w) => w.code === 'no_ai_available')).toBe(true);
    expect(result.promptUserMessage).toContain('[service.checkout_low_signal]');
    expect(result.citedEvidenceIds).toHaveLength(2);
  });

  it('throws on invalid input before calling AI', async () => {
    await expect(ingestEvidenceBundle({} as AdapterRequest)).rejects.toThrow();
  });
});
