// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { printVisibility, setOutputOptions } from '../cli/output.js';
import type { VisibilityReport } from '../cli/visibility.js';

const report: VisibilityReport = {
  watching: [{ label: 'postgresql', detail: 'via DATABASE_URL' }],
  blocked: [{ label: 'AWS control plane', detail: 'AWS credentials detected — not supported yet', hint: 'Reachable AWS services are still checked.' }],
  invisible: [{ label: 'remote host internals', detail: 'cannot be seen from outside. Run a CrisisMode spoke on the host.' }],
};

describe('printVisibility', () => {
  let lines: string[];
  beforeEach(() => {
    lines = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
    setOutputOptions({ mode: 'human', terse: false });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setOutputOptions({ mode: 'human', terse: false });
  });

  it('renders all three buckets with details and hints', () => {
    printVisibility(report);
    const text = lines.join('\n');
    expect(text).toContain('DATABASE_URL');
    expect(text).toContain('AWS credentials detected');
    expect(text).toContain('still checked');
    expect(text).toContain('spoke');
  });

  it('renders nothing in terse human mode', () => {
    setOutputOptions({ terse: true });
    printVisibility(report);
    expect(lines.join('\n')).not.toContain('DATABASE_URL');
  });
});
