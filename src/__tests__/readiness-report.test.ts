// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect } from 'vitest';
import { buildReport } from '../readiness/report.js';
import type { ReadinessFinding } from '../readiness/types.js';

const finding = (over: Partial<ReadinessFinding>): ReadinessFinding => ({
  ruleId: 'test-rule',
  title: 'Test rule',
  status: 'ready',
  evidence: [],
  explanation: 'x',
  fix: 'x',
  learnMoreUrl: 'https://example.com',
  ...over,
});

describe('buildReport', () => {
  it('scores ready findings at 100 with verdict ready', () => {
    const r = buildReport([finding({}), finding({ ruleId: 'b' })]);
    expect(r.score).toBe(100);
    expect(r.verdict).toBe('ready');
    expect(r.evaluated).toBe(2);
    expect(r.unknown).toBe(0);
  });

  it('any blocking finding yields not-ready and subtracts 30', () => {
    const r = buildReport([finding({}), finding({ ruleId: 'b', status: 'blocking' })]);
    expect(r.verdict).toBe('not-ready');
    expect(r.score).toBe(70);
  });

  it('at_risk without blocking yields at-risk and subtracts 10', () => {
    const r = buildReport([finding({ status: 'at_risk' })]);
    expect(r.verdict).toBe('at-risk');
    expect(r.score).toBe(90);
  });

  it('unknown findings are counted separately and do not affect score', () => {
    const r = buildReport([finding({}), finding({ ruleId: 'b', status: 'unknown', reason: 'no extension' })]);
    expect(r.score).toBe(100);
    expect(r.unknown).toBe(1);
    expect(r.evaluated).toBe(1);
  });

  it('score floors at 0', () => {
    const blockers = ['a', 'b', 'c', 'd'].map((id) => finding({ ruleId: id, status: 'blocking' }));
    expect(buildReport(blockers).score).toBe(0);
  });

  it('all-unknown report has verdict unknown', () => {
    const r = buildReport([finding({ status: 'unknown', reason: 'unreachable' })]);
    expect(r.verdict).toBe('unknown');
  });
});
