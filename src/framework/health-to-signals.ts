// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Adapts HealthAssessment signals (free-text) into typed SymptomSignals
 * so scan results can feed the root-cause-synthesis correlation rules.
 */

import type { HealthAssessment } from '../types/health.js';
import type { SymptomSignal } from './symptom-router.js';

const TYPE_PATTERNS: Array<{ match: RegExp; type: SymptomSignal['type'] }> = [
  { match: /timed?[ _-]?out|timeout/i, type: 'timeout' },
  { match: /unreachable|refused|connect|ENOTFOUND|EAI_AGAIN/i, type: 'connection' },
  { match: /lag|latency|slow/i, type: 'latency' },
  { match: /memory|disk|inode|\bfull\b|exhaust|evict/i, type: 'resource_exhaustion' },
  { match: /error rate|\b5\d\d\b|failing|failed/i, type: 'error_rate' },
];

export function healthToSignals(health: HealthAssessment): SymptomSignal[] {
  const out: SymptomSignal[] = [];
  for (const sig of health.signals) {
    if (sig.status !== 'critical' && sig.status !== 'warning') continue;
    const text = `${sig.source} ${sig.detail}`;
    const matched = TYPE_PATTERNS.find((p) => p.match.test(text));
    if (!matched) continue;
    out.push({
      type: matched.type,
      source: sig.source,
      detail: sig.detail,
      severity: sig.status,
    });
  }
  return out;
}
