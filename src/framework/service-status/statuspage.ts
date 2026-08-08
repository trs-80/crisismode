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
 */
export function parseStatuspageSummary(body: unknown): StatusPageAssessment | null {
  const incidents = parseStatuspageIncidents(body);
  if (incidents === null) return null;
  const status = (body as { status?: { indicator?: unknown } }).status;
  const indicator = typeof status?.indicator === 'string' ? status.indicator : 'unknown';
  const componentsRaw = (body as { components?: unknown }).components;
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
