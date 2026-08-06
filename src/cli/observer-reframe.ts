// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Observer reframe — when triage says the problem is this machine or its
 * network, "six services are down" is the wrong headline. This module groups
 * the unreachable-service findings and attributes them to the observer, so
 * scan leads with the one thing worth fixing first.
 *
 * Deterministic and presentation-only: no finding is removed, no count and no
 * score changes. Machine output keeps every finding, flagged with
 * `possiblyObserverCaused`; human output collapses them under the reframe.
 */

import { layerCauseLabel, primaryFailureCode } from '../framework/triage.js';
import type { TriageReport } from '../framework/triage.js';
import type { ScanFinding } from './output.js';

export interface ObserverReframe {
  /** Only local and network verdicts reframe anything. */
  verdict: 'local' | 'network';
  /** IDs of the findings attributed to the observer's own machine/network. */
  findingIds: string[];
  /** Plain-language cause, named in the headline. */
  cause: string;
  /** The line human output leads with. */
  headline: string;
  nextStep: string;
}

/**
 * Connection-level failures only.
 *
 * Deliberately does NOT include bare `timeout` / `timed out`: those match
 * `statement_timeout`, `lock_timeout`, and `BLPOP timed out` — real service
 * outages that have nothing to do with the observer's network. Collapsing
 * those out of human output under a local/network verdict would hide a
 * genuine incident, which is far worse than showing one finding that turns
 * out to be observer-caused. `ETIMEDOUT` (the errno) stays, because it is
 * unambiguous; the English phrase does not.
 */
const UNREACHABLE_PATTERN =
  /unreachable|econnrefused|etimedout|ehostunreach|enetunreach|enotfound|eai_again|getaddrinfo|connection refused|connect failed/i;

/**
 * Does this finding look like "we could not reach the service" rather than
 * "the service told us something is wrong"? Only the former can be explained
 * by the observer's own network.
 */
export function isUnreachableFinding(finding: ScanFinding): boolean {
  if (finding.status !== 'unhealthy' && finding.status !== 'unknown') return false;
  if (UNREACHABLE_PATTERN.test(finding.summary)) return true;
  return finding.signals.some((s) => UNREACHABLE_PATTERN.test(s.detail));
}

export function reframeFindings(
  findings: ScanFinding[],
  report: TriageReport,
): { findings: ScanFinding[]; reframe: ObserverReframe | null } {
  if (report.verdict !== 'local' && report.verdict !== 'network') {
    return { findings, reframe: null };
  }

  const affected = findings.filter(isUnreachableFinding);
  if (affected.length === 0) return { findings, reframe: null };

  const code = primaryFailureCode(report.layers);
  const cause = code === null ? 'a network check on this machine failed' : layerCauseLabel(code);
  const affectedIds = new Set(affected.map((f) => f.id));
  const flagged = findings.map((f) => (affectedIds.has(f.id) ? { ...f, possiblyObserverCaused: true } : f));
  const subject = affected.length === 1 ? 'service appears' : 'services appear';

  return {
    findings: flagged,
    reframe: {
      verdict: report.verdict,
      findingIds: affected.map((f) => f.id),
      cause,
      headline: `${affected.length} ${subject} unreachable, but the likely cause is this machine's network (${cause}). Fix that first.`,
      nextStep: report.nextStep,
    },
  };
}
