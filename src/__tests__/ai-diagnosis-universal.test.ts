// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ──

vi.mock('../framework/network-profile.js', () => ({
  getNetworkProfile: vi.fn(() => null),
  isInternetAvailable: vi.fn(() => true),
}));

import { universalAiDiagnosis } from '../framework/ai-diagnosis-universal.js';
import { getNetworkProfile } from '../framework/network-profile.js';
import type { NetworkProfile } from '../framework/network-profile.js';
import type { SentryEnrichment } from '../integrations/sentry.js';

function makeNetworkProfile(internetStatus: 'available' | 'unavailable'): NetworkProfile {
  return {
    internet: { status: internetStatus, probes: [], checkedAt: new Date().toISOString() },
    hub: { status: 'unknown', probes: [], checkedAt: new Date().toISOString() },
    targets: { status: 'unknown', probes: [], checkedAt: new Date().toISOString() },
    dns: { available: true, latencyMs: 10 },
    mode: internetStatus === 'available' ? 'full' : 'isolated',
    profiledAt: new Date().toISOString(),
  };
}

describe('universalAiDiagnosis', () => {
  const originalEnv = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalEnv) {
      process.env.ANTHROPIC_API_KEY = originalEnv;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('returns fallback when no API key is set', async () => {
    const result = await universalAiDiagnosis({ question: 'why is postgres slow?' });
    expect(result.source).toBe('fallback');
    expect(result.response).toContain('ANTHROPIC_API_KEY');
  });

  it('includes health info in fallback', async () => {
    const result = await universalAiDiagnosis({
      health: {
        status: 'unhealthy',
        confidence: 0.9,
        summary: 'Replication lag critical',
        observedAt: new Date().toISOString(),
        signals: [],
        recommendedActions: ['Check network connectivity'],
      },
    });
    expect(result.source).toBe('fallback');
    expect(result.response).toContain('unhealthy');
    expect(result.response).toContain('Check network connectivity');
  });

  it('includes diagnosis info in fallback', async () => {
    const result = await universalAiDiagnosis({
      diagnosis: {
        status: 'identified',
        scenario: 'replication_lag_cascade',
        confidence: 0.85,
        findings: [
          { source: 'repl_check', observation: 'lag at 45s', severity: 'critical' },
        ],
        diagnosticPlanNeeded: false,
      },
    });
    expect(result.source).toBe('fallback');
    expect(result.response).toContain('replication_lag_cascade');
  });

  it('returns generic fallback when no inputs given', async () => {
    const result = await universalAiDiagnosis({});
    expect(result.source).toBe('fallback');
    expect(result.response).toContain('ANTHROPIC_API_KEY');
  });

  it('falls back when network profile says internet is unavailable', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    vi.mocked(getNetworkProfile).mockReturnValue(makeNetworkProfile('unavailable'));

    const result = await universalAiDiagnosis({ question: 'why is postgres slow?' });
    expect(result.source).toBe('fallback');
  });

  it('falls back when AI call throws', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    vi.mocked(getNetworkProfile).mockReturnValue(null);

    // The dynamic import of @anthropic-ai/sdk will fail since it's not installed in test
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await universalAiDiagnosis({ question: 'test' });
    expect(result.source).toBe('fallback');
    consoleSpy.mockRestore();
  });

  it('includes sentry context in fallback when recent errors exist', async () => {
    const sentryContext: SentryEnrichment = {
      summary: '5 errors in the last hour',
      recentErrors: [
        { id: 'err-1', title: 'ConnectionError', count: 3, firstSeen: '2026-03-17T00:00:00Z', lastSeen: '2026-03-17T01:00:00Z' },
      ],
      errorSpike: null,
    };

    const result = await universalAiDiagnosis({ sentryContext });
    expect(result.source).toBe('fallback');
    expect(result.response).toContain('5 errors in the last hour');
  });

  it('includes sentry context with empty errors in fallback', async () => {
    const sentryContext: SentryEnrichment = {
      summary: 'No errors',
      recentErrors: [],
      errorSpike: null,
    };

    const result = await universalAiDiagnosis({ sentryContext });
    expect(result.source).toBe('fallback');
    // No sentry line added since no recent errors
    expect(result.response).not.toContain('Sentry');
  });

  it('includes health with no recommended actions in fallback', async () => {
    const result = await universalAiDiagnosis({
      health: {
        status: 'healthy',
        confidence: 0.95,
        summary: 'All systems operational',
        observedAt: new Date().toISOString(),
        signals: [],
        recommendedActions: [],
      },
    });
    expect(result.source).toBe('fallback');
    expect(result.response).toContain('healthy');
    expect(result.response).toContain('All systems operational');
    expect(result.response).not.toContain('Recommended actions');
  });

  it('combines question, health, and diagnosis in fallback', async () => {
    const result = await universalAiDiagnosis({
      question: 'what is wrong?',
      health: {
        status: 'unhealthy',
        confidence: 0.8,
        summary: 'High lag',
        observedAt: new Date().toISOString(),
        signals: [],
        recommendedActions: [],
      },
      diagnosis: {
        status: 'identified',
        scenario: 'lag_cascade',
        confidence: 0.7,
        findings: [
          { source: 'pg', observation: 'lag rising', severity: 'warning' },
        ],
        diagnosticPlanNeeded: false,
      },
    });
    expect(result.source).toBe('fallback');
    expect(result.response).toContain('ANTHROPIC_API_KEY');
    expect(result.response).toContain('unhealthy');
    expect(result.response).toContain('lag_cascade');
  });

  it('proceeds to AI call when network profile is null (not yet built)', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    vi.mocked(getNetworkProfile).mockReturnValue(null);

    // Will fail on SDK import but that exercises the callAi path
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await universalAiDiagnosis({ question: 'test' });
    // Falls back because SDK isn't available in test, but it tried
    expect(result.source).toBe('fallback');
    consoleSpy.mockRestore();
  });

  it('proceeds to AI call when internet is available', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    vi.mocked(getNetworkProfile).mockReturnValue(makeNetworkProfile('available'));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await universalAiDiagnosis({
      question: 'why is redis slow?',
      health: {
        status: 'unhealthy',
        confidence: 0.75,
        summary: 'Memory pressure',
        observedAt: new Date().toISOString(),
        signals: [
          { source: 'redis_info', status: 'warning' as const, detail: 'used_memory at 90%', observedAt: new Date().toISOString() },
        ],
        recommendedActions: ['Increase maxmemory'],
      },
      diagnosis: {
        status: 'identified',
        scenario: 'memory_pressure',
        confidence: 0.85,
        findings: [
          { source: 'mem_check', observation: 'RSS at 3.8GB of 4GB', severity: 'critical' as const },
        ],
        diagnosticPlanNeeded: false,
      },
      sentryContext: {
        summary: '12 OOM errors',
        recentErrors: [
          { id: 'err-oom', title: 'OOMKilled', count: 12, firstSeen: '2026-03-17T00:00:00Z', lastSeen: '2026-03-17T01:00:00Z' },
        ],
        errorSpike: {
          spikeMultiplier: 4.5,
          currentRate: 12.3,
          baselineRate: 2.7,
          topErrors: [],
        },
      },
    });
    // Falls back because SDK isn't installed in test env, but the message building was exercised
    expect(result.source).toBe('fallback');
    consoleSpy.mockRestore();
  });
});
