// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { ReadinessFinding, ReadinessReport } from './types.js';

/** A blocking finding is an outage waiting for traffic — heavy penalty. */
const BLOCKING_PENALTY = 30;
/** An at-risk finding degrades under load but may survive — light penalty. */
const AT_RISK_PENALTY = 10;

export function buildReport(findings: ReadinessFinding[]): ReadinessReport {
  const known = findings.filter((f) => f.status !== 'unknown');
  const unknown = findings.length - known.length;

  let score = 100;
  for (const f of known) {
    if (f.status === 'blocking') score -= BLOCKING_PENALTY;
    else if (f.status === 'at_risk') score -= AT_RISK_PENALTY;
  }
  score = Math.max(0, score);

  let verdict: ReadinessReport['verdict'];
  if (known.length === 0) verdict = 'unknown';
  else if (known.some((f) => f.status === 'blocking')) verdict = 'not-ready';
  else if (known.some((f) => f.status === 'at_risk')) verdict = 'at-risk';
  else verdict = 'ready';

  return { verdict, score, evaluated: known.length, unknown, findings };
}
