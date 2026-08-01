// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { buildVisibilityReport } from '../cli/visibility.js';
import type { StackProfile } from '../cli/autodiscovery.js';

function profileWith(overrides: Partial<StackProfile>): StackProfile {
  return {
    services: [],
    appStack: { framework: null, language: null, hasDockerfile: false, hasCIConfig: false, dependencies: [] },
    envHints: [],
    platform: { platform: null, detected: false, signals: [] },
    aiProviders: [],
    derivedTargets: [],
    derivedNotes: {},
    confidence: 0.5,
    ...overrides,
  };
}

describe('buildVisibilityReport', () => {
  it('lists ran agents as watching, with env-var evidence when a hint matches', () => {
    const profile = profileWith({
      envHints: [{ name: 'DATABASE_URL', present: true, kind: 'database_url', inferredService: 'postgresql' }],
    });
    const report = buildVisibilityReport(profile, ['postgresql', 'dns'], 'env-fallback');
    const pg = report.watching.find((e) => e.label === 'postgresql');
    expect(pg).toBeDefined();
    expect(pg!.detail).toContain('DATABASE_URL');
    const dns = report.watching.find((e) => e.label === 'dns');
    expect(dns!.detail).toContain('this machine');
  });

  it('reports AWS credentials as found-but-blocked with an actionable hint', () => {
    const profile = profileWith({
      envHints: [{ name: 'AWS_ACCESS_KEY_ID', present: true, kind: 'aws_credentials' }],
    });
    const report = buildVisibilityReport(profile, [], 'none');
    const aws = report.blocked.find((e) => e.label.toLowerCase().includes('aws'));
    expect(aws).toBeDefined();
    expect(aws!.hint).toBeTruthy();
  });

  it('reports a present service hint with no supported agent as blocked', () => {
    const profile = profileWith({
      envHints: [{ name: 'MONGODB_URI', present: true, kind: 'database_url', inferredService: 'mongodb' }],
    });
    const report = buildVisibilityReport(profile, [], 'none');
    const mongo = report.blocked.find((e) => e.detail.includes('MONGODB_URI'));
    expect(mongo).toBeDefined();
  });

  it('does not report a hint as blocked when its service ran', () => {
    const profile = profileWith({
      envHints: [{ name: 'REDIS_URL', present: true, kind: 'redis_url', inferredService: 'redis' }],
    });
    const report = buildVisibilityReport(profile, ['redis'], 'env-fallback');
    expect(report.blocked.find((e) => e.detail.includes('REDIS_URL'))).toBeUndefined();
  });

  it('states OS-level limits when remote services ran', () => {
    const profile = profileWith({});
    const report = buildVisibilityReport(profile, ['postgresql'], 'file');
    expect(report.invisible.length).toBeGreaterThan(0);
    expect(report.invisible[0]!.detail.toLowerCase()).toContain('spoke');
  });

  it('omits absent env hints entirely', () => {
    const profile = profileWith({
      envHints: [{ name: 'AWS_ACCESS_KEY_ID', present: false, kind: 'aws_credentials' }],
    });
    const report = buildVisibilityReport(profile, [], 'none');
    expect(report.blocked).toHaveLength(0);
  });

  it('names the env var from derivedNotes when no env hint matches the target kind', () => {
    // ai-provider has no ENV_HINTS entry (inferredService is only set for
    // connection-string kinds), so the watching-bucket evidence has to come
    // from deriveGatedTargets' notes instead of the envHints scan.
    const profile = profileWith({
      derivedTargets: [{ name: 'derived-ai-provider', kind: 'ai-provider', primary: { host: 'auto', port: 0 } }],
      derivedNotes: { 'derived-ai-provider': 'from OPENAI_API_KEY' },
    });
    const report = buildVisibilityReport(profile, ['ai-provider'], 'env-fallback');
    const ai = report.watching.find((e) => e.label === 'ai-provider');
    expect(ai).toBeDefined();
    expect(ai!.detail).toBe('from OPENAI_API_KEY');
  });

  it.each([
    ['file', 'configured in crisismode.yaml'],
    ['env-fallback', 'configured via legacy environment variables'],
    ['none', 'detected automatically'],
  ] as const)('maps configSource %s to its real loader value', (configSource, expected) => {
    const profile = profileWith({});
    const report = buildVisibilityReport(profile, ['postgresql'], configSource);
    const pg = report.watching.find((e) => e.label === 'postgresql');
    expect(pg!.detail).toBe(expected);
  });
});
