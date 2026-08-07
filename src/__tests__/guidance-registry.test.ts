// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import type { RemediationGuide } from '../types/remediation-guide.js';

describe('RemediationGuide type', () => {
  it('accepts a guide with every field populated', () => {
    const guide: RemediationGuide = {
      id: 'example-guide',
      platform: 'example-console',
      title: 'Do the thing',
      applicableFindingTypes: ['example.check'],
      url: 'https://example.com/console',
      consoleSteps: ['Open the console.', 'Click the button.'],
      cliEquivalent: 'example-cli do-the-thing',
      expectedAfter: 'The thing is done.',
      caution: 'The thing cannot be undone.',
      verifiedOn: '2026-08-05',
    };
    expect(guide.consoleSteps).toHaveLength(2);
  });

  it('accepts a guide with only the required fields', () => {
    const guide: RemediationGuide = {
      id: 'minimal-guide',
      platform: 'example-console',
      title: 'Minimal',
      applicableFindingTypes: ['example.check'],
      consoleSteps: ['Open the console.'],
      expectedAfter: 'Something observable happened.',
      verifiedOn: '2026-08-05',
    };
    expect(guide.url).toBeUndefined();
  });
});

import {
  REMEDIATION_GUIDES,
  guidesForFindingType,
  guidesForFindingTypes,
  getGuideById,
  applyGuideVariables,
} from '../framework/guidance/registry.js';
import { platformsForTarget } from '../framework/guidance/platforms.js';
// Every agent's check ids live in its own check-ids.ts as a keyed object.
import { allRules } from '../readiness/rules/index.js';
import { AWS_RDS_CHECK_IDS } from '../agent/aws-rds/check-ids.js';
import { LLM_PROVIDER_CHECK_IDS } from '../agent/llm-provider/check-ids.js';
import { VECTOR_STORE_CHECK_IDS } from '../agent/vector-store/check-ids.js';

describe('guidance registry — structure', () => {
  it('has no duplicate guide ids', () => {
    const seen = new Set<string>();
    for (const g of REMEDIATION_GUIDES) {
      expect(seen.has(g.id), `duplicate guide id '${g.id}'`).toBe(false);
      seen.add(g.id);
    }
  });

  it('every guide has non-empty required content', () => {
    for (const g of REMEDIATION_GUIDES) {
      expect(g.id.length, 'guide id must be non-empty').toBeGreaterThan(0);
      expect(g.platform.length, `guide '${g.id}' has an empty platform`).toBeGreaterThan(0);
      expect(g.title.length, `guide '${g.id}' has an empty title`).toBeGreaterThan(0);
      expect(g.consoleSteps.length, `guide '${g.id}' has no console steps`).toBeGreaterThan(0);
      for (const step of g.consoleSteps) {
        expect(step.trim().length, `guide '${g.id}' has an empty console step`).toBeGreaterThan(0);
      }
      expect(g.expectedAfter.trim().length, `guide '${g.id}' has no expectedAfter`).toBeGreaterThan(0);
      expect(g.applicableFindingTypes.length, `guide '${g.id}' is not keyed to any finding type`).toBeGreaterThan(0);
    }
  });

  it('every verifiedOn is a parseable ISO date', () => {
    for (const g of REMEDIATION_GUIDES) {
      expect(g.verifiedOn, `guide '${g.id}' has a malformed verifiedOn`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(
        Number.isNaN(Date.parse(g.verifiedOn)),
        `guide '${g.id}' verifiedOn does not parse as a date`,
      ).toBe(false);
    }
  });

  it('every url is https', () => {
    for (const g of REMEDIATION_GUIDES) {
      if (g.url !== undefined) {
        expect(g.url, `guide '${g.id}' has a non-https url`).toMatch(/^https:\/\//);
      }
    }
  });
});

describe('guidance registry — lookup', () => {
  it('finds the Anthropic key-rotation guide by its finding type', () => {
    const guides = guidesForFindingType('llm-provider.key_valid');
    expect(guides.map((g) => g.id)).toContain('anthropic-rotate-key');
  });

  it('returns an empty array for a finding type with no guides', () => {
    expect(guidesForFindingType('nothing.matches_this')).toEqual([]);
  });

  it('dedupes guides matched through more than one finding type', () => {
    const ids = guidesForFindingTypes(['llm-provider.key_valid', 'llm-provider.key_valid']).map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('looks a guide up by id', () => {
    expect(getGuideById('anthropic-rotate-key')?.platform).toBe('anthropic-console');
    expect(getGuideById('no-such-guide')).toBeUndefined();
  });
});

describe('guidance scope — platform filtering', () => {
  it('keeps only guides for the scoped platform', () => {
    const ids = guidesForFindingType('llm-provider.key_valid', { platforms: ['anthropic-console'] }).map((g) => g.id);
    expect(ids).toContain('anthropic-rotate-key');
    expect(ids).not.toContain('openai-rotate-key');
  });

  it('an empty platform list means the caller knows the platform and has no guides for it', () => {
    expect(guidesForFindingType('llm-provider.key_valid', { platforms: [] })).toEqual([]);
  });

  it('an absent scope means the platform is unknown — every match attaches', () => {
    expect(guidesForFindingType('llm-provider.key_valid').length).toBeGreaterThan(0);
  });
});

describe('platformsForTarget', () => {
  // autodiscovery.ts (src/cli/autodiscovery.ts) deliberately never emits a
  // bare 'llm-provider' kind — every derived target's kind is
  // `llm-provider.${provider}` (e.g. 'llm-provider.anthropic'), with a
  // matching derived name like 'derived-llm-anthropic'. These are the real
  // kind/name shapes scan.ts and diagnose.ts pass to platformsForTarget.
  it('maps a per-provider llm-provider kind to that provider\'s console', () => {
    expect(platformsForTarget('llm-provider.anthropic', 'derived-llm-anthropic')).toEqual(['anthropic-console']);
    expect(platformsForTarget('llm-provider.openai', 'derived-llm-openai')).toEqual(['openai-platform']);
  });

  it('returns an empty list for a per-provider kind with no guides, never another vendor\'s', () => {
    expect(platformsForTarget('llm-provider.google', 'derived-llm-google')).toEqual([]);
    expect(platformsForTarget('llm-provider.openrouter', 'derived-llm-openrouter')).toEqual([]);
    expect(platformsForTarget('vector-store', 'pinecone')).toEqual([]);
  });

  it('scopes aws-rds targets to the aws-rds platform', () => {
    expect(platformsForTarget('aws-rds', 'prod-db-01')).toEqual(['aws-rds']);
  });

  it('leaves the platform unknown for a plain postgres target', () => {
    expect(platformsForTarget('postgresql', 'primary')).toBeUndefined();
  });

  it('still recognizes the bare "llm-provider" kind as a defensive fallback', () => {
    // No real caller emits this bare kind (see above), but platformsForTarget
    // should not regress on it if something else ever does.
    expect(platformsForTarget('llm-provider', 'anthropic')).toEqual(['anthropic-console']);
    expect(platformsForTarget('llm-provider', 'openai')).toEqual(['openai-platform']);
  });

  it('does not treat an unrelated kind that merely starts with the same prefix as llm-provider', () => {
    expect(platformsForTarget('llm-provider-legacy', 'anthropic')).toBeUndefined();
  });
});

describe('applyGuideVariables', () => {
  it('substitutes placeholder tokens across every text field', () => {
    const guide: RemediationGuide = {
      id: 'token-test',
      platform: 'aws-rds',
      title: 'Resize <instance>',
      applicableFindingTypes: ['aws-rds.storage_full'],
      consoleSteps: ['Open Databases → <instance>.', 'Set storage to <target-storage-gb> GiB.'],
      cliEquivalent: 'aws rds modify-db-instance --db-instance-identifier <instance>',
      expectedAfter: '<instance> returns to available.',
      caution: 'Resizing <instance> reboots it.',
      verifiedOn: '2026-08-05',
    };

    const resolved = applyGuideVariables(guide, { instance: 'prod-db-01', 'target-storage-gb': '40' });

    expect(resolved.title).toBe('Resize prod-db-01');
    expect(resolved.consoleSteps[1]).toBe('Set storage to 40 GiB.');
    expect(resolved.cliEquivalent).toContain('prod-db-01');
    expect(resolved.expectedAfter).toBe('prod-db-01 returns to available.');
    expect(resolved.caution).toBe('Resizing prod-db-01 reboots it.');
  });

  it('leaves unknown tokens in place and does not mutate the original', () => {
    const guide = getGuideById('anthropic-rotate-key')!;
    const before = JSON.stringify(guide);
    const resolved = applyGuideVariables(guide, { instance: 'prod-db-01' });
    expect(JSON.stringify(guide)).toBe(before);
    expect(resolved.id).toBe(guide.id);
  });

  it('leaves a specific unsupplied token literally in place when only some tokens are resolved', () => {
    const guide: RemediationGuide = {
      id: 'partial-token-test',
      platform: 'aws-rds',
      title: 'Resize <instance> in <region>',
      applicableFindingTypes: ['aws-rds.storage_full'],
      consoleSteps: ['Open Databases → <instance> in <region>.'],
      expectedAfter: '<instance> in <region> returns to available.',
      verifiedOn: '2026-08-05',
    };

    // Only 'instance' is supplied — 'region' is deliberately left unknown.
    const resolved = applyGuideVariables(guide, { instance: 'prod-db-01' });

    expect(resolved.title).toBe('Resize prod-db-01 in <region>');
    expect(resolved.consoleSteps[0]).toContain('<region>');
    expect(resolved.expectedAfter).toContain('<region>');
  });
});

describe('guidance registry — content coverage', () => {
  const expectedIdsByPlatform: Record<string, string[]> = {
    'anthropic-console': ['anthropic-rotate-key', 'anthropic-rate-limits', 'anthropic-billing-credits'],
    'openai-platform': ['openai-rotate-key', 'openai-usage-limits', 'openai-billing'],
    supabase: [
      'supabase-pooler-mode',
      'supabase-connection-limits',
      'supabase-upgrade-compute',
      'supabase-pgvector-index',
    ],
    neon: ['neon-pooled-connection', 'neon-compute-size'],
  };

  for (const [platform, ids] of Object.entries(expectedIdsByPlatform)) {
    it(`${platform} guides are registered`, () => {
      const registered = REMEDIATION_GUIDES.filter((g) => g.platform === platform).map((g) => g.id);
      for (const id of ids) expect(registered).toContain(id);
    });
  }

  it('serverless pooling findings reach both Supabase and Neon guides', () => {
    const ids = guidesForFindingType('serverless-pooling').map((g) => g.id);
    expect(ids).toContain('supabase-pooler-mode');
    expect(ids).toContain('neon-pooled-connection');
  });

  it('the pgvector index guide answers both vector readiness rules', () => {
    expect(guidesForFindingType('vector-index-missing').map((g) => g.id)).toContain('supabase-pgvector-index');
    expect(guidesForFindingType('ivfflat-lists-mismatch').map((g) => g.id)).toContain('supabase-pgvector-index');
  });

  it('OpenAI quota findings reach a billing guide', () => {
    expect(guidesForFindingType('llm-provider.quota_billing').map((g) => g.id)).toContain('openai-billing');
  });

  it('an Anthropic-scoped finding never surfaces OpenAI steps, and vice versa', () => {
    // Realistic kind/name pair, as autodiscovery.ts derives them — not the
    // bare 'llm-provider' kind, which no real target ever carries.
    const anthropic = guidesForFindingTypes(
      ['llm-provider.key_valid', 'llm-provider.quota_billing', 'llm-provider.rate_limit_headroom'],
      { platforms: platformsForTarget('llm-provider.anthropic', 'derived-llm-anthropic') },
    );
    expect(anthropic.every((g) => g.platform === 'anthropic-console')).toBe(true);
    expect(anthropic.length).toBeGreaterThan(0);

    const openai = guidesForFindingTypes(
      ['llm-provider.key_valid', 'llm-provider.quota_billing'],
      { platforms: platformsForTarget('llm-provider.openai', 'derived-llm-openai') },
    );
    expect(openai.every((g) => g.platform === 'openai-platform')).toBe(true);
    expect(openai.map((g) => g.id)).not.toContain('anthropic-rotate-key');
  });

  it('a provider with no guides gets nothing rather than another vendor\'s console', () => {
    const google = guidesForFindingTypes(
      ['llm-provider.key_valid'],
      { platforms: platformsForTarget('llm-provider.google', 'derived-llm-google') },
    );
    expect(google).toEqual([]);
  });
});

describe('guidance freshness', () => {
  /**
   * Console paths rot silently. This test is the nudge: when a guide's path
   * has not been human-verified in 12 months, the build fails and someone
   * re-walks it. Output shows the date regardless — this is a contributor
   * policy, not a runtime behavior.
   */
  const TWELVE_MONTHS_MS = 365 * 24 * 60 * 60 * 1000;

  it('every guide was verified within the last 12 months', () => {
    const now = Date.now();
    for (const guide of REMEDIATION_GUIDES) {
      const verifiedAt = Date.parse(guide.verifiedOn);
      const ageDays = Math.floor((now - verifiedAt) / (24 * 60 * 60 * 1000));
      expect(
        now - verifiedAt,
        `guide '${guide.id}' was last verified on ${guide.verifiedOn} (${ageDays} days ago). `
          + 'Follow the console path, correct the steps if they changed, and update verifiedOn.',
      ).toBeLessThan(TWELVE_MONTHS_MS);
    }
  });

  it('no guide claims a verification date in the future', () => {
    const now = Date.now();
    for (const guide of REMEDIATION_GUIDES) {
      expect(
        Date.parse(guide.verifiedOn),
        `guide '${guide.id}' has a verifiedOn in the future (${guide.verifiedOn})`,
      ).toBeLessThanOrEqual(now + 24 * 60 * 60 * 1000);
    }
  });
});

/**
 * The anchoring contract: a guide's applicableFindingTypes must name something
 * the codebase actually emits — a registered readiness rule id, or a checkId
 * constant exported by an agent. Renaming a rule or a check then breaks this
 * test, instead of silently orphaning its guidance at runtime.
 */
describe('guidance anchoring', () => {
  const knownFindingTypes = new Set<string>([
    ...allRules.map((rule) => rule.id),
    ...Object.values(AWS_RDS_CHECK_IDS),
    ...Object.values(LLM_PROVIDER_CHECK_IDS),
    ...Object.values(VECTOR_STORE_CHECK_IDS),
  ]);

  it('every applicableFindingTypes entry resolves to a rule id or a checkId', () => {
    for (const guide of REMEDIATION_GUIDES) {
      for (const findingType of guide.applicableFindingTypes) {
        expect(
          knownFindingTypes.has(findingType),
          `guide '${guide.id}' is keyed to '${findingType}', which is neither a registered readiness `
            + 'rule id nor an exported agent checkId. Either the guide is stale or the rule/check was renamed.',
        ).toBe(true);
      }
    }
  });

  it('each aws-rds checkId maps back from its diagnosis finding source', async () => {
    const { checkIdForRdsSource } = await import('../agent/aws-rds/check-ids.js');
    expect(checkIdForRdsSource('rds_storage')).toBe(AWS_RDS_CHECK_IDS.storageFull);
    expect(checkIdForRdsSource('rds_connection_saturation')).toBe(AWS_RDS_CHECK_IDS.connectionSaturation);
    expect(checkIdForRdsSource('rds_security_group')).toBe(AWS_RDS_CHECK_IDS.securityGroup);
    expect(checkIdForRdsSource('rds_instance_status')).toBe(AWS_RDS_CHECK_IDS.instanceStatus);
    expect(checkIdForRdsSource('rds_backup_config')).toBeUndefined();
  });
});
