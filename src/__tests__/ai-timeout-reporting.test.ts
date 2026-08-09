// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * A timeout must be reported as a timeout.
 *
 * Every AI path routes through `callClaude`, which owns the AbortController and
 * so is the only layer that can tell "the API did not answer in time" from "the
 * API returned an error". These tests pin the operator-facing message for each
 * reporting call site: an unanswered request must name the timeout and its
 * duration, never surface as an opaque generic failure.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AiTimeoutError } from '../framework/ai-client.js';
import type * as AiClientModule from '../framework/ai-client.js';

const { callClaudeMock } = vi.hoisted(() => ({ callClaudeMock: vi.fn() }));

vi.mock('../framework/ai-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof AiClientModule>();
  return { ...actual, callClaude: callClaudeMock };
});

const { aiCallText } = await import('../framework/ai-diagnosis.js');

describe('AI timeout reporting', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let originalApiKey: string | undefined;

  beforeEach(() => {
    callClaudeMock.mockReset();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(() => {
    errorSpy.mockRestore();
    if (originalApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  const logged = () =>
    errorSpy.mock.calls
      .map((args: unknown[]) => args.map((a: unknown) => String(a)).join(' '))
      .join('\n');

  it('aiCallText names the timeout and its duration', async () => {
    callClaudeMock.mockRejectedValue(new AiTimeoutError(10_000));

    const result = await aiCallText('sys', 'user', { timeoutMs: 10_000 });

    expect(result).toBeNull();
    expect(logged()).toBe('AI call timed out after 10000ms');
  });

  it('aiCallText does not report a timeout as a generic failure', async () => {
    callClaudeMock.mockRejectedValue(new AiTimeoutError(10_000));

    await aiCallText('sys', 'user', { timeoutMs: 10_000 });

    // The pre-fix behavior: "AI call failed: Request was aborted."
    expect(logged()).not.toMatch(/AI call failed/);
    expect(logged()).not.toMatch(/aborted/i);
  });

  it('aiCallText still reports genuine API errors as failures', async () => {
    callClaudeMock.mockRejectedValue(new Error('overloaded_error'));

    const result = await aiCallText('sys', 'user');

    expect(result).toBeNull();
    expect(logged()).toBe('AI call failed: overloaded_error');
  });

  it('carries the configured timeout, not a hardcoded default', async () => {
    callClaudeMock.mockRejectedValue(new AiTimeoutError(2_500));

    await aiCallText('sys', 'user', { timeoutMs: 2_500 });

    expect(logged()).toBe('AI call timed out after 2500ms');
  });
});
