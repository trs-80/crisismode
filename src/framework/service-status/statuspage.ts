// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { StatusIncident, StatusPageAssessment } from './types.js';

/** Statuspage v2 summary: unresolved entries in `incidents[]`. */
export function parseStatuspageIncidents(body: unknown): StatusIncident[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const incidents = (body as { incidents?: unknown }).incidents;
  if (!Array.isArray(incidents)) return null;
  return incidents
    .filter((raw): raw is Record<string, unknown> => typeof raw === 'object' && raw !== null)
    .filter((raw) => raw.status !== 'resolved' && raw.status !== 'postmortem')
    .map((raw) => ({
      title: typeof raw.name === 'string' ? raw.name : 'unnamed incident',
      impact: typeof raw.impact === 'string' ? raw.impact : 'unknown',
      ...(typeof raw.shortlink === 'string' ? { url: raw.shortlink } : {}),
    }));
}

/**
 * Full Statuspage-v2 classification. `incident_reported` when unresolved
 * incidents exist or the overall indicator is major/critical;
 * `degraded_reported` when the indicator is minor or any component is not
 * operational; `operational` otherwise. Null when the body is not a
 * Statuspage summary.
 *
 * Structural validation before classification: `status.indicator` must be a
 * string, and `components`, when present, must be an array. Without this, an
 * incomplete or malformed body such as `{ incidents: [] }` classified as
 * `operational` — `fetchStatus` (checker.ts) then reported `healthy` for a
 * response that was never actually confirmed operational, violating honesty
 * rule 1 (an unparseable/incomplete response must never read as evidence of
 * health). `components` is optional — its absence is not itself malformed,
 * only a non-array value when present is. The indicator STRING is not
 * restricted to a fixed enum: real Statuspage instances use values this
 * classifier doesn't special-case (`'maintenance'`, for one) — an unknown
 * string indicator is classified conservatively by falling through to the
 * same operational/degraded logic as before, not rejected. Only structural
 * absence or malformation (missing status, non-string indicator, non-array
 * components) returns null.
 */
export function parseStatuspageSummary(body: unknown): StatusPageAssessment | null {
  const incidents = parseStatuspageIncidents(body);
  if (incidents === null) return null;
  const status = (body as { status?: { indicator?: unknown } }).status;
  if (typeof status?.indicator !== 'string') return null;
  const indicator = status.indicator;
  const componentsRaw = (body as { components?: unknown }).components;
  if (componentsRaw !== undefined && !Array.isArray(componentsRaw)) return null;
  const nonOperational = Array.isArray(componentsRaw)
    ? componentsRaw.filter(
        (c): c is Record<string, unknown> => typeof c === 'object' && c !== null,
      ).filter((c) => typeof c.status === 'string' && c.status !== 'operational').length
    : 0;

  if (incidents.length > 0 || indicator === 'major' || indicator === 'critical') {
    return { assessment: 'incident_reported', incidents, indicator };
  }
  if (indicator === 'minor' || nonOperational > 0) {
    return { assessment: 'degraded_reported', incidents, indicator };
  }
  return { assessment: 'operational', incidents, indicator };
}
