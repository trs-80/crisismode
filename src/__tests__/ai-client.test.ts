// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { APIUserAbortError } from '@anthropic-ai/sdk';
import type * as AnthropicSdk from '@anthropic-ai/sdk';
import { AiTimeoutError, callClaude, stripCodeFence } from '../framework/ai-client.js';

// Capture the SDK's messages.create so each test can control its behavior.
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

// Keep the real module's exports (notably APIUserAbortError) and stub only the
// client, so abort tests can reject with the error the SDK actually throws
// rather than a hand-built stand-in.
vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof AnthropicSdk>();
  return {
    ...actual,
    default: class {
      messages = { create: createMock };
    },
  };
});

describe('callClaude', () => {
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    createMock.mockReset();
  });

  afterEach(() => {
    if (originalApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('concatenates text blocks and ignores non-text blocks', async () => {
    createMock.mockResolvedValue({
      content: [
        { type: 'text', text: 'Hello ' },
        { type: 'tool_use', id: 'x', name: 'y', input: {} },
        { type: 'text', text: 'world' },
      ],
    });

    const out = await callClaude({ system: 'sys', user: 'hi', apiKey: 'test-key' });
    expect(out).toBe('Hello world');
  });

  it('does not trim the returned text (caller owns trimming)', async () => {
    createMock.mockResolvedValue({ content: [{ type: 'text', text: '  padded  ' }] });
    const out = await callClaude({ system: 'sys', user: 'hi', apiKey: 'test-key' });
    expect(out).toBe('  padded  ');
  });

  it('wraps a single user string into a one-message array with defaults', async () => {
    createMock.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

    await callClaude({ system: 'sys', user: 'question', apiKey: 'test-key' });

    expect(createMock).toHaveBeenCalledTimes(1);
    const [params, options] = createMock.mock.calls[0]!;
    expect(params.messages).toEqual([{ role: 'user', content: 'question' }]);
    expect(params.system).toBe('sys');
    expect(params.max_tokens).toBe(4096);
    expect(typeof params.model).toBe('string');
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('passes an explicit messages array through unchanged (multi-turn)', async () => {
    createMock.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

    const messages = [
      { role: 'user' as const, content: 'first' },
      { role: 'assistant' as const, content: 'reply' },
      { role: 'user' as const, content: 'second' },
    ];
    await callClaude({
      system: 'sys',
      messages,
      maxTokens: 512,
      model: 'claude-test',
      apiKey: 'test-key',
    });

    const [params] = createMock.mock.calls[0]!;
    expect(params.messages).toEqual(messages);
    expect(params.max_tokens).toBe(512);
    expect(params.model).toBe('claude-test');
  });

  /**
   * Neither `messages` nor `user` set. This is a caller bug, and the point of
   * pinning it is that `callClaude` does not paper over it with an invented
   * prompt: it sends one empty user turn, which the API rejects, so the mistake
   * surfaces at the call site instead of producing a confident answer to a
   * question nobody asked.
   */
  it('sends a single empty user turn when neither user nor messages is given', async () => {
    createMock.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

    await callClaude({ system: 'sys', apiKey: 'test-key' });

    const [params] = createMock.mock.calls[0]!;
    expect(params.messages).toEqual([{ role: 'user', content: '' }]);
  });

  it('returns an empty string when the model replies with no text blocks', async () => {
    // A stop-at-tool-use or otherwise text-free reply must not throw here; the
    // JSON-parsing callers turn the empty string into their own fallback.
    createMock.mockResolvedValue({ content: [] });

    expect(await callClaude({ system: 'sys', user: 'hi', apiKey: 'test-key' })).toBe('');
  });

  it('throws with a clear message when no API key is available', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(callClaude({ system: 'sys', user: 'hi' })).rejects.toThrow(/API key/i);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('falls back to ANTHROPIC_API_KEY when apiKey is not passed', async () => {
    process.env.ANTHROPIC_API_KEY = 'env-key';
    createMock.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

    await callClaude({ system: 'sys', user: 'hi' });
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  // Guards the assumption the timeout detection rests on. The SDK's error
  // classes never assign `name`, so it inherits "Error" from Error.prototype —
  // which is why matching on `err.name === 'AbortError'` cannot work and the
  // signal has to be the witness instead.
  it("the SDK's abort error is not named AbortError", () => {
    const err = new APIUserAbortError({});
    expect(err.name).toBe('Error');
    expect(err.name).not.toBe('AbortError');
    expect(err.message).toBe('Request was aborted.');
  });

  it('throws AiTimeoutError when the timeout fires', async () => {
    // Reject the way the real SDK does once the signal we passed is aborted.
    // `callClaude` awaits the dynamic SDK import before calling create(), so a
    // deadline this short can already have fired by the time we are invoked —
    // the real SDK rejects immediately in that case, and so must this stub, or
    // the promise never settles and the test hangs.
    createMock.mockImplementation(
      (_params: unknown, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const rejectAsSdkAbort = () => reject(new APIUserAbortError({}));
          if (options.signal.aborted) {
            rejectAsSdkAbort();
            return;
          }
          options.signal.addEventListener('abort', rejectAsSdkAbort, { once: true });
        }),
    );

    const err = await callClaude({
      system: 'sys',
      user: 'hi',
      timeoutMs: 5,
      apiKey: 'test-key',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AiTimeoutError);
    expect(err).toMatchObject({ name: 'AiTimeoutError', timeoutMs: 5 });
    expect((err as Error).message).toBe('timed out after 5ms');
  });

  it('does not mistake a non-timeout API failure for a timeout', async () => {
    createMock.mockRejectedValue(new Error('overloaded_error'));

    const err = await callClaude({
      system: 'sys',
      user: 'hi',
      apiKey: 'test-key',
    }).catch((e: unknown) => e);

    expect(err).not.toBeInstanceOf(AiTimeoutError);
    expect((err as Error).message).toBe('overloaded_error');
  });

  it('propagates API errors to the caller', async () => {
    createMock.mockRejectedValue(new Error('rate limited'));
    await expect(
      callClaude({ system: 'sys', user: 'hi', apiKey: 'test-key' }),
    ).rejects.toThrow('rate limited');
  });
});

describe('stripCodeFence', () => {
  it('strips a ```json fence', () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('strips a plain ``` fence', () => {
    expect(stripCodeFence('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('returns text unchanged when there is no fence', () => {
    expect(stripCodeFence('{"a":1}')).toBe('{"a":1}');
  });

  it('trims surrounding whitespace', () => {
    expect(stripCodeFence('  {"a":1}  ')).toBe('{"a":1}');
  });
});
