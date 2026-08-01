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
    const report = buildVisibilityReport(profile, ['postgresql', 'dns'], 'env');
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
    const report = buildVisibilityReport(profile, ['redis'], 'env');
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
});
