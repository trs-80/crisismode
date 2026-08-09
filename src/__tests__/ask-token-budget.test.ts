// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Regression: the `ask` REPL's per-turn response budget, and the truncation
 * notice both `ask` modes now print.
 *
 * The REPL was left at max_tokens=1024 / 30s. Measured against live
 * claude-sonnet-5 on 2026-08-09 with max_tokens=8192, using this module's real
 * system prompt and real accumulated history:
 *
 *   turn 1, one short question                      543-684 tokens    6.7-11.9s
 *   turn 4, pasted pg output + "full remediation
 *     sequence with rollback, in order"            1817-2339 tokens  19.6-26.6s
 *   turn 9 of a long session, "write me the
 *     complete runbook for the next shift"         2724-3638 tokens  29.0-37.1s
 *
 * Answers grow with the conversation, so only the first turn ever fit in 1024 —
 * and the long-session runbook, the most valuable output this REPL produces,
 * exceeded BOTH the token ceiling and the 30s deadline at once.
 *
 * No test in this file touches the network.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as AnthropicSdk from '@anthropic-ai/sdk';
import type * as NodeFs from 'node:fs';

const { createMock, lines } = vi.hoisted(() => ({
  createMock: vi.fn(),
  lines: { queue: [] as string[] },
}));

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

// Drive the REPL from a scripted line queue instead of stdin. `prompt` and
// `close` are no-ops; the async iterator is what the read loop consumes.
vi.mock('node:readline', () => ({
  createInterface: () => ({
    prompt: () => {},
    close: () => {},
    async *[Symbol.asyncIterator]() {
      for (const line of lines.queue) yield line;
    },
  }),
}));

// Keep the REPL hermetic: without this it would pick up a real
// ~/.crisismode/watch-state.json on a developer machine but not in CI.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return { ...actual, existsSync: () => false, default: { ...actual, existsSync: () => false } };
});

import { runAsk, runAskRepl } from '../cli/commands/ask.js';

const OLD_MAX_TOKENS = 1024;
const OLD_TIMEOUT_MS = 30_000;

/** Measured maximum for a long-session runbook request: 3638 tokens, 37.1s. */
const RUNBOOK_MEASURED_TOKENS = 3638;
const RUNBOOK_MEASURED_MS = 37_100;

/** Measured for turn 4 (pasted output + full remediation sequence). */
const TURN4_MEASURED_TOKENS = 2339;

/**
 * Verbatim shape of a truncated REPL answer that ends on a period and reads as
 * finished — the failure a text heuristic cannot detect. Captured at
 * stop_reason=max_tokens in the 24-trial truncation run.
 */
const TRUNCATED_BUT_READS_FINISHED =
  'Check whether the pooler is leaking connections:\n' +
  '```sql\nSELECT count(*), state FROM pg_stat_activity GROUP BY state;\n```\n' +
  '- If idle-in-transaction dominates (connection leak), restart the offending service/pod rather than the DB.';

const COMPLETE_ANSWER =
  'HIGH urgency. Start by separating "cannot keep up" from "cannot receive":\n' +
  '```sql\nSELECT client_addr, write_lag, replay_lag FROM pg_stat_replication;\n```\n' +
  'Report back what that shows and I will narrow it down.';

function reply(text: string, stopReason = 'end_turn') {
  return { content: [{ type: 'text', text }], stop_reason: stopReason };
}

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

describe('ask REPL response budget', () => {
  let originalApiKey: string | undefined;
  let logged: string[];

  beforeEach(() => {
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    createMock.mockReset();
    lines.queue = [];
    logged = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.join(' '));
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (originalApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('asks for more tokens than the longest measured REPL answer needs', async () => {
    lines.queue = ['my postgres replica is lagging', '/exit'];
    createMock.mockResolvedValue(reply(COMPLETE_ANSWER));

    await runAskRepl();

    const [params] = createMock.mock.calls[0]!;
    expect(params.max_tokens).toBeGreaterThanOrEqual(RUNBOOK_MEASURED_TOKENS);
    // And well past the ceiling that truncated every turn after the first.
    expect(params.max_tokens).toBeGreaterThan(OLD_MAX_TOKENS);
    expect(TURN4_MEASURED_TOKENS).toBeGreaterThan(OLD_MAX_TOKENS);
  });

  it('waits past the old 30s deadline for a runbook that really takes 37s', async () => {
    vi.useFakeTimers();
    lines.queue = ['write me the complete runbook for the next shift', '/exit'];
    createMock.mockImplementation(respondAfter(RUNBOOK_MEASURED_MS, COMPLETE_ANSWER));

    const pending = runAskRepl();
    await vi.advanceTimersByTimeAsync(RUNBOOK_MEASURED_MS);
    await pending;

    expect(RUNBOOK_MEASURED_MS).toBeGreaterThan(OLD_TIMEOUT_MS);
    expect(logged.join('\n')).toContain('HIGH urgency');
  });

  it('reports an honest timeout rather than hanging an operator indefinitely', async () => {
    vi.useFakeTimers();
    lines.queue = ['write me an exhaustive runbook', '/exit'];
    createMock.mockImplementation(respondAfter(90_000, COMPLETE_ANSWER));

    const pending = runAskRepl();
    await vi.advanceTimersByTimeAsync(90_000);
    await pending;

    // printWarning goes through console.log, so the REPL's error branch is here.
    expect(logged.join('\n')).toMatch(/timed out after 45000ms/);
  });

  it('tells the operator when a REPL answer is cut off', async () => {
    lines.queue = ['give me the full remediation sequence', '/exit'];
    createMock.mockResolvedValue(reply(TRUNCATED_BUT_READS_FINISHED, 'max_tokens'));

    await runAskRepl();
    const out = logged.join('\n');

    // The answer ends on a period and reads as complete — nothing in the text
    // marks it as partial, so the notice is the only signal the operator gets.
    expect(TRUNCATED_BUT_READS_FINISHED.endsWith('.')).toBe(true);
    expect(out).toContain('cut off');
    expect(out).toContain('continue');
  });

  it('stays quiet about truncation when the answer is complete', async () => {
    lines.queue = ['my postgres replica is lagging', '/exit'];
    createMock.mockResolvedValue(reply(COMPLETE_ANSWER, 'end_turn'));

    await runAskRepl();

    expect(logged.join('\n')).not.toContain('cut off');
  });

  it('keeps a truncated answer in history so "continue" has something to resume', async () => {
    lines.queue = ['give me the full remediation sequence', 'continue', '/exit'];
    createMock
      .mockResolvedValueOnce(reply(TRUNCATED_BUT_READS_FINISHED, 'max_tokens'))
      .mockResolvedValueOnce(reply('...and then restart the pooler.', 'end_turn'));

    await runAskRepl();

    const [secondParams] = createMock.mock.calls[1]!;
    const assistantTurns = secondParams.messages.filter(
      (m: { role: string }) => m.role === 'assistant',
    );
    expect(assistantTurns).toHaveLength(1);
    expect(assistantTurns[0].content).toBe(TRUNCATED_BUT_READS_FINISHED);
  });
});

describe('ask single-shot truncation notice', () => {
  let originalApiKey: string | undefined;
  let logged: string[];

  beforeEach(() => {
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    createMock.mockReset();
    logged = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('says the answer is cut off instead of printing it as if it were whole', async () => {
    createMock.mockResolvedValue(reply(TRUNCATED_BUT_READS_FINISHED, 'max_tokens'));

    await runAsk('my database connections are maxed out');
    const out = logged.join('\n');

    expect(out).toContain(TRUNCATED_BUT_READS_FINISHED);
    expect(out).toContain('cut off');
    expect(out).toContain('narrower');
  });

  it('prints nothing extra for a complete answer', async () => {
    createMock.mockResolvedValue(reply(COMPLETE_ANSWER, 'end_turn'));

    await runAsk('my postgres replica is lagging');
    const out = logged.join('\n');

    expect(out).toContain('HIGH urgency');
    expect(out).not.toContain('cut off');
  });
});
