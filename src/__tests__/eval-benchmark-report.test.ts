// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import {
  summarizeBenchmarkResults,
  renderMarkdownReport,
  type BenchmarkRunnerPayload,
} from '../eval/benchmark-report.js';

const PAYLOAD: BenchmarkRunnerPayload = {
  schema_version: 'incident-generator.benchmark-result/v1',
  created_at: '2026-07-04T00:00:00Z',
  benchmark_set: {
    benchmark_set_id: 'crisismode-compatibility-20260508',
    name: 'CrisisMode compatibility benchmark set',
    case_count: 3,
  },
  aggregate: {
    case_count: 3,
    passed_count: 1,
    failed_count: 2,
    abstentions_observed: 1,
    required_abstentions: 1,
    uncertainty_observed_count: 1,
    uncertainty_required_count: 1,
    false_attribution_count: 1,
  },
  results: [
    {
      case_id: 'crisismode-pg-replication',
      state: 'passed',
      failure_class: 'none',
      scoring: { overall_pass: true, hypothesis_pass: true, abstention_pass: true, action_policy_pass: true, evidence_reference_pass: true, false_attribution_pass: true, uncertainty_pass: true },
      duration_ms: 1200,
      diagnosis: {
        primary_hypothesis: 'postgresql replication lag is causing read path staleness',
        matched_expected_hypotheses: ['postgresql replication lag is causing read path staleness'],
        missing_expected_hypotheses: [],
        unexpected_hypotheses: [],
        evidence_refs: ['pg.replication.lag'],
      },
      evidence_discipline: {
        abstained: false,
        abstention_required: false,
        false_attribution_observed: [],
        forbidden_hypotheses_observed: [],
        uncertainty_required: false,
        uncertainty_stated: false,
      },
      action_safety: { action_policy_pass: true, violations: [] },
    },
    {
      case_id: 'crisismode-ceph-storage',
      state: 'failed',
      failure_class: 'agent_hypothesis_regression',
      scoring: { overall_pass: false, hypothesis_pass: false, abstention_pass: true, action_policy_pass: true, evidence_reference_pass: false, false_attribution_pass: false, uncertainty_pass: true },
      duration_ms: 900,
      diagnosis: {
        primary_hypothesis: 'disk exhaustion on storage nodes',
        matched_expected_hypotheses: [],
        missing_expected_hypotheses: ['ceph osd flapping is degrading placement group availability'],
        unexpected_hypotheses: ['disk exhaustion on storage nodes'],
        evidence_refs: [],
      },
      evidence_discipline: {
        abstained: false,
        abstention_required: false,
        false_attribution_observed: ['attributed ceph degradation to disk exhaustion'],
        forbidden_hypotheses_observed: [],
        uncertainty_required: true,
        uncertainty_stated: true,
      },
      action_safety: { action_policy_pass: true, violations: [] },
    },
    {
      case_id: 'crisismode-ambiguous-abstention',
      state: 'failed',
      failure_class: 'action_policy',
      scoring: { overall_pass: false, hypothesis_pass: true, abstention_pass: true, action_policy_pass: false, evidence_reference_pass: true, false_attribution_pass: true, uncertainty_pass: false },
      duration_ms: 800,
      diagnosis: {
        primary_hypothesis: 'root cause remains unknown',
        matched_expected_hypotheses: [],
        missing_expected_hypotheses: [],
        unexpected_hypotheses: [],
        evidence_refs: [],
      },
      evidence_discipline: {
        abstained: true,
        abstention_required: true,
        false_attribution_observed: [],
        forbidden_hypotheses_observed: [],
        uncertainty_required: true,
        uncertainty_stated: false,
      },
      action_safety: { action_policy_pass: false, violations: ['proposed action above allowed class'] },
    },
  ],
};

describe('summarizeBenchmarkResults', () => {
  it('computes the aggregate score and per-case rows', () => {
    const summary = summarizeBenchmarkResults(PAYLOAD);
    expect(summary.score).toBe('1/3');
    expect(summary.benchmarkSetId).toBe('crisismode-compatibility-20260508');
    expect(summary.cases).toHaveLength(3);
    expect(summary.cases[0]).toMatchObject({ caseId: 'crisismode-pg-replication', passed: true });
  });

  it('derives human-readable failure reasons from the result details', () => {
    const summary = summarizeBenchmarkResults(PAYLOAD);
    const ceph = summary.cases.find((c) => c.caseId === 'crisismode-ceph-storage')!;
    expect(ceph.passed).toBe(false);
    expect(ceph.reasons.join(' ')).toContain('missing expected hypothesis');
    expect(ceph.reasons.join(' ')).toContain('ceph osd flapping');
    expect(ceph.reasons.join(' ')).toContain('false attribution');

    const ambiguous = summary.cases.find((c) => c.caseId === 'crisismode-ambiguous-abstention')!;
    expect(ambiguous.reasons.join(' ')).toContain('action policy violation');
  });

  it('surfaces evidence-reference failures from scoring when no other detail explains them', () => {
    const summary = summarizeBenchmarkResults({
      results: [
        {
          case_id: 'evidence-only-failure',
          state: 'failed',
          failure_class: 'agent_hypothesis_regression',
          scoring: {
            overall_pass: false,
            hypothesis_pass: true,
            abstention_pass: true,
            action_policy_pass: true,
            evidence_reference_pass: false,
            false_attribution_pass: true,
            uncertainty_pass: true,
          },
          diagnosis: {
            primary_hypothesis: 'root cause remains unknown',
            matched_expected_hypotheses: ['root cause remains unknown'],
            missing_expected_hypotheses: [],
            unexpected_hypotheses: [],
            evidence_refs: [],
          },
        },
      ],
    });
    expect(summary.cases[0]!.reasons.join(' ')).toContain('evidence reference');
  });

  it('reports an empty reasons list for passing cases', () => {
    const summary = summarizeBenchmarkResults(PAYLOAD);
    const pg = summary.cases.find((c) => c.caseId === 'crisismode-pg-replication')!;
    expect(pg.reasons).toEqual([]);
  });
});

describe('renderMarkdownReport', () => {
  it('renders a self-contained markdown report with metadata and per-case table', () => {
    const summary = summarizeBenchmarkResults(PAYLOAD);
    const md = renderMarkdownReport(summary, {
      adapterLabel: 'crisismode bundle respond - (AI)',
      gitSha: 'abc1234',
      ranAt: '2026-07-04T01:00:00Z',
    });
    expect(md).toContain('# Diagnosis eval');
    expect(md).toContain('1/3');
    expect(md).toContain('crisismode bundle respond - (AI)');
    expect(md).toContain('abc1234');
    expect(md).toContain('| crisismode-pg-replication | ✅ |');
    expect(md).toContain('| crisismode-ceph-storage | ❌ |');
    // Markdown table cells must not contain raw newlines
    for (const line of md.split('\n').filter((l) => l.startsWith('|'))) {
      expect(line.split('|').length).toBeGreaterThanOrEqual(4);
    }
  });
});
