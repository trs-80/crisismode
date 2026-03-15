// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { getFiringAlerts, validateAlertPayload } from '../webhook-utils.js';

describe('webhook utils', () => {
  it('rejects payloads missing version or status', () => {
    expect(validateAlertPayload({
      status: 'firing',
      alerts: [],
    })).toBe(false);

    expect(validateAlertPayload({
      version: '4',
      alerts: [],
    })).toBe(false);
  });

  it('rejects payloads with malformed alerts', () => {
    expect(validateAlertPayload({
      version: '4',
      status: 'firing',
      alerts: [
        {
          status: 'firing',
          labels: null,
          annotations: {},
          startsAt: '2026-01-01T00:00:00Z',
          endsAt: '2026-01-01T00:05:00Z',
        },
      ],
    })).toBe(false);
  });

  it('returns all firing alerts in a batch', () => {
    const payload = {
      version: '4',
      status: 'firing',
      alerts: [
        {
          status: 'firing',
          labels: { alertname: 'A' },
          annotations: {},
          startsAt: '2026-01-01T00:00:00Z',
          endsAt: '2026-01-01T00:05:00Z',
        },
        {
          status: 'resolved',
          labels: { alertname: 'B' },
          annotations: {},
          startsAt: '2026-01-01T00:00:00Z',
          endsAt: '2026-01-01T00:05:00Z',
        },
        {
          status: 'firing',
          labels: { alertname: 'C' },
          annotations: {},
          startsAt: '2026-01-01T00:00:00Z',
          endsAt: '2026-01-01T00:05:00Z',
        },
      ],
    };

    expect(validateAlertPayload(payload)).toBe(true);
    expect(getFiringAlerts(payload)).toHaveLength(2);
    expect(getFiringAlerts(payload).map((alert) => alert.labels.alertname)).toEqual(['A', 'C']);
  });
});
