// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { callClaude, stripCodeFence } from '../framework/ai-client.js';

// Capture the SDK's messages.create so each test can control its behavior.
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: createMock };
  },
}));

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
    expect(params.max_tokens).toBe(1024);
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

  it('aborts and rejects with AbortError when the timeout fires', async () => {
    // Honor the abort signal: reject with an AbortError once aborted.
    createMock.mockImplementation(
      (_params: unknown, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const err = new Error('Request was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );

    await expect(
      callClaude({ system: 'sys', user: 'hi', timeoutMs: 5, apiKey: 'test-key' }),
    ).rejects.toMatchObject({ name: 'AbortError' });
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
