// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { isUnreachableFinding, reframeFindings } from '../cli/observer-reframe.js';
import type { ScanFinding } from '../cli/output.js';
import type { TriageReport } from '../framework/triage.js';

function finding(over: Partial<ScanFinding> = {}): ScanFinding {
  return {
    id: 'PG-001',
    service: 'postgresql (main-pg)',
    status: 'unknown',
    summary: 'Error: connect ECONNREFUSED 127.0.0.1:5432',
    confidence: 0,
    escalationLevel: 2,
    signals: [],
    ...over,
  };
}

function reportWith(verdict: TriageReport['verdict']): TriageReport {
  return {
    verdict,
    explanation: 'explanation',
    nextStep: 'Fix this machine\'s DNS settings.',
    observerContext: 'laptop',
    observerContextEvidence: 'test fixture',
    escalationLevel: 2,
    checkedAt: '2026-08-05T12:00:00.000Z',
    durationMs: 900,
    layers: [
      { layer: 'interfaces', status: 'pass', detail: 'en0', durationMs: 1 },
      { layer: 'dns', status: 'fail', code: 'resolver-broken', detail: 'system resolver failed', durationMs: 40 },
    ],
  };
}

describe('isUnreachableFinding', () => {
  it('matches a connection error on an unknown finding', () => {
    expect(isUnreachableFinding(finding())).toBe(true);
  });

  it('matches an unreachable signal on an unhealthy finding', () => {
    expect(isUnreachableFinding(finding({
      status: 'unhealthy',
      summary: 'Replica lag unknown',
      signals: [{ status: 'critical', detail: 'host unreachable: EHOSTUNREACH', source: 'pg_connection' }],
    }))).toBe(true);
  });

  it('does not match a healthy finding', () => {
    expect(isUnreachableFinding(finding({ status: 'healthy', summary: 'All good' }))).toBe(false);
  });

  it('does not match a degraded-but-reachable service', () => {
    expect(isUnreachableFinding(finding({
      status: 'unhealthy',
      summary: 'Replication lag is 45s and growing',
    }))).toBe(false);
  });

  // A service-level timeout is a real outage reported BY a reachable service.
  // Matching it here would collapse a genuine incident out of human output
  // whenever triage happened to blame the network.
  it('does not match service-level timeouts', () => {
    for (const summary of [
      'canceling statement due to statement_timeout',
      'ERROR: canceling statement due to lock_timeout',
      'BLPOP timed out after 30s',
      'Query timeout: 5 queries exceeded 30s',
    ]) {
      expect(isUnreachableFinding(finding({ status: 'unhealthy', summary }))).toBe(false);
    }
  });

  it('still matches an ETIMEDOUT errno, which is unambiguous', () => {
    expect(isUnreachableFinding(finding({
      summary: 'Error: connect ETIMEDOUT 10.0.0.5:5432',
    }))).toBe(true);
  });
});

describe('reframeFindings', () => {
  const unreachable = finding();
  const lagging = finding({ id: 'REDIS-001', status: 'unhealthy', summary: 'Memory usage at 95%' });

  it('leaves findings untouched when the verdict is healthy', () => {
    const result = reframeFindings([unreachable, lagging], reportWith('healthy'));
    expect(result.reframe).toBeNull();
    expect(result.findings[0]!.possiblyObserverCaused).toBeUndefined();
  });

  it('leaves findings untouched when the verdict is remote', () => {
    expect(reframeFindings([unreachable], reportWith('remote')).reframe).toBeNull();
  });

  it('flags only the unreachable findings when the verdict is local', () => {
    const result = reframeFindings([unreachable, lagging], reportWith('local'));
    expect(result.reframe).not.toBeNull();
    expect(result.reframe!.findingIds).toEqual(['PG-001']);
    expect(result.findings[0]!.possiblyObserverCaused).toBe(true);
    expect(result.findings[1]!.possiblyObserverCaused).toBeUndefined();
  });

  it('leads the headline with the count and the named cause', () => {
    const { reframe } = reframeFindings([unreachable], reportWith('network'));
    expect(reframe!.headline).toContain('1 service appears unreachable');
    expect(reframe!.headline).toContain('DNS resolver');
    expect(reframe!.headline).toContain('Fix that first.');
    expect(reframe!.nextStep).toBe('Fix this machine\'s DNS settings.');
  });

  it('pluralizes the headline for several findings', () => {
    const { reframe } = reframeFindings([unreachable, finding({ id: 'REDIS-002' })], reportWith('network'));
    expect(reframe!.headline).toContain('2 services appear unreachable');
  });

  it('returns no reframe when nothing looks unreachable', () => {
    expect(reframeFindings([lagging], reportWith('local')).reframe).toBeNull();
  });
});
