// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * C8b — a global flag placed *before* the subcommand silently ran a
 * different command.
 *
 * `crisismode --json diagnose` emitted a JSON *scan* record and exited 0:
 * index.ts gave up looking for a subcommand as soon as argv[0] started with
 * `-` (`args[0] && !args[0].startsWith('-') ? args[0] : undefined`), and
 * `parseArgs({ strict: false })` then swallowed the orphaned `diagnose`
 * token into `positionals`, where the router discarded it and fell through
 * to `runScan`. The unknown-flag half of the same defect meant
 * `crisismode scan --notaflag` was silently accepted.
 *
 * These tests pin the parser itself: the subcommand is the first positional
 * that is neither a flag nor a flag's value, and anything the resulting
 * command does not accept is a usage error naming the offending token.
 */

import { describe, it, expect } from 'vitest';
import { parseCli } from '../cli/args.js';

describe('parseCli — subcommand detection', () => {
  it.each([
    // [argv, expected subcommand]
    [['diagnose'], 'diagnose'],
    [['diagnose', '--json'], 'diagnose'],
    // C8b: the three orderings observed running the built bundle.
    [['--json', 'diagnose'], 'diagnose'],
    [['--verbose', 'completions', 'bash'], 'completions'],
    [['--no-color', 'status'], 'status'],
    // More flag/subcommand orderings.
    [['--terse', 'triage'], 'triage'],
    [['--json', '--verbose', 'down', 'stripe'], 'down'],
    [['--verbose', 'readiness'], 'readiness'],
    // Inline `--flag=value` form: the value is part of the token, so the
    // next token is still the subcommand.
    [['--config=a.yaml', 'scan'], 'scan'],
    [['-v'], undefined],
    [['--json'], undefined],
    [[], undefined],
  ])('%j resolves the subcommand to %s', (argv, expected) => {
    const result = parseCli(argv as string[]);
    expect(result.kind).toBe('command');
    if (result.kind !== 'command') return;
    expect(result.command).toBe(expected);
  });

  it('does not mistake a value-taking flag\'s value for the subcommand', () => {
    // `scan` here is the *value* of --config, not a command.
    const result = parseCli(['--config', 'scan']);
    expect(result.kind).toBe('command');
    if (result.kind !== 'command') return;
    expect(result.command).toBeUndefined();
    expect(result.values.config).toBe('scan');
  });

  it('keeps global flag values when the flag precedes the subcommand', () => {
    const result = parseCli(['--json', '--config', 'a.yaml', 'diagnose', 'PG-001']);
    expect(result.kind).toBe('command');
    if (result.kind !== 'command') return;
    expect(result.command).toBe('diagnose');
    expect(result.values.json).toBe(true);
    expect(result.values.config).toBe('a.yaml');
    expect(result.positionals).toEqual(['PG-001']);
  });

  it('treats everything after `--` as positional', () => {
    const result = parseCli(['ask', '--', '--why-is-pg-slow']);
    expect(result.kind).toBe('command');
    if (result.kind !== 'command') return;
    expect(result.command).toBe('ask');
    expect(result.positionals).toEqual(['--why-is-pg-slow']);
  });
});

describe('parseCli — usage errors', () => {
  it.each([
    // [argv, token the error message must name]
    [['scan', '--notaflag'], '--notaflag'],
    [['--notaflag'], '--notaflag'],
    [['--notaflag', 'scan'], '--notaflag'],
    [['down', '--bogusflag'], '--bogusflag'],
    [['notacommand'], 'notacommand'],
    // Scoped to the subcommand's own option set: --category is scan-only,
    // --health-only is recover-only.
    [['diagnose', '--category', 'redis'], '--category'],
    [['status', '--health-only'], '--health-only'],
  ])('%j is a usage error naming %s', (argv, token) => {
    const result = parseCli(argv as string[]);
    expect(result.kind).toBe('usage');
    if (result.kind !== 'usage') return;
    expect(result.message).toContain(token);
  });

  it.each([
    [['--config']],
    [['--config', '--json']],
    [['down', '--config']],
    [['down', '--config', '--terse']],
  ])('%j is a usage error: --config needs a value that is not another flag', (argv) => {
    const result = parseCli(argv as string[]);
    expect(result.kind).toBe('usage');
    if (result.kind !== 'usage') return;
    expect(result.message).toContain('--config');
  });

  it('suggests the nearest valid command for a near miss', () => {
    const result = parseCli(['diagnos']);
    expect(result.kind).toBe('usage');
    if (result.kind !== 'usage') return;
    expect(result.message).toContain('diagnos');
    expect(result.message).toContain('diagnose');
  });
});
