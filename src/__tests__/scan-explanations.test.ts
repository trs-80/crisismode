// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { enrichScanFinding } from '../cli/commands/scan.js';

const ctx = { serverless: false };

describe('enrichScanFinding', () => {
  it('attaches explanation from the first non-healthy signal with a map hit', () => {
    const finding = {
      status: 'unhealthy',
      signals: [
        { status: 'healthy', detail: 'ok', source: 'pg_connection' },
        { status: 'critical', detail: 'lag 45m', source: 'pg_replication_lag' },
      ],
    };
    const enriched = enrichScanFinding(finding, ctx);
    expect(enriched.explanation).toContain('replication');
    expect(enriched.learnMoreUrl).toMatch(/^https:/);
  });

  it('falls back to any signal with a hit when none are non-healthy', () => {
    const finding = {
      status: 'unhealthy',
      signals: [{ status: 'healthy', detail: 'ok', source: 'dns_probe' }],
    };
    const enriched = enrichScanFinding(finding, ctx);
    expect(enriched.explanation).toBeDefined();
  });

  it('leaves findings without matching sources untouched', () => {
    const finding = {
      status: 'unhealthy',
      signals: [{ status: 'critical', detail: 'x', source: 'zz_nothing_matches_this' }],
    };
    const enriched = enrichScanFinding(finding, ctx);
    expect(enriched.explanation).toBeUndefined();
  });

  it('leaves healthy findings untouched', () => {
    const finding = {
      status: 'healthy',
      signals: [{ status: 'healthy', detail: 'ok', source: 'pg_connection' }],
    };
    expect(enrichScanFinding(finding, ctx).explanation).toBeUndefined();
  });

  it('handles signals with no source', () => {
    const finding = {
      status: 'unhealthy',
      signals: [{ status: 'critical', detail: 'x' }],
    };
    expect(enrichScanFinding(finding, ctx).explanation).toBeUndefined();
  });
});
