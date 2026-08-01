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
});
