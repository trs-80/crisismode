// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Verifies the environment guard is applied to the diagnose path used by
 * the webhook receiver (src/webhook.ts). `diagnoseWithEnvironmentGuard` is
 * factored out of `handleAlert` specifically so this can be unit tested
 * without booting the HTTP server (which has no exported teardown and would
 * otherwise leak an open listener for the life of the test process).
 */

import { describe, it, expect, vi } from 'vitest';
import type { DiagnosisResult, RecoveryAgent } from '../types/index.js';
import type { AgentContext } from '../types/agent-context.js';
import type { TargetConfig } from '../config/schema.js';

vi.mock('../framework/network-profile.js', () => ({
  getNetworkProfile: vi.fn(() => null),
  probeNetwork: vi.fn(async () => ({
    internet: { status: 'available', probes: [], checkedAt: new Date().toISOString() },
    hub: { status: 'unknown', probes: [], checkedAt: new Date().toISOString() },
    targets: { status: 'unknown', probes: [], checkedAt: new Date().toISOString() },
    dns: { available: true, latencyMs: 0 },
    mode: 'full',
    profiledAt: new Date().toISOString(),
  })),
}));

import { diagnoseWithEnvironmentGuard } from '../webhook.js';
import { probeNetwork } from '../framework/network-profile.js';

function makeAgent(diagnosis: DiagnosisResult): RecoveryAgent {
  return {
    manifest: {} as never,
    assessHealth: vi.fn(),
    diagnose: vi.fn(async () => diagnosis),
    plan: vi.fn(),
    replan: vi.fn(),
  } as unknown as RecoveryAgent;
}

const TARGET = { name: 'test-pg', primary: { host: 'test-pg.invalid', port: 5432 } };

const TARGETS: TargetConfig[] = [{
  name: 'test-pg',
  kind: 'postgresql',
  primary: { host: 'test-pg.invalid', port: 5432 },
  credentials: { type: 'value', username: 'test', password: 'test' },
}];

describe('diagnoseWithEnvironmentGuard (webhook.ts)', () => {
  it('reclassifies a name-resolution failure as target_unresolvable', async () => {
    const diagnosis: DiagnosisResult = {
      status: 'identified',
      scenario: 'database_unreachable',
      confidence: 0.99,
      findings: [{
        source: 'pg_connection',
        observation: 'PostgreSQL is unreachable: getaddrinfo ENOTFOUND test-pg.invalid',
        severity: 'critical',
        data: { error: 'getaddrinfo ENOTFOUND test-pg.invalid' },
      }],
      diagnosticPlanNeeded: false,
    };
    const agent = makeAgent(diagnosis);

    const result = await diagnoseWithEnvironmentGuard(agent, {} as AgentContext, TARGET, TARGETS);

    expect(result.scenario).toBe('target_unresolvable');
    expect(result.status).toBe('partial');
    expect(result.findings[0].source).toBe('environment_check');
  });

  it('leaves healthy diagnoses untouched', async () => {
    const diagnosis: DiagnosisResult = {
      status: 'identified',
      scenario: 'replication_lag_cascade',
      confidence: 0.95,
      findings: [],
      diagnosticPlanNeeded: false,
    };
    const agent = makeAgent(diagnosis);

    const result = await diagnoseWithEnvironmentGuard(agent, {} as AgentContext, TARGET, TARGETS);

    expect(result).toBe(diagnosis);
  });

  it('uses the cached network profile instead of probing when available', async () => {
    const { getNetworkProfile } = await import('../framework/network-profile.js');
    vi.mocked(getNetworkProfile).mockReturnValueOnce({
      internet: { status: 'available', probes: [], checkedAt: new Date().toISOString() },
      hub: { status: 'unknown', probes: [], checkedAt: new Date().toISOString() },
      targets: { status: 'unknown', probes: [], checkedAt: new Date().toISOString() },
      dns: { available: true, latencyMs: 0 },
      mode: 'full',
      profiledAt: new Date().toISOString(),
    } as never);

    const diagnosis: DiagnosisResult = {
      status: 'identified',
      scenario: 'database_unreachable',
      confidence: 0.9,
      findings: [{
        source: 'pg_connection',
        observation: 'unreachable',
        severity: 'critical',
        data: { error: 'connect ECONNREFUSED 10.0.0.5:5432' },
      }],
      diagnosticPlanNeeded: false,
    };
    const agent = makeAgent(diagnosis);

    vi.mocked(probeNetwork).mockClear();
    await diagnoseWithEnvironmentGuard(agent, {} as AgentContext, TARGET, TARGETS);

    expect(vi.mocked(probeNetwork)).not.toHaveBeenCalled();
  });
});
