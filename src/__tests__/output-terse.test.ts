// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from 'vitest';
import { outputOptions, setOutputOptions } from '../cli/output.js';

describe('terse output option', () => {
  afterEach(() => setOutputOptions({ mode: 'human', terse: false }));

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
});
