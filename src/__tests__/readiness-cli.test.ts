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
});
