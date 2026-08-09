// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Regression: `ask --json` must not present a cut-off answer as a complete one.
 *
 * The truncation notice both `ask` modes print goes through `printWarning` and
 * `printInfo`, which return early when the output mode is `machine`. The answer
 * itself went out through a bare `console.log`. So `--json` handed back a
 * partial answer with nothing marking it as partial — to the one consumer least
 * able to notice, since it cannot read the prose and judge for itself.
 *
 * The fix is a `{ type: 'ask', ... }` JSONL record carrying `truncated`, in the
 * same shape `down`, `triage`, and `readiness` emit via `jsonOut`. These tests
 * pin the field, pin that the whole machine stream stays parseable, and pin
 * that human mode still says exactly what it said before.
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

// Scripted line queue instead of stdin, as in ask-token-budget.test.ts.
vi.mock('node:readline', () => ({
  createInterface: () => ({
    prompt: () => {},
    close: () => {},
    async *[Symbol.asyncIterator]() {
      for (const line of lines.queue) yield line;
    },
  }),
}));

// Without this the REPL would read a real ~/.crisismode/watch-state.json on a
// developer machine but not in CI.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return { ...actual, existsSync: () => false, default: { ...actual, existsSync: () => false } };
});

import { runAsk, runAskRepl } from '../cli/commands/ask.js';
import { configure } from '../cli/output.js';

/**
 * A truncated answer that ends on a period and reads as finished — the case no
 * text heuristic can catch, and the reason `truncated` has to be carried
 * explicitly rather than inferred downstream.
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

interface AskRecord {
  type: string;
  question: string;
  answer: string;
  source: string;
  truncated: boolean;
}

describe('ask machine output', () => {
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
    vi.spyOn(console, 'error').mockImplementation(() => {});
    configure({ json: true });
  });

  afterEach(() => {
    // Module-level output state: leave it as the CLI's default so ordering
    // between describe blocks in this file cannot change what they assert.
    configure({ json: false, mode: 'human' });
    vi.restoreAllMocks();
    if (originalApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  /** Every emitted line parsed as JSON. Throws — loudly — on any non-JSON line. */
  const records = (): AskRecord[] =>
    logged.filter((l) => l !== '').map((l) => JSON.parse(l) as AskRecord);

  it('marks a truncated single-shot answer with truncated: true', async () => {
    createMock.mockResolvedValue(reply(TRUNCATED_BUT_READS_FINISHED, 'max_tokens'));

    await runAsk('my database connections are maxed out');

    const [record] = records();
    expect(record).toMatchObject({
      type: 'ask',
      question: 'my database connections are maxed out',
      answer: TRUNCATED_BUT_READS_FINISHED,
      source: 'ai',
      truncated: true,
    });
  });

  /**
   * The guard. If the truncation marker is ever suppressed in machine mode
   * again — by reverting to a bare `console.log(answer)` plus a `printWarning`
   * that machine mode drops — the answer arrives as raw prose, `JSON.parse`
   * throws on it, and no `truncated: true` field exists to find. Both halves
   * fail here rather than reaching a machine consumer.
   */
  it('would fail if the truncation marker were suppressed again', async () => {
    createMock.mockResolvedValue(reply(TRUNCATED_BUT_READS_FINISHED, 'max_tokens'));

    await runAsk('my database connections are maxed out');

    // Nothing in the answer text says it is partial, so the field is the whole
    // signal — the operator-facing sentence never reaches a machine consumer.
    expect(TRUNCATED_BUT_READS_FINISHED.endsWith('.')).toBe(true);
    expect(logged.join('\n')).not.toContain('cut off');

    expect(() => records()).not.toThrow();
    expect(records().some((r) => r.truncated === true)).toBe(true);
  });

  it('emits nothing but JSON — no banner, blank lines, or prose', async () => {
    createMock.mockResolvedValue(reply(TRUNCATED_BUT_READS_FINISHED, 'max_tokens'));

    await runAsk('my database connections are maxed out');

    expect(logged.filter((l) => l === '')).toHaveLength(0);
    for (const line of logged) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(logged).toHaveLength(1);
  });

  it('reports truncated: false for a complete single-shot answer', async () => {
    createMock.mockResolvedValue(reply(COMPLETE_ANSWER, 'end_turn'));

    await runAsk('my postgres replica is lagging');

    expect(records()[0]).toMatchObject({ source: 'ai', truncated: false });
  });

  /**
   * "AI diagnosis unavailable. Showing basic guidance." is another warning
   * machine mode drops. The record carries it as `source`, so a consumer can
   * tell a model answer from locally generated fallback text.
   */
  it('names a fallback answer as a fallback', async () => {
    createMock.mockRejectedValue(new Error('overloaded_error'));

    await runAsk('my postgres replica is lagging');

    expect(records()[0]).toMatchObject({ source: 'fallback', truncated: false });
  });

  it('marks a truncated REPL turn with truncated: true', async () => {
    lines.queue = ['give me the full remediation sequence', '/exit'];
    createMock.mockResolvedValue(reply(TRUNCATED_BUT_READS_FINISHED, 'max_tokens'));

    await runAskRepl();

    expect(records()).toEqual([
      {
        type: 'ask',
        question: 'give me the full remediation sequence',
        answer: TRUNCATED_BUT_READS_FINISHED,
        source: 'ai',
        truncated: true,
      },
    ]);
  });

  it('emits one record per REPL turn, each carrying its own truncated flag', async () => {
    lines.queue = ['my postgres replica is lagging', 'give me the full sequence', '/exit'];
    createMock
      .mockResolvedValueOnce(reply(COMPLETE_ANSWER, 'end_turn'))
      .mockResolvedValueOnce(reply(TRUNCATED_BUT_READS_FINISHED, 'max_tokens'));

    await runAskRepl();

    expect(records().map((r) => r.truncated)).toEqual([false, true]);
  });

  it('reports a REPL error as a JSON error record rather than silence', async () => {
    lines.queue = ['my postgres replica is lagging', '/exit'];
    createMock.mockRejectedValue(new Error('overloaded_error'));

    await runAskRepl();

    expect(logged.map((l) => JSON.parse(l))).toEqual([
      { type: 'error', message: 'AI error: overloaded_error' },
    ]);
  });
});

describe('ask human output is unchanged by the machine record', () => {
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
    configure({ json: false, mode: 'human' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  // The wording of these two sentences is deliberate; they are asserted
  // verbatim so the machine path cannot be "unified" by rewriting them.
  const SINGLE_SHOT_NOTICE =
    'This answer is cut off — it hit the response length limit, so the last point above is incomplete.';

  it('still prints the single-shot truncation notice verbatim, and no JSON', async () => {
    createMock.mockResolvedValue(reply(TRUNCATED_BUT_READS_FINISHED, 'max_tokens'));

    await runAsk('my database connections are maxed out');
    const out = logged.join('\n');

    expect(out).toContain(SINGLE_SHOT_NOTICE);
    expect(out).toContain('Ask a narrower question to get a complete answer.');
    expect(out).toContain(TRUNCATED_BUT_READS_FINISHED);
    expect(out).not.toContain('"type":"ask"');
  });

  it('still prints the REPL truncation notice verbatim, and no JSON', async () => {
    lines.queue = ['give me the full remediation sequence', '/exit'];
    createMock.mockResolvedValue(reply(TRUNCATED_BUT_READS_FINISHED, 'max_tokens'));

    await runAskRepl();
    const out = logged.join('\n');

    expect(out).toContain(SINGLE_SHOT_NOTICE);
    expect(out).toContain('Type "continue" to pick up where it stopped, or ask something narrower.');
    expect(out).not.toContain('"type":"ask"');
  });

  it('still says nothing about truncation when the answer is complete', async () => {
    createMock.mockResolvedValue(reply(COMPLETE_ANSWER, 'end_turn'));

    await runAsk('my postgres replica is lagging');
    const out = logged.join('\n');

    expect(out).toContain('HIGH urgency');
    expect(out).not.toContain('cut off');
  });
});
