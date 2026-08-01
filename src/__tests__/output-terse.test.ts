// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from 'vitest';
import { configure, outputOptions, setOutputOptions } from '../cli/output.js';

describe('terse output option', () => {
  afterEach(() => configure({ json: false, mode: 'human', terse: false }));

  it('defaults to false', () => {
    expect(outputOptions.terse).toBe(false);
  });

  it('is settable via setOutputOptions', () => {
    setOutputOptions({ terse: true });
    expect(outputOptions.terse).toBe(true);
  });

  it('is not reset by unrelated option updates', () => {
    setOutputOptions({ terse: true });
    setOutputOptions({ mode: 'pipe' });
    expect(outputOptions.terse).toBe(true);
  });

  it('does not clobber machine mode set via configure', () => {
    configure({ json: true });
    expect(outputOptions.mode).toBe('machine');
    setOutputOptions({ terse: true });
    expect(outputOptions.mode).toBe('machine');
    expect(outputOptions.terse).toBe(true);
  });

  /**
   * `crisismode` parses --terse once in main() (`args.includes('--terse')`)
   * before routing to a subcommand, so every command — not just scan —
   * gets the flag. Exercise that same argv-scanning logic directly for the
   * commands that render risk framing (recover, demo) and the ones that
   * don't need it, since index.ts's main() runs as a top-level side effect
   * and can't be invoked directly from a unit test.
   */
  it.each([
    [['demo', '--terse'], true],
    [['recover', '--terse'], true],
    [['scan', '--terse'], true],
    [['--terse'], true],
    [['demo'], false],
    [['recover'], false],
    [[], false],
  ] as const)('argv %j resolves terse to %s, matching main()', (argv, expected) => {
    setOutputOptions({ terse: (argv as readonly string[]).includes('--terse') });
    expect(outputOptions.terse).toBe(expected);
  });
});
