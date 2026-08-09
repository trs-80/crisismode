// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Regression: the response budget for `crisismode ask "<question>"`, and the
 * truncation signal that keeps a cut-off answer from being presented as a
 * complete one.
 *
 * This call site was left at max_tokens=1024 / 15s when the structured-JSON
 * budgets were fixed (see ai-response-budgets.test.ts), on the reasoning that it
 * does not parse its response so truncation is merely visible rather than
 * silent. Live measurement against claude-sonnet-5 on 2026-08-09 showed both
 * halves of that to be wrong:
 *
 *   - 1024 tokens truncated EVERY shape. Even "my postgres is slow" — the
 *     simplest and most common invocation — measured 1076-1151 output tokens.
 *   - 15s was below the measured latency of the widest payload (15.4-23.4s),
 *     so rich requests aborted and degraded to buildFallback().
 *   - Truncation is not reliably visible. Across 24 forced-truncation trials,
 *     2 of 20 truncated answers ended on a period and read as finished.
 *
 * Every fixture here is a verbatim live capture, so the token counts asserted
 * are measured facts. No test in this file touches the network.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as AnthropicSdk from '@anthropic-ai/sdk';

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

vi.mock('../framework/network-profile.js', () => ({
  getNetworkProfile: vi.fn(() => null),
  isInternetAvailable: vi.fn(() => true),
}));

import { universalAiDiagnosis } from '../framework/ai-diagnosis-universal.js';

const OLD_MAX_TOKENS = 1024;
const OLD_TIMEOUT_MS = 15_000;

/**
 * Verbatim claude-sonnet-5 answer to `ask "my postgres is slow"` (captured
 * 2026-08-09, max_tokens=8192). The API reported usage.output_tokens = 1076 with
 * stop_reason=end_turn — past the old 1024 ceiling, so the CLI's single most
 * common question could never return a whole answer.
 */
const QUESTION_ONLY_RESPONSE = `# PostgreSQL Slowness — Triage

**Urgency: HIGH** (until diagnosed — could escalate to CRITICAL if connections are maxing out)

## Step 1: Check what's actually blocking you (30 seconds)

\`\`\`sql
-- Active queries and how long they've been running
SELECT pid, now() - query_start AS duration, state, wait_event_type, wait_event, query
FROM pg_stat_activity
WHERE state != 'idle'
ORDER BY duration DESC
LIMIT 20;
\`\`\`

Look for:
- **Long-running queries** (duration > seconds/minutes) → likely culprit
- **\`wait_event_type = 'Lock'\`** → blocking chain, go to Step 2
- **Many rows with same query** → connection pool exhaustion or app bug

## Step 2: Check for lock contention

\`\`\`sql
SELECT blocked_locks.pid AS blocked_pid,
       blocking_locks.pid AS blocking_pid,
       blocked_activity.query AS blocked_query,
       blocking_activity.query AS blocking_query
FROM pg_catalog.pg_locks blocked_locks
JOIN pg_catalog.pg_locks blocking_locks
  ON blocking_locks.locktype = blocked_locks.locktype
  AND blocking_locks.pid != blocked_locks.pid
JOIN pg_catalog.pg_stat_activity blocked_activity ON blocked_activity.pid = blocked_locks.pid
JOIN pg_catalog.pg_stat_activity blocking_activity ON blocking_activity.pid = blocking_locks.pid
WHERE NOT blocked_locks.granted;
\`\`\`

If you find a blocker, kill it: \`SELECT pg_cancel_backend(<blocking_pid>);\` (or \`pg_terminate_backend\` if cancel doesn't work).

## Step 3: Connection saturation

\`\`\`sql
SELECT count(*), state FROM pg_stat_activity GROUP BY state;
SHOW max_connections;
\`\`\`
If \`count(*)\` is near \`max_connections\` → you're connection-starved. Restart app pool or bump \`max_connections\` (requires restart).

## Step 4: Check for bloat / missing autovacuum

\`\`\`sql
SELECT relname, n_dead_tup, n_live_tup, last_autovacuum
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC LIMIT 10;
\`\`\`
High \`n_dead_tup\` and stale \`last_autovacuum\` → manually run \`VACUUM ANALYZE <table>;\` on worst offenders.

## Step 5: Check disk I/O / CPU on host

\`\`\`bash
iostat -x 2
top
\`\`\`
If disk \`%util\` is pegged → I/O bound, check for competing processes or undersized storage.

## Step 6: Check for missing indexes on slow queries

\`\`\`sql
EXPLAIN ANALYZE <your slow query>;
\`\`\`
Look for \`Seq Scan\` on large tables.

---

**Tell me what you find in Step 1 and I'll narrow it down further** (lock contention vs. resource exhaustion vs. bad query plan all have different fixes).`;

/** usage.output_tokens for QUESTION_ONLY_RESPONSE, stop_reason=end_turn. */
const QUESTION_ONLY_TOKENS = 1076;

/**
 * The widest payload callAi assembles (question + health + diagnosis + sentry).
 * Measured over 6 reps: 1285-1891 output tokens, 15.4-23.4s.
 */
const WIDEST_MEASURED_TOKENS = 1891;
const WIDEST_MEASURED_MS = 23_400;

/**
 * Verbatim tail of the SAME question asked with max_tokens=1024, the production
 * value before this fix. The API returned stop_reason=max_tokens at exactly 1024
 * output tokens, cutting mid-word ("...or bl" — "blocked"). This is what the
 * operator actually saw.
 */
const TRUNCATED_AT_1024 = `## 5. System-level
\`\`\`bash
# CPU/IO/mem pressure
top -o %CPU
iostat -x 5
# disk full = silent killer
df -h $PGDATA
\`\`\`

## 6. Missing indexes / bad plans
On the specific slow query:
\`\`\`sql
EXPLAIN (ANALYZE, BUFFERS) <your query>;
\`\`\`
Look for \`Seq Scan\` on large tables or \`Rows Removed by Filter\` >> rows returned.

---
**Escalate to CRITICAL if:** disk >90% full, connections maxed, or bl`;

/**
 * Verbatim tail of a truncated Kafka answer (stop_reason=max_tokens at a 700
 * ceiling). This is the dangerous case: it ends on a period, mid-list, and reads
 * like a finished thought. One of 2 such cases in 20 truncated trials.
 */
const TRUNCATED_BUT_READS_FINISHED = `- Check if lag is uniform across partitions or skewed to a few:
\`\`\`bash
kafka-consumer-groups.sh --describe --group <group>
\`\`\`
- Disk I/O saturation on brokers can slow fetch responses.`;

/** Resolve after `ms`, honoring the abort signal the way the real SDK does. */
function respondAfter(ms: number, text: string, stopReason = 'end_turn') {
  return (_params: unknown, opts: { signal: AbortSignal }) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => resolve({ content: [{ type: 'text', text }], stop_reason: stopReason }),
        ms,
      );
      opts.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('Request was aborted.'));
      });
    });
}

function reply(text: string, stopReason = 'end_turn') {
  return { content: [{ type: 'text', text }], stop_reason: stopReason };
}

describe('universalAiDiagnosis response budget', () => {
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

  it('asks for more tokens than the widest measured payload needs', async () => {
    createMock.mockResolvedValue(reply(QUESTION_ONLY_RESPONSE));

    await universalAiDiagnosis({ question: 'my postgres is slow' });

    const [params] = createMock.mock.calls[0]!;
    expect(params.max_tokens).toBeGreaterThanOrEqual(WIDEST_MEASURED_TOKENS);
  });

  it('would have truncated even the simplest question at the old 1024 ceiling', () => {
    // Not a behavioral assertion — a measured fact about the fixture, and the
    // reason this call site could not be left alone. The shortest real answer
    // this prompt produces already exceeds the budget it used to be given.
    expect(QUESTION_ONLY_TOKENS).toBeGreaterThan(OLD_MAX_TOKENS);
  });

  it('waits past the old 15s deadline for a request that really takes 23.4s', async () => {
    vi.useFakeTimers();
    createMock.mockImplementation(respondAfter(WIDEST_MEASURED_MS, QUESTION_ONLY_RESPONSE));

    const pending = universalAiDiagnosis({ question: 'why is redis slow?' });
    await vi.advanceTimersByTimeAsync(WIDEST_MEASURED_MS);

    expect(WIDEST_MEASURED_MS).toBeGreaterThan(OLD_TIMEOUT_MS);
    expect((await pending).source).toBe('ai');
  });

  it('still gives up before the 60s non-interactive bound, because a human typed the command', async () => {
    vi.useFakeTimers();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    createMock.mockImplementation(respondAfter(55_000, QUESTION_ONLY_RESPONSE));

    const pending = universalAiDiagnosis({ question: 'my postgres is slow' });
    await vi.advanceTimersByTimeAsync(55_000);

    // 55s is past this call site's deadline: the operator gets guidance rather
    // than a terminal that sits there for a full minute.
    expect((await pending).source).toBe('fallback');
    consoleSpy.mockRestore();
  });

  it('reports a complete answer as not truncated', async () => {
    createMock.mockResolvedValue(reply(QUESTION_ONLY_RESPONSE, 'end_turn'));

    const result = await universalAiDiagnosis({ question: 'my postgres is slow' });

    expect(result.source).toBe('ai');
    expect(result.truncated).toBe(false);
  });

  it('flags a truncated answer instead of passing it off as whole', async () => {
    createMock.mockResolvedValue(reply(TRUNCATED_AT_1024, 'max_tokens'));

    const result = await universalAiDiagnosis({ question: 'my postgres is slow' });

    expect(result.source).toBe('ai');
    expect(result.truncated).toBe(true);
    // The content is still returned — a partial answer beats no answer, as long
    // as the caller is told which one it has.
    expect(result.response).toContain('Missing indexes');
  });

  it('flags truncation even when the cut-off answer reads as finished', async () => {
    createMock.mockResolvedValue(reply(TRUNCATED_BUT_READS_FINISHED, 'max_tokens'));

    const result = await universalAiDiagnosis({ question: 'kafka consumer lag keeps growing' });

    // This is the case a text heuristic cannot catch, and the reason the fix
    // reads stop_reason instead: the response ends on a period, mid-list, and
    // looks like a complete final bullet.
    expect(/[.!?]$/.test(result.response)).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it('never marks a locally built fallback as truncated', async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const result = await universalAiDiagnosis({ question: 'my postgres is slow' });

    expect(result.source).toBe('fallback');
    expect(result.truncated).toBe(false);
  });

  it('reports a timeout as a fallback rather than an empty answer', async () => {
    vi.useFakeTimers();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    createMock.mockImplementation(respondAfter(90_000, QUESTION_ONLY_RESPONSE));

    const pending = universalAiDiagnosis({ question: 'my postgres is slow' });
    await vi.advanceTimersByTimeAsync(90_000);
    const result = await pending;

    expect(result.source).toBe('fallback');
    expect(result.truncated).toBe(false);
    expect(consoleSpy.mock.calls.flat().join(' ')).toMatch(/timed out/);
    consoleSpy.mockRestore();
  });
});
