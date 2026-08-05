// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { printVisibility, setOutputOptions } from '../cli/output.js';
import type { VisibilityReport } from '../cli/visibility.js';

const report: VisibilityReport = {
  watching: [
    { label: 'postgresql', detail: 'via DATABASE_URL', maturity: 'live_validated' },
    { label: 'kafka', detail: 'detected automatically', maturity: 'simulator_only' },
  ],
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

  it('renders all buckets with details and hints', () => {
    printVisibility(report);
    const text = lines.join('\n');
    expect(text).toContain('DATABASE_URL');
    expect(text).toContain('AWS credentials detected');
    expect(text).toContain('still checked');
    expect(text).toContain('spoke');
  });

  it('separates live-validated watching from best-effort watching', () => {
    printVisibility(report);
    const pgLine = lines.find((l) => l.includes('postgresql'))!;
    const kafkaLine = lines.find((l) => l.includes('kafka'))!;
    expect(pgLine).toContain('watching');
    expect(pgLine).not.toContain('best-effort');
    expect(kafkaLine).toContain('best-effort');
  });

  it('prints the honest hint once when anything is best-effort', () => {
    printVisibility(report);
    const hintLines = lines.filter((l) => l.includes('treat findings as leads, not conclusions'));
    expect(hintLines).toHaveLength(1);
  });

  it('prints no best-effort hint when every watched system is live-validated', () => {
    printVisibility({
      watching: [{ label: 'dns', detail: 'local checks on this machine', maturity: 'live_validated' }],
      blocked: [],
      invisible: [],
    });
    expect(lines.join('\n')).not.toContain('treat findings as leads');
  });

  it('treats an entry with no maturity as best-effort', () => {
    printVisibility({
      watching: [{ label: 'mongodb', detail: 'detected automatically' }],
      blocked: [],
      invisible: [],
    });
    expect(lines.find((l) => l.includes('mongodb'))).toContain('best-effort');
  });

  it('renders nothing in terse human mode', () => {
    setOutputOptions({ terse: true });
    printVisibility(report);
    expect(lines.join('\n')).not.toContain('DATABASE_URL');
  });
});
