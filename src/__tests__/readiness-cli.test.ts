// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect } from 'vitest';
import { renderReadinessReport } from '../cli/commands/readiness.js';
import type { ReadinessReport } from '../readiness/types.js';

const report: ReadinessReport = {
  verdict: 'at-risk',
  score: 90,
  evaluated: 5,
  unknown: 1,
  findings: [{
    ruleId: 'connection-headroom', title: 'Database connection headroom',
    status: 'at_risk', headroom: 0.35,
    evidence: ['65 of 100 connections in use (65%)'],
    explanation: 'explanation text', fix: 'add a pooler',
    learnMoreUrl: 'https://example.com',
  }, {
    ruleId: 'slow-queries', title: 'Slow queries', status: 'unknown',
    evidence: [], explanation: 'x', fix: 'x', learnMoreUrl: 'https://example.com',
    reason: 'pg_stat_statements is not available',
  }],
};

const reportWithCeilings: ReadinessReport = {
  ...report,
  ceilings: [{
    id: 'max-connections', title: 'Max connections', value: 2000, unit: 'queries/s',
    evidenceClasses: ['declared', 'measured'],
    evidence: ['max_connections = 100 (declared)', '20 queries/conn (measured)'],
    caveat: 'assumes no pooling',
  }, {
    id: 'redis-throughput', title: 'Redis throughput', value: null, unit: 'ops/s',
    rangeLow: 50000, rangeHigh: 100000,
    evidenceClasses: ['typical'],
    evidence: ['typical for r5.large (typical)'],
    caveat: 'not measured against this instance',
  }],
  ceilingsOmitted: [{ id: 'network-egress', reason: 'declaredEgressMbps source not configured' }],
  weakLink: {
    binding: null,
    conditional: [
      { queriesPerRequest: 1, bindingCeilingId: 'max-connections', requestsPerSec: 2000 },
      { queriesPerRequest: 3, bindingCeilingId: 'max-connections', requestsPerSec: 667 },
      { queriesPerRequest: 10, bindingCeilingId: 'max-connections', requestsPerSec: 200 },
    ],
    note: 'Fixing the first bottleneck promotes the next one — re-run after any change.',
  },
};

describe('renderReadinessReport', () => {
  it('shows verdict, score, and the ran-vs-could-not-run line', () => {
    const out = renderReadinessReport(report).join('\n');
    expect(out).toContain('at-risk');
    expect(out).toContain('90');
    expect(out).toContain('5 rules evaluated, 1 could not run');
  });
  it('shows evidence and fix for non-ready findings', () => {
    const out = renderReadinessReport(report).join('\n');
    expect(out).toContain('65 of 100');
    expect(out).toContain('add a pooler');
  });
  it('shows the unknown reason', () => {
    const out = renderReadinessReport(report).join('\n');
    expect(out).toContain('pg_stat_statements is not available');
  });

  describe('capacity ceilings section', () => {
    it('renders no "Capacity ceilings" header when report.ceilings is undefined', () => {
      const out = renderReadinessReport(report).join('\n');
      expect(out).not.toContain('Capacity ceilings');
    });
    it('shows the section header', () => {
      const out = renderReadinessReport(reportWithCeilings).join('\n');
      expect(out).toContain('Capacity ceilings (upper bounds — real capacity is lower):');
    });
    it('renders a value ceiling as an "at most" line with its evidence-class label', () => {
      const out = renderReadinessReport(reportWithCeilings).join('\n');
      expect(out).toContain('at most 2000 queries/s');
      expect(out).toContain('declared×measured');
    });
    it('renders a range ceiling as a "typically" line, never with "at most"', () => {
      const out = renderReadinessReport(reportWithCeilings).join('\n');
      expect(out).toContain('cited range, not a measurement');
      expect(out).not.toMatch(/at most 50000|at most 100000/);
    });
    it('renders omitted ceilings', () => {
      const out = renderReadinessReport(reportWithCeilings).join('\n');
      expect(out).toContain('Could not assess: network-egress');
    });
    it('renders the weak-link conditional line with all fan-outs and the migration note', () => {
      const out = renderReadinessReport(reportWithCeilings).join('\n');
      expect(out).toContain('varies by assumption:');
      expect(out).toContain('1 →');
      expect(out).toContain('3 →');
      expect(out).toContain('10 →');
      expect(out).toContain('Fixing the first bottleneck promotes the next one');
    });
  });
});
