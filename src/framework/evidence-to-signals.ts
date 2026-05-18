// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Convert bundle evidence items into CrisisMode SymptomSignals so
 * the SymptomRouter can recommend an agent family.
 *
 * Each evidence item produces exactly one signal. Inference is
 * keyword-driven against (adapter_id + title + content.body): cheap,
 * deterministic, easy to extend. When inference fails, the signal
 * type is `custom` — the router falls back to its other heuristics.
 */

import type { EvidenceItem } from '../types/evidence-bundle.js';
import type { SymptomSignal } from './symptom-router.js';

const MAX_DETAIL_LENGTH = 500;

/**
 * Build SymptomSignals from a bundle's evidence_items[].
 */
export function evidenceItemsToSignals(items: EvidenceItem[]): SymptomSignal[] {
  return items.map(toSignal);
}

function toSignal(item: EvidenceItem): SymptomSignal {
  const domain = item.adapter_id.split('.')[0] || 'unknown';
  const haystack = (
    `${item.adapter_id} ${item.title} ${item.content.body}`
  ).toLowerCase();
  return {
    type: inferType(haystack),
    source: domain,
    detail: clip(`${item.title}: ${item.content.body}`),
    severity: inferSeverity(item, haystack),
    data: {
      evidence_id: item.evidence_id,
      adapter_id: item.adapter_id,
      source_kind: item.source_kind,
      content_type: item.content_type,
    },
  };
}

function clip(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length > MAX_DETAIL_LENGTH
    ? `${cleaned.slice(0, MAX_DETAIL_LENGTH)}...`
    : cleaned;
}

// Order matters: earlier matches win. Most specific patterns first.
//
// Calibration target: the SymptomRouter routing rules' signalTypes.
//   - 'connection' is what postgresql expects for pool saturation
//   - 'resource_exhaustion' is what redis expects for memory pressure
//   - 'queue_depth' is what kafka expects for consumer lag
// Patterns use word-stem matching (no trailing \b on stems) so
// "saturated" / "saturation" / "exhausted" all match.
const TYPE_PATTERNS: Array<{
  type: SymptomSignal['type'];
  pattern: RegExp;
}> = [
  // queue_depth wins over latency for kafka consumer/queue scenarios
  { type: 'queue_depth', pattern: /\b(queue|backlog|consumer[_.\s]?lag|consumer[_.\s]?group|offset|partition|broker)/ },
  // crash loops — Kubernetes uses 'CrashLoopBackOff' which we treat as an error_rate signal
  { type: 'error_rate', pattern: /\bcrash[_\s]?loop/ },
  // connection / pool issues — postgresql connection-exhaustion expects this type
  {
    type: 'connection',
    pattern: /\b(connection[_\s]?pool|pool[_\s]?(status|satur|exhaust|full|capacity|max)|max[_\s]?connections?|too[_\s]?many[_\s]?connections?|connection[_\s]?refused|cannot[_\s]?connect|unreachable|reset[_\s]?by[_\s]?peer|dns[_\s]?fail)/,
  },
  // resource_exhaustion: memory, disk, OOM (NOT connection pools — those route as 'connection')
  { type: 'resource_exhaustion', pattern: /\b(memory|oom|disk|free[_\s]?space|usage|capacity|quota|eviction|maxmemory)/ },
  // config_mismatch: drift, env, mismatch
  { type: 'config_mismatch', pattern: /\b(config[_\s]?drift|drift|mismatch|env[_\s]?var|environment[_\s]?variable|misconfig)/ },
  // deploy_change: deploy, release, rollback
  { type: 'deploy_change', pattern: /\b(deploy(ment)?|release|rollback|revision|version[_\s]?bump|migration)/ },
  // timeouts
  { type: 'timeout', pattern: /\b(timed[_\s]?out|timeout|hanging|stuck)/ },
  // generic error rate (broad — keep AFTER more specific patterns)
  { type: 'error_rate', pattern: /\b(50\d|40[0-9]|error[_\s]?rate|errors?|panic|exception|fail(ed|ing|ure)?)/ },
  // latency / replication lag — broadest of the lag-shaped patterns
  { type: 'latency', pattern: /\b(replication|wal|replica|lag|delay|latenc|slow|p9[5-9]|p99|response[_\s]?time)/ },
];

function inferType(haystack: string): SymptomSignal['type'] {
  for (const { type, pattern } of TYPE_PATTERNS) {
    if (pattern.test(haystack)) return type;
  }
  return 'custom';
}

function inferSeverity(
  item: EvidenceItem,
  haystack: string,
): SymptomSignal['severity'] {
  // Critical signals: explicit critical words, 5xx, OOM, crash
  if (/\b(critical|crash[_\s]?loop|oom|kill|panic|fatal|503|504)\b/.test(haystack)) {
    return 'critical';
  }
  // Untrusted evidence is downgraded so a single hostile note can't
  // tilt routing toward an unrelated agent.
  if (item.untrusted) return 'info';
  // Defaults by source_kind: metrics + events are usually warnings,
  // logs are warnings unless they say "info", operator notes are info.
  if (item.source_kind === 'operator_note') return 'info';
  return 'warning';
}
