// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { applyEnvironmentGuard, assessEnvironment } from '../framework/environment-guard.js';
import type { DiagnosisResult, NetworkProfile } from '../types/index.js';

function profile(overrides: Partial<NetworkProfile> = {}): NetworkProfile {
  return {
    internet: { status: 'available', probes: [], checkedAt: '2026-07-12T00:00:00Z' },
    hub: { status: 'unknown', probes: [], checkedAt: '2026-07-12T00:00:00Z' },
    targets: { status: 'unknown', probes: [], checkedAt: '2026-07-12T00:00:00Z' },
    dns: { available: true, latencyMs: 5 },
    mode: 'full',
    profiledAt: '2026-07-12T00:00:00Z',
    ...overrides,
  };
}

function unreachableDiagnosis(error = 'connect ECONNREFUSED 10.0.0.5:5432'): DiagnosisResult {
  return {
    status: 'identified',
    scenario: 'database_unreachable',
    confidence: 0.99,
    findings: [{
      source: 'pg_connection',
      observation: `PostgreSQL is unreachable: ${error}`,
      severity: 'critical',
      data: { error },
    }],
    diagnosticPlanNeeded: false,
  };
}

describe('assessEnvironment', () => {
  it('is clear on a healthy profile', () => {
    expect(assessEnvironment(profile()).suspect).toBe(false);
  });

  it('is suspect when DNS is down', () => {
    const v = assessEnvironment(profile({ dns: { available: false, latencyMs: 3000 } }));
    expect(v.suspect).toBe(true);
    expect(v.reasons.join(' ')).toMatch(/DNS/i);
  });

  it('is suspect when internet is unavailable', () => {
    const v = assessEnvironment(profile({
      internet: { status: 'unavailable', probes: [], checkedAt: '2026-07-12T00:00:00Z' },
    }));
    expect(v.suspect).toBe(true);
  });

  it('handles null profile without crashing', () => {
    expect(assessEnvironment(null).suspect).toBe(false);
  });
});

describe('applyEnvironmentGuard', () => {
  it('leaves non-unreachable verdicts untouched', () => {
    const d: DiagnosisResult = { ...unreachableDiagnosis(), scenario: 'replication_lag_cascade' };
    expect(applyEnvironmentGuard(d, profile({ dns: { available: false, latencyMs: 0 } }))).toBe(d);
  });

  it('reclassifies name-resolution failures as target_unresolvable', () => {
    const d = unreachableDiagnosis('getaddrinfo ENOTFOUND pg-missing.invalid');
    const out = applyEnvironmentGuard(d, profile(), 'test-postgres');
    expect(out.scenario).toBe('target_unresolvable');
    expect(out.status).toBe('partial');
    expect(out.confidence).toBeLessThanOrEqual(0.6);
    expect(out.findings[0].source).toBe('environment_check');
    expect(out.findings[0].observation).toMatch(/DNS or configuration/i);
  });

  it('downgrades unreachable verdicts when the observer environment is degraded', () => {
    const d = unreachableDiagnosis();
    const out = applyEnvironmentGuard(d, profile({
      internet: { status: 'unavailable', probes: [], checkedAt: '2026-07-12T00:00:00Z' },
      dns: { available: false, latencyMs: 3000 },
      mode: 'isolated',
    }), 'test-postgres');
    expect(out.status).toBe('partial');
    expect(out.confidence).toBeLessThanOrEqual(0.5);
    expect(out.findings[0].source).toBe('environment_check');
    expect(out.findings[0].observation).toMatch(/may be healthy/i);
  });

  it('keeps the verdict when the startup TCP probe reached the target', () => {
    const d = unreachableDiagnosis();
    const p = profile({
      internet: { status: 'unavailable', probes: [], checkedAt: '2026-07-12T00:00:00Z' },
      targets: {
        status: 'available',
        probes: [{ target: 'test-postgres', reachable: true, latencyMs: 2 }],
        checkedAt: '2026-07-12T00:00:00Z',
      },
    });
    expect(applyEnvironmentGuard(d, p, 'test-postgres')).toBe(d);
  });

  it('passes the diagnosis through when profile is null', () => {
    const d = unreachableDiagnosis();
    expect(applyEnvironmentGuard(d, null, 'test-postgres')).toBe(d);
  });
});
