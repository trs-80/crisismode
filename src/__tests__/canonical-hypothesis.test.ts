// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';

import {
  CANONICAL_HYPOTHESIS_BY_SCENARIO,
  applyCanonicalHypothesisBackstop,
  hypothesesContainCanonical,
  keywordAppears,
  normalizeForMatch,
} from '../framework/canonical-hypothesis.js';
import { keywordsForScenario, type RoutingResult } from '../framework/symptom-router.js';
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
    const injected = result[1]!;
    expect(injected.summary).toBe(CANONICAL_HYPOTHESIS_BY_SCENARIO['ceph-storage-degraded']);
    // The backstop reuses the AI's own evidence citations for the same
    // underlying diagnosis — it isn't inventing new evidence.
    expect(injected.evidence_refs).toEqual(hypotheses[0]!.evidence_refs);
    expect(injected.hypothesis_type).toBe('root_cause');
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
    const injected = result[2]!;
    expect(injected.rank).toBe(3);
    expect(injected.hypothesis_id).not.toBe('h-1');
    expect(injected.hypothesis_id).not.toBe('h-2');
    expect(injected.summary).toBe('flink checkpoint failures are causing stream processing backpressure');
  });

  it('covers every canonical sentence with a scenario key that keywordsForScenario can resolve', () => {
    // Every canonical sentence must be reachable via a real routing
    // scenario, or the overlap guard can never pass and the backstop can
    // never fire for it. A future rename of a scenario id in
    // symptom-router.ts without updating this table would otherwise fail
    // silently (an empty keyword list just means the guard always blocks).
    for (const scenario of Object.keys(CANONICAL_HYPOTHESIS_BY_SCENARIO)) {
      const keywords = keywordsForScenario(scenario);
      expect(keywords.length, `expected non-empty keywords for scenario "${scenario}"`).toBeGreaterThan(0);
    }
  });

  it('does not inject on a genuine routing/diagnosis disagreement even when a short keyword substring-matches unrelated words', () => {
    // Regression test: the ai-provider-failover rule's 'ai' keyword is a
    // substring of ordinary English words like "failures" and
    // "available". A naive .includes() check would treat almost any
    // hypothesis text as "overlapping" with the ai-provider family and
    // defeat the guard's purpose. The AI's hypothesis here is genuinely
    // about a different family (deploy regression) and never uses the
    // word "ai" as a standalone token, so the backstop must stay out.
    const hypotheses = [
      hyp({ summary: 'recent checkout deploy regression is causing elevated checkout failures' }),
    ];
    const routing = routingFor('ai-provider-failover', 'ai-provider');

    const result = applyCanonicalHypothesisBackstop(hypotheses, routing, false);

    expect(result).toHaveLength(1);
  });

  it('still injects for ai-provider-failover when the AI hypothesis genuinely uses ai-provider vocabulary', () => {
    const hypotheses = [
      hyp({ summary: 'openai rate limit exhaustion is causing request failures' }),
    ];
    const routing = routingFor('ai-provider-failover', 'ai-provider');

    const result = applyCanonicalHypothesisBackstop(hypotheses, routing, false);

    expect(result).toHaveLength(2);
    expect(result[1]!.summary).toBe('ai provider degradation is causing request failures');
  });
});

describe('keywordAppears', () => {
  it('matches a short keyword only as a whole word, not embedded inside a longer word', () => {
    expect(keywordAppears('ai provider degradation', 'ai')).toBe(true);
    expect(keywordAppears('elevated checkout failures', 'ai')).toBe(false);
    expect(keywordAppears('cache availability degradation', 'ai')).toBe(false);
  });

  it('matches underscored keywords as a single token', () => {
    expect(keywordAppears('pg_locks detected on the checkout table', 'pg_locks')).toBe(true);
    expect(keywordAppears('shipping is delayed', 'pg')).toBe(false);
  });

  it('matches multi-word keyword phrases with whole-word boundaries', () => {
    expect(keywordAppears('provider is hitting a rate limit', 'rate limit')).toBe(true);
    expect(keywordAppears('the rate limiter was untouched', 'rate limit')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(keywordAppears('Ceph OSD failure', 'osd')).toBe(true);
  });
});
