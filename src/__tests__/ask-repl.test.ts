// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runAsk } from '../cli/commands/ask.js';

describe('Ask command (6.4)', () => {
  const originalEnv = process.env;
  const originalLog = console.log;
  const originalError = console.error;

  beforeEach(() => {
    process.env = { ...originalEnv };
    console.log = vi.fn();
    console.error = vi.fn();
  });

  afterEach(() => {
    process.env = originalEnv;
    console.log = originalLog;
    console.error = originalError;
  });

  it('throws when ANTHROPIC_API_KEY is not set', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(runAsk('test question')).rejects.toThrow('ANTHROPIC_API_KEY');
  });

  it('exports runAsk and runAskRepl', async () => {
    const mod = await import('../cli/commands/ask.js');
    expect(typeof mod.runAsk).toBe('function');
    expect(typeof mod.runAskRepl).toBe('function');
  });
});
