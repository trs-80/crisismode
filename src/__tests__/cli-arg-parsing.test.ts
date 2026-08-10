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
import { parseCli, parseIntervalSeconds } from '../cli/args.js';

/**
 * `--interval` was a self-inflicted DoS, inherited from the pre-fix
 * `src/cli/index.ts:260` (identical expression on main):
 *
 *   intervalMs: intervalStr ? parseInt(intervalStr, 10) * 1000 : undefined
 *
 * `parseInt('abc')` is NaN, `NaN * 1000` is NaN, and `watch.ts`'s
 * `opts.intervalMs ?? DEFAULT_INTERVAL_MS` does NOT catch it — `??` only
 * falls back on null/undefined. `setTimeout(fn, NaN)` clamps to 1ms, so
 * `crisismode watch --interval abc` became a continuous scan loop against
 * infrastructure that is already degraded, while printing "every NaNs" to
 * the operator. `--interval 1m` silently meant one second; `--interval=0`
 * and `--interval=-5` hot-looped too.
 */
describe('parseIntervalSeconds', () => {
  it.each([
    ['30', 30],
    ['1', 1],
    ['3600', 3600],
  ])('accepts a plain positive integer: %s -> %i', (input, expected) => {
    expect(parseIntervalSeconds(input)).toBe(expected);
  });

  it.each([
    // The NaN chain: parseInt gives NaN, which survived `??`.
    ['abc'],
    [''],
    ['  '],
    // Unit suffixes: `60s` worked only because parseInt tolerates the
    // suffix, while `1m` silently meant 1 SECOND. Both rejected.
    ['60s'],
    ['1m'],
    ['5min'],
    // Zero and negatives clamp to a 1ms timer — a hot loop.
    ['0'],
    ['-5'],
    ['-1'],
    // Fractions silently truncated under parseInt ('1.5' -> 1).
    ['1.5'],
    ['0.5'],
    // Exponent/hex/whitespace forms parseInt mangles.
    ['1e3'],
    ['0x10'],
    ['Infinity'],
    ['NaN'],
  ])('rejects %j as a usage error', (input) => {
    const result = parseIntervalSeconds(input);
    expect(typeof result).toBe('object');
    if (typeof result !== 'object') return;
    // Must name the flag and the accepted form, so a stressed operator can
    // see what to type instead.
    expect(result.usageError).toContain('--interval');
    expect(result.usageError).toContain('seconds');
  });

  it('never returns a value that could reach setTimeout as NaN or <= 0', () => {
    for (const bad of ['abc', '0', '-5', '1e3', '']) {
      const result = parseIntervalSeconds(bad);
      expect(typeof result).toBe('object');
    }
    for (const good of ['1', '30', '600']) {
      const result = parseIntervalSeconds(good);
      expect(typeof result).toBe('number');
      expect(Number.isFinite(result as number)).toBe(true);
      expect(result as number).toBeGreaterThan(0);
    }
  });
});

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
    // `ask` never loads config — runAsk/runAskRepl take no config path, and
    // completions.ts advertises no flags for it — so accepting --config
    // would silently ignore it, the exact thing the per-command option sets
    // exist to prevent.
    [['ask', '--config', 'x.yaml'], '--config'],
    [['ask', 'why', 'is', 'pg', 'slow', '--config', 'x.yaml'], '--config'],
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
    // Inline empty value: the `=` form skipped the missing-value check
    // entirely, so `--config=` set config to '' and handed the loader an
    // empty path instead of erroring.
    [['--config=']],
    [['down', '--config=']],
    [['diagnose', '--config=']],
  ])('%j is a usage error: --config needs a value that is not another flag', (argv) => {
    const result = parseCli(argv as string[]);
    expect(result.kind).toBe('usage');
    if (result.kind !== 'usage') return;
    expect(result.message).toContain('--config');
  });

  it.each([
    [['scan', '--category='], '--category'],
    [['diagnose', '--target='], '--target'],
    [['watch', '--interval='], '--interval'],
    [['init', '--plugin='], '--plugin'],
    [['bundle', 'ingest', 'x.json', '--output='], '--output'],
  ])('%j is a usage error — every value-taking flag rejects an empty inline value', (argv, flag) => {
    const result = parseCli(argv as string[]);
    expect(result.kind).toBe('usage');
    if (result.kind !== 'usage') return;
    expect(result.message).toContain(flag);
  });

  it('still accepts a non-empty inline value', () => {
    const result = parseCli(['--config=a.yaml', 'scan']);
    expect(result.kind).toBe('command');
    if (result.kind !== 'command') return;
    expect(result.values.config).toBe('a.yaml');
  });

  it('suggests the nearest valid command for a near miss', () => {
    const result = parseCli(['diagnos']);
    expect(result.kind).toBe('usage');
    if (result.kind !== 'usage') return;
    expect(result.message).toContain('diagnos');
    expect(result.message).toContain('diagnose');
  });
});
