// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { parseArgs } from 'node:util';

/**
 * Test that the CLI argument parsing logic works correctly.
 * We test the parseArgs configuration directly rather than spawning processes.
 */
describe('CLI argument parsing', () => {
  const parseOpts = {
    options: {
      config: { type: 'string' as const },
      target: { type: 'string' as const },
      category: { type: 'string' as const },
      execute: { type: 'boolean' as const, default: false },
      'health-only': { type: 'boolean' as const, default: false },
      interval: { type: 'string' as const },
      json: { type: 'boolean' as const, default: false },
      'no-color': { type: 'boolean' as const, default: false },
      verbose: { type: 'boolean' as const, default: false },
      help: { type: 'boolean' as const, short: 'h' as const, default: false },
      version: { type: 'boolean' as const, short: 'v' as const, default: false },
    },
    allowPositionals: true,
    strict: false,
  };

  it('parses --config flag', () => {
    const { values } = parseArgs({ ...parseOpts, args: ['--config', 'my.yaml'] });
    expect(values.config).toBe('my.yaml');
  });

  it('parses --target flag', () => {
    const { values } = parseArgs({ ...parseOpts, args: ['--target', 'main-pg'] });
    expect(values.target).toBe('main-pg');
  });

  it('parses --execute flag', () => {
    const { values } = parseArgs({ ...parseOpts, args: ['--execute'] });
    expect(values.execute).toBe(true);
  });

  it('parses --json flag', () => {
    const { values } = parseArgs({ ...parseOpts, args: ['--json'] });
    expect(values.json).toBe(true);
  });

  it('parses -h as help', () => {
    const { values } = parseArgs({ ...parseOpts, args: ['-h'] });
    expect(values.help).toBe(true);
  });

  it('parses -v as version', () => {
    const { values } = parseArgs({ ...parseOpts, args: ['-v'] });
    expect(values.version).toBe(true);
  });

  it('captures positional arguments', () => {
    const { positionals } = parseArgs({ ...parseOpts, args: ['my', 'postgres', 'is', 'slow'] });
    expect(positionals).toEqual(['my', 'postgres', 'is', 'slow']);
  });

  it('combines flags and positionals', () => {
    const { values, positionals } = parseArgs({ ...parseOpts, args: ['--json', 'some', 'question'] });
    expect(values.json).toBe(true);
    expect(positionals).toEqual(['some', 'question']);
  });

  it('parses --category flag', () => {
    const { values } = parseArgs({ ...parseOpts, args: ['--category', 'postgresql,redis'] });
    expect(values.category).toBe('postgresql,redis');
  });

  it('parses --interval flag', () => {
    const { values } = parseArgs({ ...parseOpts, args: ['--interval', '60'] });
    expect(values.interval).toBe('60');
  });
});
