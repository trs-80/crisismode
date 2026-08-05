// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configure, setOutputOptions, printScanSummary } from '../cli/output.js';
import type { ScanFinding, ScanResult } from '../cli/output.js';

function scanResultWith(findings: ScanFinding[]): ScanResult {
  return {
    score: 60,
    findings,
    recentChanges: [],
    scannedAt: '2026-08-05T12:00:00.000Z',
    durationMs: 120,
  };
}

const validatedFinding: ScanFinding = {
  id: 'PG-001',
  service: 'postgresql (detected-postgresql)',
  status: 'unhealthy',
  summary: 'Replication lag at 45s',
  confidence: 0.9,
  escalationLevel: 2,
  signals: [{ status: 'critical', detail: 'lag 45s' }],
};

const bestEffortFinding: ScanFinding = {
  id: 'KAFKA-001',
  service: 'kafka (detected-kafka)',
  status: 'unhealthy',
  summary: 'Under-replicated partitions',
  confidence: 0.5,
  escalationLevel: 2,
  signals: [{ status: 'critical', detail: 'ISR shrunk' }],
  bestEffort: true,
};

describe('best-effort findings in human output', () => {
  let lines: string[];
  beforeEach(() => {
    lines = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
    configure({ mode: 'human', noColor: true, json: false, verbose: false });
    setOutputOptions({ terse: false });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    configure({ json: false, noColor: false, verbose: false, mode: 'human' });
    setOutputOptions({ terse: false });
  });

  it('caveats a best-effort finding', () => {
    printScanSummary(scanResultWith([bestEffortFinding]));
    expect(lines.join('\n')).toContain('treat this as a lead, not a conclusion');
  });

  it('does not caveat a live-validated finding', () => {
    printScanSummary(scanResultWith([validatedFinding]));
    expect(lines.join('\n')).not.toContain('treat this as a lead');
  });

  it('suppresses the caveat in terse mode', () => {
    setOutputOptions({ terse: true });
    printScanSummary(scanResultWith([bestEffortFinding]));
    expect(lines.join('\n')).not.toContain('treat this as a lead');
  });
});

describe('best-effort findings in machine output', () => {
  let lines: string[];
  beforeEach(() => {
    lines = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
    configure({ json: true, noColor: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    configure({ json: false, noColor: false, verbose: false, mode: 'human' });
  });

  it('emits bestEffort: true per finding', () => {
    printScanSummary(scanResultWith([validatedFinding, bestEffortFinding]));
    const parsed = JSON.parse(lines[0]!) as { findings: Array<{ id: string; bestEffort?: boolean }> };
    expect(parsed.findings.find((f) => f.id === 'KAFKA-001')!.bestEffort).toBe(true);
    expect(parsed.findings.find((f) => f.id === 'PG-001')!.bestEffort).toBeUndefined();
  });
});
