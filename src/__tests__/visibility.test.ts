// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { buildVisibilityReport, liveValidatedWatching, bestEffortWatching } from '../cli/visibility.js';
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

  it('reports Aurora endpoints as blocked with an honest hint', () => {
    const profile = profileWith({
      awsDetection: {
        unsupportedEndpoints: [{ host: 'prod.cluster-abc.us-east-1.rds.amazonaws.com', type: 'cluster' }],
        uncredentialedHosts: [],
      },
    });
    const report = buildVisibilityReport(profile, [], 'none');
    const aurora = report.blocked.find((e) => e.label.includes('Aurora'));
    expect(aurora).toBeDefined();
    expect(aurora!.detail).toContain('prod.cluster-abc');
    expect(aurora!.hint).toBeTruthy();
  });

  it('reports RDS endpoints seen without credentials', () => {
    const profile = profileWith({
      awsDetection: { unsupportedEndpoints: [], uncredentialedHosts: ['mydb.abc.us-east-1.rds.amazonaws.com'] },
    });
    const report = buildVisibilityReport(profile, [], 'none');
    const entry = report.blocked.find((e) => e.detail.includes('mydb.abc'));
    expect(entry).toBeDefined();
    expect(entry!.hint).toMatch(/AWS_ACCESS_KEY_ID|AWS_PROFILE/);
  });

  it('suppresses the generic AWS-unsupported entry when aws-rds ran', () => {
    const profile = profileWith({
      envHints: [{ name: 'AWS_ACCESS_KEY_ID', present: true, kind: 'aws_credentials' }],
    });
    const report = buildVisibilityReport(profile, ['aws-rds'], 'env-fallback');
    expect(report.blocked.find((e) => e.label === 'AWS control plane')).toBeUndefined();
  });

  it('suppresses the generic AWS-unsupported entry when only Aurora/proxy endpoints were found (no aws-rds ran)', () => {
    // The Aurora-specific blocked entry (added above from unsupportedEndpoints)
    // is strictly more informative than the generic "not supported yet" one —
    // showing both is redundant.
    const profile = profileWith({
      envHints: [{ name: 'AWS_ACCESS_KEY_ID', present: true, kind: 'aws_credentials' }],
      awsDetection: {
        unsupportedEndpoints: [{ host: 'prod.cluster-abc.us-east-1.rds.amazonaws.com', type: 'cluster' }],
        uncredentialedHosts: [],
      },
    });
    const report = buildVisibilityReport(profile, [], 'env-fallback');
    expect(report.blocked.find((e) => e.label === 'AWS control plane')).toBeUndefined();
    expect(report.blocked.find((e) => e.label.includes('Aurora'))).toBeDefined();
  });

  it('appends extraBlocked entries to the blocked bucket', () => {
    const profile = profileWith({});
    const report = buildVisibilityReport(profile, [], 'none', [
      { label: 'aws-rds permissions', detail: 'missing rds:DescribeDBInstances', hint: 'attach AmazonRDSReadOnlyAccess' },
    ]);
    expect(report.blocked.find((e) => e.detail.includes('rds:DescribeDBInstances'))).toBeDefined();
  });

  it('lists unwatchable Terraform-managed types as invisible', () => {
    const profile = profileWith({});
    profile.iacDetection = { stateSource: 'local', unwatchableTypes: { aws_elasticache_cluster: 2 } };
    const report = buildVisibilityReport(profile, ['iac-drift'], 'none');
    expect(report.invisible).toContainEqual(expect.objectContaining({
      label: 'aws_elasticache_cluster',
      detail: expect.stringContaining('2'),
    }));
  });

  it('reports unsupported state backends as blocked', () => {
    const profile = profileWith({});
    profile.iacDetection = { stateSource: 'unsupported-backend', backendType: 'remote', unwatchableTypes: {} };
    const report = buildVisibilityReport(profile, [], 'none');
    expect(report.blocked).toContainEqual(expect.objectContaining({
      label: 'iac-drift (remote state)',
      detail: expect.stringContaining('remote'),
    }));
  });

  it('marks a watched kind live-validated when the maturity map says so', () => {
    const profile = profileWith({
      envHints: [{ name: 'DATABASE_URL', present: true, kind: 'database_url', inferredService: 'postgresql' }],
    });
    const report = buildVisibilityReport(
      profile,
      ['postgresql', 'kafka'],
      'env-fallback',
      undefined,
      new Map([['postgresql', 'live_validated'], ['kafka', 'simulator_only']]),
    );
    expect(report.watching.find((e) => e.label === 'postgresql')!.maturity).toBe('live_validated');
    expect(report.watching.find((e) => e.label === 'kafka')!.maturity).toBe('simulator_only');
  });

  it('defaults a kind with no maturity entry to best-effort', () => {
    const profile = profileWith({});
    const report = buildVisibilityReport(profile, ['mongodb'], 'file', undefined, new Map());
    expect(report.watching.find((e) => e.label === 'mongodb')!.maturity).toBe('simulator_only');
  });

  it('defaults every watched kind to best-effort when no maturity map is given', () => {
    const profile = profileWith({});
    const report = buildVisibilityReport(profile, ['postgresql', 'dns'], 'file');
    for (const entry of report.watching) {
      expect(entry.maturity).toBe('simulator_only');
    }
  });

  it('marks local-kind entries from the maturity map too', () => {
    const profile = profileWith({});
    const report = buildVisibilityReport(
      profile,
      ['dns', 'disk'],
      'none',
      undefined,
      new Map([['dns', 'live_validated'], ['disk', 'live_validated']]),
    );
    expect(report.watching.every((e) => e.maturity === 'live_validated')).toBe(true);
  });

  it('gives each provider its own watching row for free, because each has its own kind', () => {
    const profile = profileWith({
      derivedTargets: [
        { name: 'derived-llm-anthropic', kind: 'llm-provider.anthropic', primary: { host: 'api.anthropic.com', port: 443 }, llm: { provider: 'anthropic' } },
        { name: 'derived-llm-google', kind: 'llm-provider.google', primary: { host: 'generativelanguage.googleapis.com', port: 443 }, llm: { provider: 'google' } },
      ],
      derivedNotes: {
        'derived-llm-anthropic': 'from ANTHROPIC_API_KEY',
        'derived-llm-google': 'from GOOGLE_AI_API_KEY',
      },
    });

    const report = buildVisibilityReport(
      profile,
      ['llm-provider.anthropic', 'llm-provider.google'],
      'none',
      undefined,
      new Map([['llm-provider.anthropic', 'live_validated'], ['llm-provider.google', 'simulator_only']]),
    );

    const rows = report.watching.filter((e) => e.label.startsWith('llm-provider.'));
    expect(rows).toHaveLength(2);
    expect(rows.map((e) => e.label)).toEqual(['llm-provider.anthropic', 'llm-provider.google']);
    expect(rows.map((e) => e.detail)).toEqual(['from ANTHROPIC_API_KEY', 'from GOOGLE_AI_API_KEY']);
    expect(rows.map((e) => e.maturity)).toEqual(['live_validated', 'simulator_only']);
  });

  it('never collapses two providers onto one row, even if a caller mistakenly passes a shared kind twice', () => {
    // Defence in depth: if `ranKinds` ever repeated a kind, the loop must not
    // duplicate or drop rows. This does not exercise per-provider behaviour —
    // it just confirms the existing one-row-per-kind loop is idempotent.
    const profile = profileWith({
      derivedTargets: [
        { name: 'derived-llm-anthropic', kind: 'llm-provider.anthropic', primary: { host: 'api.anthropic.com', port: 443 }, llm: { provider: 'anthropic' } },
      ],
      derivedNotes: { 'derived-llm-anthropic': 'from ANTHROPIC_API_KEY' },
    });

    const report = buildVisibilityReport(profile, ['llm-provider.anthropic', 'llm-provider.anthropic'], 'none');
    const rows = report.watching.filter((e) => e.label === 'llm-provider.anthropic');
    expect(rows).toHaveLength(2); // one per ranKinds entry — ranKinds itself is expected to be deduped upstream, this only pins today's loop behaviour
  });
});

describe('watching-bucket split helpers', () => {
  const report = {
    watching: [
      { label: 'postgresql', detail: 'via DATABASE_URL', maturity: 'live_validated' as const },
      { label: 'kafka', detail: 'detected automatically', maturity: 'simulator_only' as const },
      { label: 'mongodb', detail: 'detected automatically' },
    ],
    blocked: [],
    invisible: [],
  };

  it('counts only explicitly live-validated entries as validated', () => {
    expect(liveValidatedWatching(report).map((e) => e.label)).toEqual(['postgresql']);
  });

  it('treats a missing maturity as best-effort', () => {
    expect(bestEffortWatching(report).map((e) => e.label)).toEqual(['kafka', 'mongodb']);
  });
});
