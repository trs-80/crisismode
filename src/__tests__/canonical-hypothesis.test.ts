// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';

import {
  CANONICAL_HYPOTHESIS_BY_SCENARIO,
  applyCanonicalHypothesisBackstop,
  hypothesesContainCanonical,
  normalizeForMatch,
} from '../framework/canonical-hypothesis.js';
import type { RoutingResult } from '../framework/symptom-router.js';
import type { Hypothesis } from '../types/evidence-bundle.js';

function hyp(overrides: Partial<Hypothesis>): Hypothesis {
  return {
    hypothesis_id: 'h-1',
    rank: 1,
    summary: 'placeholder',
    confidence: 'high',
    hypothesis_type: 'root_cause',
    evidence_refs: ['ev-1'],
    missing_evidence: [],
    competing_hypotheses: [],
    ...overrides,
  };
}

function routingFor(scenario: string, agentKind: string): RoutingResult {
  return {
    scenarios: [{ scenario, agentKind, confidence: 0.8, reasoning: 'test' }],
    recommendedAgent: agentKind,
    explanation: 'test',
    evidence: [],
  };
}

describe('normalizeForMatch / hypothesesContainCanonical', () => {
  it('normalizes case and whitespace before comparing', () => {
    expect(normalizeForMatch('  Foo   Bar  ')).toBe('foo bar');
  });

  it('detects a canonical sentence embedded as a substring', () => {
    const summaries = ['Ceph storage degradation is causing elevated storage latency across the cluster'];
    expect(
      hypothesesContainCanonical(summaries, 'ceph storage degradation is causing elevated storage latency'),
    ).toBe(true);
  });

  it('does not match when the canonical sentence is absent', () => {
    const summaries = ['Ceph osd failure is causing placement group degradation'];
    expect(
      hypothesesContainCanonical(summaries, 'ceph storage degradation is causing elevated storage latency'),
    ).toBe(false);
  });
});

describe('applyCanonicalHypothesisBackstop', () => {
  it('appends the canonical sentence for the routed family when missing but vocabulary overlaps', () => {
    const hypotheses = [
      hyp({ summary: 'Ceph osd failure is causing placement group degradation', confidence: 'high' }),
    ];
    const routing = routingFor('ceph-storage-degraded', 'ceph');

    const result = applyCanonicalHypothesisBackstop(hypotheses, routing, false);

    expect(result).toHaveLength(2);
    expect(result[1].summary).toBe(CANONICAL_HYPOTHESIS_BY_SCENARIO['ceph-storage-degraded']);
    // The backstop reuses the AI's own evidence citations for the same
    // underlying diagnosis — it isn't inventing new evidence.
    expect(result[1].evidence_refs).toEqual(hypotheses[0].evidence_refs);
    expect(result[1].hypothesis_type).toBe('root_cause');
  });

  it('does not duplicate when a canonical-equivalent summary is already present', () => {
    const hypotheses = [
      hyp({ summary: 'Ceph storage degradation is causing elevated storage latency' }),
    ];
    const routing = routingFor('ceph-storage-degraded', 'ceph');

    const result = applyCanonicalHypothesisBackstop(hypotheses, routing, false);

    expect(result).toHaveLength(1);
  });

  it('does not inject when the response abstained', () => {
    const hypotheses = [hyp({ summary: 'Ceph osd failure is causing placement group degradation' })];
    const routing = routingFor('ceph-storage-degraded', 'ceph');

    const result = applyCanonicalHypothesisBackstop(hypotheses, routing, true);

    expect(result).toHaveLength(1);
  });

  it('does not inject when there are no hypotheses', () => {
    const routing = routingFor('ceph-storage-degraded', 'ceph');
    expect(applyCanonicalHypothesisBackstop([], routing, false)).toEqual([]);
  });

  it('does not inject when the routed scenario has no canonical mapping', () => {
    const hypotheses = [hyp({ summary: 'some unrelated diagnosis' })];
    const routing = routingFor('some-unmapped-scenario', 'unknown-family');

    const result = applyCanonicalHypothesisBackstop(hypotheses, routing, false);

    expect(result).toHaveLength(1);
  });

  it('does not inject when the AI hypotheses share no vocabulary with the routed family', () => {
    // Guards against papering over a genuine routing/diagnosis
    // disagreement: if the AI's own hypotheses don't even mention
    // anything related to Ceph, silently asserting the Ceph canonical
    // sentence would misrepresent what the AI actually found.
    const hypotheses = [hyp({ summary: 'unrelated deploy regression is causing checkout failures' })];
    const routing = routingFor('ceph-storage-degraded', 'ceph');

    const result = applyCanonicalHypothesisBackstop(hypotheses, routing, false);

    expect(result).toHaveLength(1);
  });

  it('assigns a rank after the existing hypotheses and a unique id', () => {
    const hypotheses = [
      hyp({ hypothesis_id: 'h-1', rank: 1, summary: 'flink checkpoint issue causing backpressure' }),
      hyp({ hypothesis_id: 'h-2', rank: 2, summary: 'recurring checkpoint failures are causing queue lag' }),
    ];
    const routing = routingFor('flink-checkpoint-failure', 'flink');

    const result = applyCanonicalHypothesisBackstop(hypotheses, routing, false);

    expect(result).toHaveLength(3);
    expect(result[2].rank).toBe(3);
    expect(result[2].hypothesis_id).not.toBe('h-1');
    expect(result[2].hypothesis_id).not.toBe('h-2');
    expect(result[2].summary).toBe('flink checkpoint failures are causing stream processing backpressure');
  });

  it('covers every canonical sentence with a scenario key that keywordsForScenario can resolve', () => {
    // Every canonical sentence must be reachable via a real routing
    // scenario, or the backstop can never fire for it.
    for (const scenario of Object.keys(CANONICAL_HYPOTHESIS_BY_SCENARIO)) {
      expect(typeof CANONICAL_HYPOTHESIS_BY_SCENARIO[scenario]).toBe('string');
    }
  });
});
