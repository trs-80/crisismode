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
  it('maps a provider-named llm-provider target to that provider\'s console', () => {
    expect(platformsForTarget('llm-provider', 'anthropic')).toEqual(['anthropic-console']);
    expect(platformsForTarget('llm-provider', 'openai')).toEqual(['openai-platform']);
  });

  it('returns an empty list for a provider with no guides, never another vendor\'s', () => {
    expect(platformsForTarget('llm-provider', 'google')).toEqual([]);
    expect(platformsForTarget('llm-provider', 'openrouter')).toEqual([]);
    expect(platformsForTarget('vector-store', 'pinecone')).toEqual([]);
  });

  it('scopes aws-rds targets to the aws-rds platform', () => {
    expect(platformsForTarget('aws-rds', 'prod-db-01')).toEqual(['aws-rds']);
  });

  it('leaves the platform unknown for a plain postgres target', () => {
    expect(platformsForTarget('postgresql', 'primary')).toBeUndefined();
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
});
