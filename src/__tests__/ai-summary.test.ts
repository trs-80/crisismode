// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configure, printPlainEnglishSummary } from '../cli/output.js';
import type { IncidentSummary } from '../cli/incident-summary.js';
import type { RecentChange } from '../cli/output.js';
import type { PlainEnglishSummary } from '../cli/ai-summary.js';

function makeIncidentSummary(overrides?: Partial<IncidentSummary>): IncidentSummary {
  return {
    timestamp: '2026-04-04T12:00:00.000Z',
    score: 60,
    headline: '1 service unhealthy out of 3 checked (score: 60/100)',
    critical: [
      { id: 'PG-001', service: 'postgresql (detected-postgresql)', status: 'unhealthy', summary: 'Replication lag at 45s' },
    ],
    warning: [
      { id: 'REDIS-001', service: 'redis (detected-redis)', status: 'recovering', summary: 'Memory pressure elevated' },
    ],
    healthy: [
      { id: 'DNS-001', service: 'dns (local-dns)', status: 'healthy', summary: 'All DNS lookups OK' },
    ],
    nextSteps: ['Investigate: `crisismode diagnose PG-001`'],
    durationMs: 1200,
    ...overrides,
  };
}

function makeRecentChanges(): RecentChange[] {
  return [
    { type: 'deploy', description: 'postgresql (detected-postgresql): new image deployed', detectedAt: '2026-04-04T11:55:00.000Z' },
  ];
}

// Mock the network profile module
vi.mock('../framework/network-profile.js', () => ({
  getNetworkProfile: vi.fn(() => ({
    mode: 'full',
    internet: { status: 'available', probes: [] },
    hub: { status: 'unknown' },
    dns: { available: true, latencyMs: 5 },
    targets: { probes: [] },
  })),
  isInternetAvailable: vi.fn(() => true),
}));

describe('AI summary — fallback behavior', () => {
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (originalApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('returns fallback when no API key is set', async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const { generatePlainEnglishSummary } = await import('../cli/ai-summary.js');
    const summary = makeIncidentSummary();
    const result = await generatePlainEnglishSummary(summary, []);

    expect(result.source).toBe('fallback');
    expect(result.text).toContain('postgresql');
  });

  it('fallback text includes service names, count, and next step', async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const { buildFallbackSummary } = await import('../cli/ai-summary.js');
    const summary = makeIncidentSummary();
    const result = buildFallbackSummary(summary);

    expect(result.source).toBe('fallback');
    expect(result.text).toContain('3 services');
    expect(result.text).toContain('postgresql');
    expect(result.text).toContain('crisismode diagnose');
  });

  it('fallback for all-healthy shows healthy message', async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const { buildFallbackSummary } = await import('../cli/ai-summary.js');
    const summary = makeIncidentSummary({
      score: 100,
      headline: 'All 2 services healthy (score: 100/100)',
      critical: [],
      warning: [],
      healthy: [
        { id: 'DNS-001', service: 'dns (local-dns)', status: 'healthy', summary: 'OK' },
        { id: 'DISK-001', service: 'disk (local-disk)', status: 'healthy', summary: 'OK' },
      ],
      nextSteps: ['All systems healthy. Monitor with: `crisismode watch`'],
    });
    const result = buildFallbackSummary(summary);

    expect(result.source).toBe('fallback');
    expect(result.text).toContain('All services are healthy');
  });
});

describe('AI summary — AI path with mocked SDK', () => {
  let originalApiKey: string | undefined;

  const mockCreate = vi.fn().mockResolvedValue({
    content: [{ type: 'text', text: 'Your PostgreSQL database has high replication lag.' }],
  });

  beforeEach(() => {
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key-123';

    vi.doMock('@anthropic-ai/sdk', () => ({
      default: class MockAnthropic {
        messages = { create: mockCreate };
      },
    }));

    mockCreate.mockClear();
  });

  afterEach(() => {
    if (originalApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
    vi.doUnmock('@anthropic-ai/sdk');
  });

  it('calls Claude with correct model and parameters', async () => {
    const { generatePlainEnglishSummary } = await import('../cli/ai-summary.js');
    const summary = makeIncidentSummary();
    const result = await generatePlainEnglishSummary(summary, makeRecentChanges());

    expect(result.source).toBe('ai');
    expect(result.text).toContain('PostgreSQL');

    expect(mockCreate).toHaveBeenCalledOnce();
    const [callArgs] = mockCreate.mock.calls[0];
    expect(callArgs.model).toBe('claude-sonnet-4-20250514');
    expect(callArgs.max_tokens).toBe(512);
    expect(callArgs.system).toContain('friendly infrastructure assistant');
  });
});

describe('AI summary — error handling', () => {
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key-123';
  });

  afterEach(() => {
    if (originalApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
    vi.doUnmock('@anthropic-ai/sdk');
  });

  it('returns fallback when SDK throws', async () => {
    vi.doMock('@anthropic-ai/sdk', () => ({
      default: class MockAnthropic {
        messages = {
          create: vi.fn().mockRejectedValue(new Error('API rate limit')),
        };
      },
    }));

    const { generatePlainEnglishSummary } = await import('../cli/ai-summary.js');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const summary = makeIncidentSummary();
    const result = await generatePlainEnglishSummary(summary, []);

    expect(result.source).toBe('fallback');
    expect(result.text).toContain('postgresql');

    errSpy.mockRestore();
  });

  it('returns fallback on timeout (SDK never resolves)', async () => {
    // Mock SDK that respects the abort signal
    vi.doMock('@anthropic-ai/sdk', () => ({
      default: class MockAnthropic {
        messages = {
          create: vi.fn().mockImplementation((_args: unknown, opts: { signal?: AbortSignal }) => {
            return new Promise((_resolve, reject) => {
              if (opts?.signal) {
                opts.signal.addEventListener('abort', () => {
                  reject(new Error('Request was aborted'));
                });
              }
            });
          }),
        };
      },
    }));

    const { generatePlainEnglishSummary } = await import('../cli/ai-summary.js');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const summary = makeIncidentSummary();
    const result = await generatePlainEnglishSummary(summary, []);

    expect(result.source).toBe('fallback');

    errSpy.mockRestore();
  }, 15_000);
});

describe('printPlainEnglishSummary', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    configure({ json: false, noColor: false, verbose: false });
  });

  it('prints summary with header in human mode', () => {
    configure({ mode: 'human', noColor: true, json: false, verbose: false });

    const summary: PlainEnglishSummary = {
      text: 'Your database is healthy and all services are running.',
      source: 'ai',
    };

    printPlainEnglishSummary(summary);

    const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('Summary');
    expect(output).toContain('Your database is healthy');
    expect(output).toContain('AI-generated');
  });

  it('prints fallback source indicator', () => {
    configure({ mode: 'human', noColor: true, json: false, verbose: false });

    const summary: PlainEnglishSummary = {
      text: 'Scanned 3 services.',
      source: 'fallback',
    };

    printPlainEnglishSummary(summary);

    const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('auto-generated');
  });

  it('skips output in pipe mode', () => {
    configure({ mode: 'pipe', noColor: true, json: false, verbose: false });

    const summary: PlainEnglishSummary = {
      text: 'Some summary text.',
      source: 'fallback',
    };

    printPlainEnglishSummary(summary);

    expect(logSpy).not.toHaveBeenCalled();
  });

  it('skips output in machine mode', () => {
    configure({ mode: 'machine', noColor: true, json: true, verbose: false });

    const summary: PlainEnglishSummary = {
      text: 'Some summary text.',
      source: 'ai',
    };

    printPlainEnglishSummary(summary);

    expect(logSpy).not.toHaveBeenCalled();
  });
});
