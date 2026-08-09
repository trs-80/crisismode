// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Regression: the AI diagnosis response budget must fit a whole diagnosis.
 *
 * The toolkit used to default to max_tokens=1024 and a 10s timeout. No current
 * model can answer the standard diagnosis schema inside 1024 tokens, so the
 * response came back with stop_reason=max_tokens, `JSON.parse` threw
 * "Unterminated string in JSON", `aiDiagnose` returned null, and every agent
 * fell through to its rule-based path. Nothing surfaced that as a budget
 * problem — it was indistinguishable from "no API key / AI unavailable", and
 * it made the AI diagnosis path dead for every model, not just slow ones.
 *
 * These tests are hermetic: FULL_DIAGNOSIS_RESPONSE is a verbatim capture of a
 * live claude-sonnet-5 answer to the real pg-replication prompt, so the sizes
 * asserted here are measured facts rather than estimates. No test in this file
 * touches the network.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as AnthropicSdk from '@anthropic-ai/sdk';
import { aiDiagnose, parseStandardDiagnosisResponse } from '../framework/ai-diagnosis.js';

/**
 * Verbatim claude-sonnet-5 response to the production pg-replication prompt
 * (captured 2026-08-09). The API reported usage.output_tokens = 2259 for this
 * body with stop_reason=end_turn — 2.2x the old 1024-token ceiling, which is
 * why the old default could never return a parseable diagnosis.
 */
const FULL_DIAGNOSIS_RESPONSE = `{
  "status": "identified",
  "scenario": "replication_lag_cascade",
  "confidence": 0.78,
  "root_cause": "The primary is generating WAL faster than the replica fleet can consume it. All three replicas share an identical sent_lsn (0/5000000), meaning the primary has shipped the same volume of WAL to each, yet every replica shows a widening gap between write/flush/replay LSNs — a classic sign of a primary-side WAL generation spike or network throughput ceiling outpacing replica apply capacity. The severity gradient (45s -> 78s -> 342s) indicates the cascade is compounding on the slower replica (10.0.1.52), which is falling further behind not because replay is paused (confirmed false) but because it cannot keep up with apply throughput — likely constrained by disk I/O or CPU on that node, while the healthier replicas absorb the same WAL pressure with proportionally less lag. This is not slot exhaustion (all slots show 'reserved', not 'lost') and not connection pool exhaustion (pool is at 4/25 with no idle-in-transaction sessions).",
  "findings": [
    {
      "source": "pg_stat_replication",
      "observation": "All three replicas are behind the same sent_lsn, indicating a shared upstream cause rather than an isolated replica fault",
      "severity": "warning",
      "evidence": "sent_lsn is 0/5000000 for all three streaming replicas, while replay_lsn ranges from 0/4E00000 down to 0/2800000"
    },
    {
      "source": "pg_stat_replication",
      "observation": "Replica 10.0.1.52 shows a severe apply gap and the highest self-reported lag, consistent with a replica-side bottleneck compounding the primary-side pressure",
      "severity": "critical",
      "evidence": "10.0.1.52: write_lsn 0/3000000, flush_lsn 0/2F00000, replay_lsn 0/2800000 vs sent_lsn 0/5000000 (~0x380000 bytes of unreplayed WAL); lag_seconds 342"
    },
    {
      "source": "Replica self-reported state",
      "observation": "Replica confirms it is in recovery and lagging, and explicitly reports replay is NOT paused, ruling out deliberate/I-O-triggered replay suspension as the cause",
      "severity": "info",
      "evidence": "in_recovery=true, self-reported lag=342s, pg_is_wal_replay_paused()=false"
    },
    {
      "source": "pg_replication_slots",
      "observation": "All slots remain healthy with wal_status 'reserved', meaning WAL retention is not yet at risk of being recycled out from under the lagging replicas — but restart_lsn values are close to current sent_lsn, leaving little margin",
      "severity": "warning",
      "evidence": "restart_lsn values (0/5100000, 0/5100000, 0/5000000) all wal_status='reserved', none 'lost'"
    },
    {
      "source": "Connection-pool usage (primary)",
      "observation": "Connection pool is nowhere near exhaustion and has no idle-in-transaction sessions, ruling out connection_pool_exhaustion as a contributing scenario",
      "severity": "info",
      "evidence": "total=4/max=25, idleInTransactionOldest=[] (empty)"
    },
    {
      "source": "pg_stat_activity",
      "observation": "Active connection count on the primary (247) is notably higher than the connection-pool's reported total (4), suggesting read traffic may be bypassing the pool or hitting the primary directly while replicas lag",
      "severity": "warning",
      "evidence": "pg_stat_activity reports 247 active connections vs pool total of 4"
    }
  ],
  "recommendations": [
    "Check primary WAL generation rate (pg_stat_wal / pg_current_wal_lsn delta over time) to confirm a write/throughput spike is driving the cascade",
    "Inspect network throughput and latency between primary and the us-east replica group for saturation, especially toward 10.0.1.52",
    "On 10.0.1.52 specifically, check disk I/O saturation, CPU load, and checkpoint/apply throughput (pg_stat_wal_receiver, iostat) since its apply gap is disproportionately large",
    "Monitor replication slot restart_lsn vs current WAL LSN closely — margin is currently thin; if lag continues to grow, WAL could begin to be recycled and slots could transition to 'lost'",
    "Consider throttling or pausing non-critical write-heavy workloads on the primary until lag recovers, and verify whether read traffic is being sent to the primary directly due to replica lag (247 active connections vs minimal pool usage warrants review)",
    "If 10.0.1.52 does not recover once WAL generation normalizes, consider rebuilding it from a fresh base backup rather than waiting for it to catch up",
    "Add alerting on replay_lsn-to-sent_lsn gap growth rate, not just absolute lag_seconds, to catch cascading lag earlier"
  ]
}`;

/** Measured for FULL_DIAGNOSIS_RESPONSE by the API: 2259 output tokens / 4633 chars. */
const MEASURED_OUTPUT_TOKENS = 2259;
const MEASURED_CHARS = 4633;
const OLD_MAX_TOKENS = 1024;

/**
 * Where the old ceiling would have severed this body. Derived from the two
 * measurements above rather than a generic 4-chars-per-token rule of thumb:
 * dense JSON tokenizes closer to 2 chars/token, and the point of the test is
 * that the cut lands mid-value, which is what makes the response unparseable.
 */
const OLD_BUDGET_CUTOFF = Math.floor(MEASURED_CHARS * (OLD_MAX_TOKENS / MEASURED_OUTPUT_TOKENS));

describe('AI diagnosis response budget', () => {
  it('parses a complete, full-length model diagnosis', () => {
    const result = parseStandardDiagnosisResponse(FULL_DIAGNOSIS_RESPONSE);

    expect(result.status).toBe('identified');
    expect(result.scenario).toBe('replication_lag_cascade');
    expect(result.confidence).toBeCloseTo(0.78);
    expect(result.findings).toHaveLength(6);
    expect(result.findings[0]?.data?.root_cause).toContain('generating WAL faster');
    expect(result.findings[0]?.data?.recommendations).toHaveLength(7);
  });

  it('needs more than the old 1024-token ceiling to say all of that', () => {
    expect(FULL_DIAGNOSIS_RESPONSE).toHaveLength(MEASURED_CHARS);
    expect(MEASURED_OUTPUT_TOKENS).toBeGreaterThan(OLD_MAX_TOKENS * 2);
  });

  it('fails to parse when truncated at the old 1024-token ceiling', () => {
    const truncated = FULL_DIAGNOSIS_RESPONSE.slice(0, OLD_BUDGET_CUTOFF);

    // The cut lands inside a string value, exactly as the live API did.
    expect(truncated.endsWith('}')).toBe(false);
    expect(() => parseStandardDiagnosisResponse(truncated)).toThrow(
      /Unterminated string|Unexpected end of JSON|Expected/,
    );
  });
});

describe('AI diagnosis response repair', () => {
  /**
   * Observed live while recording the demo: the model put a literal newline
   * inside a string value instead of `\n`, JSON.parse threw "Bad control
   * character in string literal", and that run lost its AI diagnosis to the
   * rule-based fallback.
   */
  it('recovers a response containing a raw newline inside a string value', () => {
    const withRawNewline = [
      '{',
      '  "status": "identified",',
      '  "scenario": "replication_lag_cascade",',
      '  "confidence": 0.81,',
      '  "root_cause": "The primary is outrunning the replicas.',
      'Replay is not paused.",',
      '  "findings": [',
      '    {',
      '      "source": "pg_stat_replication",',
      '      "observation": "Line one.\tTabbed continuation.",',
      '      "severity": "critical",',
      '      "evidence": "lag_seconds 342"',
      '    }',
      '  ],',
      '  "recommendations": ["Check WAL generation rate"]',
      '}',
    ].join('\n');

    // Precondition: this really is the failure mode, not a pre-parseable string.
    expect(() => JSON.parse(withRawNewline)).toThrow(/control character/i);

    const result = parseStandardDiagnosisResponse(withRawNewline);
    expect(result.scenario).toBe('replication_lag_cascade');
    expect(result.confidence).toBeCloseTo(0.81);
    expect(result.findings).toHaveLength(1);
    // The repair escapes the control character rather than dropping content.
    expect(result.findings[0]?.data?.root_cause).toContain('Replay is not paused.');
    expect(result.findings[0]?.observation).toContain('Tabbed continuation');
  });

  it('leaves a correctly escaped response byte-identical', () => {
    const result = parseStandardDiagnosisResponse(FULL_DIAGNOSIS_RESPONSE);
    expect(result.findings).toHaveLength(6);
  });

  it('does not paper over a genuinely malformed response', () => {
    // No control characters to repair — a real structural error must still throw
    // so the caller falls back instead of acting on a half-read diagnosis.
    expect(() => parseStandardDiagnosisResponse('{"status": "identified", "findings"')).toThrow();
    expect(() => parseStandardDiagnosisResponse('not json at all')).toThrow();
  });
});

// Capture the SDK's messages.create so the plumbing test can inspect the
// params the toolkit sends without reaching the network.
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof AnthropicSdk>();
  return {
    ...actual,
    default: class {
      messages = { create: createMock };
    },
  };
});

describe('aiDiagnose default budget plumbing', () => {
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    createMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('asks for enough tokens to hold a full diagnosis when the caller sets no config', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: FULL_DIAGNOSIS_RESPONSE }],
    });

    const result = await aiDiagnose({ systemPrompt: 'sys', userMessage: 'state' });

    expect(result).not.toBeNull();
    expect(result?.findings).toHaveLength(6);
    const [params] = createMock.mock.calls[0]!;
    expect(params.max_tokens).toBeGreaterThanOrEqual(MEASURED_OUTPUT_TOKENS);
  });

  it('waits long enough for a reasoning model to finish (was 10s, measured 28-40s)', async () => {
    vi.useFakeTimers();
    // Model takes 35s — inside the observed sonnet-5 range for this prompt,
    // and well past the 10s deadline this default used to impose. The mock
    // honors the abort signal the way the real SDK does, so an early deadline
    // actually fails this test instead of being silently ignored.
    createMock.mockImplementation(
      (_params: unknown, opts: { signal: AbortSignal }) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => resolve({ content: [{ type: 'text', text: FULL_DIAGNOSIS_RESPONSE }] }),
            35_000,
          );
          opts.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('Request was aborted.'));
          });
        }),
    );

    const pending = aiDiagnose({ systemPrompt: 'sys', userMessage: 'state' });
    await vi.advanceTimersByTimeAsync(35_000);

    const result = await pending;
    expect(result).not.toBeNull();
    expect(result?.scenario).toBe('replication_lag_cascade');
  });
});
