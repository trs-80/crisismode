// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SentryIntegration, parseDSN } from '../integrations/sentry.js';

// ── Mock fetch ──

function mockFetch(responses: Array<{ ok: boolean; status?: number; body: unknown }>) {
  let callIndex = 0;
  const fetchMock = vi.fn(async (_url: string, _opts?: RequestInit) => {
    const resp = responses[callIndex] ?? { ok: true, status: 200, body: {} };
    callIndex++;
    return {
      ok: resp.ok,
      status: resp.status ?? (resp.ok ? 200 : 400),
      statusText: resp.ok ? 'OK' : 'Bad Request',
      json: async () => resp.body,
    } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

// ── Helpers ──

function makeSentryIssues(count = 3) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${1000 + i}`,
    title: `TypeError: Cannot read property '${['foo', 'bar', 'baz'][i]}' of undefined`,
    count: `${(i + 1) * 50}`,
    firstSeen: '2026-03-16T10:00:00.000Z',
    lastSeen: '2026-03-17T12:00:00.000Z',
    metadata: { value: '1.2.3' },
    stats: { '24h': [[1710000000, 10], [1710003600, 15]] },
  }));
}

// ── Tests ──

describe('SentryIntegration', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      SENTRY_DSN: process.env.SENTRY_DSN,
      SENTRY_AUTH_TOKEN: process.env.SENTRY_AUTH_TOKEN,
      SENTRY_ORG: process.env.SENTRY_ORG,
      SENTRY_PROJECT: process.env.SENTRY_PROJECT,
    };
    delete process.env.SENTRY_DSN;
    delete process.env.SENTRY_AUTH_TOKEN;
    delete process.env.SENTRY_ORG;
    delete process.env.SENTRY_PROJECT;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    vi.restoreAllMocks();
  });

  describe('connect', () => {
    it('throws without DSN or auth token', async () => {
      const sentry = new SentryIntegration();
      await expect(sentry.connect()).rejects.toThrow('SENTRY_DSN or SENTRY_AUTH_TOKEN required');
    });

    it('connects with DSN only', async () => {
      const sentry = new SentryIntegration({
        dsn: 'https://key123@myorg.ingest.sentry.io/12345',
      });
      await sentry.connect();
      expect(sentry.connected).toBe(true);
    });

    it('validates auth token against API', async () => {
      mockFetch([{ ok: true, body: { slug: 'myorg' } }]);
      const sentry = new SentryIntegration({
        authToken: 'sntrys_test',
        organization: 'myorg',
        apiBaseUrl: 'https://test.sentry.io/api/0',
      });
      await sentry.connect();
      expect(sentry.connected).toBe(true);
    });

    it('throws on auth failure', async () => {
      mockFetch([{ ok: false, status: 401, body: {} }]);
      const sentry = new SentryIntegration({
        authToken: 'sntrys_bad',
        organization: 'myorg',
        apiBaseUrl: 'https://test.sentry.io/api/0',
      });
      await expect(sentry.connect()).rejects.toThrow('Sentry API authentication failed');
    });

    it('reads from env vars', async () => {
      process.env.SENTRY_DSN = 'https://key@org.ingest.sentry.io/99';
      const sentry = new SentryIntegration();
      await sentry.connect();
      expect(sentry.connected).toBe(true);
    });
  });

  describe('disconnect', () => {
    it('sets connected to false', async () => {
      const sentry = new SentryIntegration({ dsn: 'https://key@org.ingest.sentry.io/1' });
      await sentry.connect();
      await sentry.disconnect();
      expect(sentry.connected).toBe(false);
    });
  });

  describe('getRecentErrors', () => {
    it('throws when not connected', async () => {
      const sentry = new SentryIntegration({ dsn: 'https://key@org.ingest.sentry.io/1' });
      await expect(sentry.getRecentErrors('2026-03-17', 10)).rejects.toThrow('not connected');
    });

    it('returns empty array without auth token', async () => {
      const sentry = new SentryIntegration({ dsn: 'https://key@org.ingest.sentry.io/1' });
      await sentry.connect();
      const errors = await sentry.getRecentErrors('2026-03-17', 10);
      expect(errors).toEqual([]);
    });

    it('fetches recent errors from API', async () => {
      const issues = makeSentryIssues();
      mockFetch([
        { ok: true, body: { slug: 'myorg' } },
        { ok: true, body: issues },
      ]);

      const sentry = new SentryIntegration({
        authToken: 'sntrys_test',
        organization: 'myorg',
        apiBaseUrl: 'https://test.sentry.io/api/0',
      });
      await sentry.connect();

      const errors = await sentry.getRecentErrors('2026-03-17T00:00:00Z', 10);
      expect(errors).toHaveLength(3);
      expect(errors[0].title).toContain('TypeError');
      expect(errors[0].count).toBe(50);
      expect(errors[2].count).toBe(150);
    });

    it('returns empty on API failure', async () => {
      mockFetch([
        { ok: true, body: {} },
        { ok: false, status: 500, body: {} },
      ]);

      const sentry = new SentryIntegration({
        authToken: 'sntrys_test',
        organization: 'myorg',
        apiBaseUrl: 'https://test.sentry.io/api/0',
      });
      await sentry.connect();

      const errors = await sentry.getRecentErrors('2026-03-17', 10);
      expect(errors).toEqual([]);
    });

    it('includes project filter when configured', async () => {
      const fetchMock = mockFetch([
        { ok: true, body: {} },
        { ok: true, body: [] },
      ]);

      const sentry = new SentryIntegration({
        authToken: 'sntrys_test',
        organization: 'myorg',
        project: 'api-service',
        apiBaseUrl: 'https://test.sentry.io/api/0',
      });
      await sentry.connect();

      await sentry.getRecentErrors('2026-03-17', 10);
      const url = fetchMock.mock.calls[1][0] as string;
      expect(url).toContain('project=api-service');
    });
  });

  describe('getErrorSpike', () => {
    it('returns null without auth token', async () => {
      const sentry = new SentryIntegration({ dsn: 'https://key@org.ingest.sentry.io/1' });
      await sentry.connect();
      const spike = await sentry.getErrorSpike();
      expect(spike).toBeNull();
    });

    it('returns null when no issues found', async () => {
      mockFetch([
        { ok: true, body: {} },
        { ok: true, body: [] },
      ]);

      const sentry = new SentryIntegration({
        authToken: 'sntrys_test',
        organization: 'myorg',
        apiBaseUrl: 'https://test.sentry.io/api/0',
      });
      await sentry.connect();

      const spike = await sentry.getErrorSpike();
      expect(spike).toBeNull();
    });

    it('detects spike from high-frequency issues', async () => {
      // Issues with high counts to trigger spike detection
      const highFreqIssues = Array.from({ length: 5 }, (_, i) => ({
        id: `${1000 + i}`,
        title: `Error ${i}`,
        count: `${500 + i * 100}`,
        firstSeen: '2026-03-16T10:00:00.000Z',
        lastSeen: '2026-03-17T12:00:00.000Z',
      }));

      mockFetch([
        { ok: true, body: {} },
        { ok: true, body: highFreqIssues },
      ]);

      const sentry = new SentryIntegration({
        authToken: 'sntrys_test',
        organization: 'myorg',
        apiBaseUrl: 'https://test.sentry.io/api/0',
      });
      await sentry.connect();

      const spike = await sentry.getErrorSpike();
      expect(spike).not.toBeNull();
      expect(spike!.spikeMultiplier).toBeGreaterThan(1);
      expect(spike!.topErrors.length).toBeGreaterThan(0);
      expect(spike!.currentRate).toBeGreaterThan(0);
    });
  });

  describe('enrich', () => {
    it('returns enrichment with recent errors and summary', async () => {
      const issues = makeSentryIssues(5);
      mockFetch([
        { ok: true, body: {} },
        { ok: true, body: issues },
        { ok: true, body: issues },
      ]);

      const sentry = new SentryIntegration({
        authToken: 'sntrys_test',
        organization: 'myorg',
        apiBaseUrl: 'https://test.sentry.io/api/0',
      });
      await sentry.connect();

      const enrichment = await sentry.enrich(30);
      expect(enrichment.recentErrors.length).toBe(5);
      expect(enrichment.summary).toContain('recent error');
      expect(enrichment.summary).toContain('TypeError');
    });

    it('handles errors gracefully', async () => {
      mockFetch([
        { ok: true, body: {} },
        { ok: false, status: 500, body: {} },
        { ok: false, status: 500, body: {} },
      ]);

      const sentry = new SentryIntegration({
        authToken: 'sntrys_test',
        organization: 'myorg',
        apiBaseUrl: 'https://test.sentry.io/api/0',
      });
      await sentry.connect();

      const enrichment = await sentry.enrich();
      expect(enrichment.recentErrors).toEqual([]);
      expect(enrichment.errorSpike).toBeNull();
      expect(enrichment.summary).toContain('No recent errors');
    });
  });

  describe('formatForAI', () => {
    it('formats enrichment for AI consumption', async () => {
      const sentry = new SentryIntegration({ dsn: 'https://key@org.ingest.sentry.io/1' });
      await sentry.connect();

      const enrichment = {
        recentErrors: [
          { id: '1', title: 'TypeError: foo', count: 42, firstSeen: '2026-03-17', lastSeen: '2026-03-17' },
        ],
        errorSpike: {
          currentRate: 50,
          baselineRate: 10,
          spikeMultiplier: 5,
          topErrors: [],
        },
        summary: '1 recent error.',
      };

      const formatted = sentry.formatForAI(enrichment);
      expect(formatted).toContain('Sentry Error Context');
      expect(formatted).toContain('TypeError: foo');
      expect(formatted).toContain('42x');
      expect(formatted).toContain('5x above baseline');
      expect(formatted).toContain('50.0 errors/hour');
    });

    it('formats without spike', async () => {
      const sentry = new SentryIntegration({ dsn: 'https://key@org.ingest.sentry.io/1' });
      await sentry.connect();

      const enrichment = {
        recentErrors: [],
        errorSpike: null,
        summary: 'No recent errors in Sentry.',
      };

      const formatted = sentry.formatForAI(enrichment);
      expect(formatted).toContain('No recent errors');
      expect(formatted).not.toContain('Error Spike');
    });
  });
});

describe('parseDSN', () => {
  it('parses valid Sentry DSN', () => {
    const result = parseDSN('https://key123@myorg.ingest.sentry.io/12345');
    expect(result.key).toBe('key123');
    expect(result.projectId).toBe('12345');
    expect(result.organization).toBe('myorg');
    expect(result.host).toBe('myorg.ingest.sentry.io');
  });

  it('throws on invalid DSN', () => {
    expect(() => parseDSN('not-a-url')).toThrow('Invalid Sentry DSN');
  });

  it('handles self-hosted DSN', () => {
    const result = parseDSN('https://key@sentry.company.com/5');
    expect(result.key).toBe('key');
    expect(result.projectId).toBe('5');
    // No org match for non-standard host
    expect(result.organization).toBe('');
  });
});
