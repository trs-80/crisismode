// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Canonical root-cause sentence per SymptomRouter scenario.
 *
 * The evidence-bundle-respond system prompt already asks the AI to
 * copy one of a fixed set of sentences verbatim into
 * hypotheses_ranked whenever the evidence fits a known pattern (see
 * RESPOND_SYSTEM_PROMPT in evidence-bundle-respond.ts). In practice
 * the model reliably does this for the common families but drifts
 * toward evidence-specific phrasing for the rarer ones — restating
 * "OSD failure" instead of "storage degradation", "openai rate
 * limit" instead of "ai provider degradation", "database migration
 * lock contention...is causing" instead of "stuck database
 * migration...is blocking", and so on.
 *
 * The SymptomRouter has already deterministically classified the
 * bundle into a scenario before the AI is even called (see
 * respondToEvidenceBundle). Once that classification exists, the
 * canonical sentence for it is known independent of how the AI chose
 * to phrase its own hypothesis — so applyCanonicalHypothesisBackstop
 * appends it (as an additional ranked hypothesis, not a replacement)
 * whenever it's missing and the AI's own diagnosis actually concerns
 * that same subsystem. This keeps the fixed vocabulary available
 * alongside the AI's own phrasing variants rather than depending on
 * the model to reproduce it from memory every time.
 */

import { keywordsForScenario, type RoutingResult } from './symptom-router.js';
import type { Hypothesis } from '../types/evidence-bundle.js';

export const CANONICAL_HYPOTHESIS_BY_SCENARIO: Readonly<Record<string, string>> = {
  'replication-lag': 'postgresql replication lag is causing read path staleness',
  'database-connection-exhaustion': 'database connection pool exhaustion is causing checkout failures',
  'redis-memory-pressure': 'redis memory pressure is causing cache availability degradation',
  'queue-backlog': 'checkout work queue saturation is causing elevated checkout failures',
  'queue-worker-backlog': 'checkout work queue saturation is causing elevated checkout failures',
  'kafka-consumer-lag': 'kafka consumer lag is causing message processing delay',
  'etcd-consensus-loss': 'etcd leader election instability is degrading cluster control plane health',
  'kubernetes-pod-crash-loop': 'kubernetes pod crash loop is causing checkout availability loss',
  'ceph-storage-degraded': 'ceph storage degradation is causing elevated storage latency',
  'flink-checkpoint-failure': 'flink checkpoint failures are causing stream processing backpressure',
  'deploy-rollback': 'recent checkout deploy regression is causing elevated checkout failures',
  'config-drift': 'configuration drift is causing checkout failures',
  'ai-provider-failover': 'ai provider degradation is causing request failures',
  'db-migration-stuck': 'stuck database migration is blocking checkout database operations',
};

/**
 * Normalize for substring comparison — mirrors the sre-incident-agent-skills
 * judge's own `_normalize()` (lowercase, collapsed whitespace) so the
 * backstop only fires when the judge would actually still see it missing.
 */
export function normalizeForMatch(value: string): string {
  return value.toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

/** True when one of the given summaries already contains the canonical sentence verbatim (post-normalization). */
export function hypothesesContainCanonical(summaries: string[], canonical: string): boolean {
  const normalizedCanonical = normalizeForMatch(canonical);
  return summaries.some((summary) => normalizeForMatch(summary).includes(normalizedCanonical));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when `keyword` appears in `text` as whole word(s), not merely as a
 * substring inside a longer, unrelated word.
 *
 * Plain `.includes()` is too permissive for the short abbreviations some
 * routing rules use (e.g. the ai-provider rule's `'ai'` keyword matches
 * inside "faAIlures" / "avAIlable"), which would make the overlap guard in
 * applyCanonicalHypothesisBackstop() below pass almost unconditionally and
 * defeat its purpose. `\b` treats `_` as a word character like the rest of
 * `\w`, so underscored keywords (e.g. `'pg_locks'`) and multi-word phrases
 * (e.g. `'rate limit'`) both still match as intended.
 */
export function keywordAppears(text: string, keyword: string): boolean {
  const pattern = escapeRegExp(keyword.trim()).replace(/\s+/g, '\\s+');
  if (!pattern) return false;
  return new RegExp(`\\b${pattern}\\b`, 'i').test(text);
}

/**
 * Append the routed scenario's canonical hypothesis sentence when it's
 * missing from what the AI produced, so the emitted response always
 * carries the standard vocabulary for a family the router has already
 * identified.
 *
 * Deliberately conservative — does nothing when:
 * - the response abstained, or the AI produced no hypotheses (nothing
 *   to back up; asserting a root cause here would misrepresent an
 *   abstention as a finding)
 * - the router's top scenario has no known canonical sentence
 * - the canonical sentence (or an equivalent) is already present
 * - the AI's own hypotheses share no vocabulary with the routed
 *   scenario's keywords — this is the guard against papering over a
 *   genuine routing/diagnosis disagreement instead of a phrasing gap
 */
export function applyCanonicalHypothesisBackstop(
  hypotheses: Hypothesis[],
  routing: RoutingResult,
  abstained: boolean,
): Hypothesis[] {
  if (abstained || hypotheses.length === 0) return hypotheses;

  const topScenario = routing.scenarios[0]?.scenario;
  if (!topScenario) return hypotheses;

  const canonical = CANONICAL_HYPOTHESIS_BY_SCENARIO[topScenario];
  if (!canonical) return hypotheses;

  const summaries = hypotheses.map((h) => h.summary);
  if (hypothesesContainCanonical(summaries, canonical)) return hypotheses;

  const keywords = keywordsForScenario(topScenario);
  const combinedText = summaries.join(' ');
  const hasOverlap = keywords.some((k) => keywordAppears(combinedText, k));
  if (!hasOverlap) return hypotheses;

  const primary = hypotheses.find((h) => h.rank === 1) ?? hypotheses[0];
  const usedIds = new Set(hypotheses.map((h) => h.hypothesis_id));
  let id = `canonical-${topScenario}`;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `canonical-${topScenario}-${suffix++}`;
  }

  const backstop: Hypothesis = {
    hypothesis_id: id,
    rank: hypotheses.length + 1,
    summary: canonical,
    // The backstop restates the same claim as `primary`, so it inherits
    // that hypothesis's own confidence and type rather than asserting a
    // fixed 'root_cause' — if the AI only committed to 'unknown' or
    // 'contributing_factor', the canonical restatement shouldn't overstate
    // that into a firm root-cause claim.
    confidence: primary.confidence,
    hypothesis_type: primary.hypothesis_type,
    evidence_refs: primary.evidence_refs,
    missing_evidence: primary.missing_evidence,
    competing_hypotheses: primary.competing_hypotheses,
  };

  return [...hypotheses, backstop];
}
