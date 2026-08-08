// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { parseStatuspageIncidents, parseStatuspageSummary } from '../framework/service-status/statuspage.js';

const OPERATIONAL = {
  status: { indicator: 'none', description: 'All Systems Operational' },
  components: [{ name: 'API', status: 'operational' }],
  incidents: [],
};

const MINOR = {
  status: { indicator: 'minor', description: 'Partially Degraded Service' },
  components: [
    { name: 'API', status: 'operational' },
    { name: 'Webhooks', status: 'degraded_performance' },
  ],
  incidents: [],
};

const MAJOR_WITH_INCIDENT = {
  status: { indicator: 'major', description: 'Partial System Outage' },
  components: [{ name: 'API', status: 'partial_outage' }],
  incidents: [
    { name: 'Elevated API errors', impact: 'major', status: 'investigating', shortlink: 'https://stspg.io/x1' },
    { name: 'Old thing', impact: 'minor', status: 'resolved' },
  ],
};

describe('parseStatuspageIncidents (moved from llm-provider, behavior preserved)', () => {
  it('returns unresolved incidents only', () => {
    expect(parseStatuspageIncidents(MAJOR_WITH_INCIDENT)).toEqual([
      { title: 'Elevated API errors', impact: 'major', url: 'https://stspg.io/x1' },
    ]);
  });

  it('returns null for unparseable bodies', () => {
    expect(parseStatuspageIncidents(null)).toBeNull();
    expect(parseStatuspageIncidents({ incidents: 'nope' })).toBeNull();
  });
});

describe('parseStatuspageSummary', () => {
  it('classifies operational', () => {
    const parsed = parseStatuspageSummary(OPERATIONAL);
    expect(parsed).toEqual({ assessment: 'operational', incidents: [], indicator: 'none' });
  });

  it('classifies minor indicator / degraded component as degraded_reported', () => {
    expect(parseStatuspageSummary(MINOR)?.assessment).toBe('degraded_reported');
  });

  it('classifies unresolved incidents or major/critical indicator as incident_reported', () => {
    const parsed = parseStatuspageSummary(MAJOR_WITH_INCIDENT);
    expect(parsed?.assessment).toBe('incident_reported');
    expect(parsed?.incidents).toHaveLength(1);
  });

  it('returns null for garbage', () => {
    expect(parseStatuspageSummary([])).toBeNull();
    expect(parseStatuspageSummary(undefined)).toBeNull();
  });
});
