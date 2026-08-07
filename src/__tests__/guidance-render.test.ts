// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import {
  renderGuideLines, renderGuidesLines, guideReference, formatGuideForPlan,
} from '../framework/guidance/render.js';
import { attachGuidesToScanFinding, attachGuidesByRuleId, attachGuidesToDiagnosis } from '../framework/guidance/attach.js';
import { getGuideById } from '../framework/guidance/registry.js';
import type { RemediationGuide } from '../types/remediation-guide.js';
import type { DiagnosisResult } from '../types/diagnosis-result.js';

const guide: RemediationGuide = {
  id: 'test-guide',
  platform: 'test-console',
  title: 'Rotate the thing',
  applicableFindingTypes: ['llm-provider.key_valid'],
  url: 'https://console.example.com/keys',
  consoleSteps: ['Open the console.', 'Create a key.'],
  cliEquivalent: 'example keys create',
  expectedAfter: 'The key check passes.',
  caution: 'The old key stops working.',
  verifiedOn: '2026-08-05',
};

describe('renderGuideLines', () => {
  it('renders title, url, numbered steps, cli, expectation, caution, and freshness', () => {
    expect(renderGuideLines(guide)).toEqual([
      'How to fix it: Rotate the thing',
      '  Open: https://console.example.com/keys',
      '  1. Open the console.',
      '  2. Create a key.',
      '  CLI: example keys create',
      '  Expect: The key check passes.',
      '  Caution: The old key stops working.',
      '  (path verified 2026-08-05)',
    ]);
  });

  it('omits optional lines a guide does not carry', () => {
    const minimal: RemediationGuide = {
      id: 'minimal', platform: 'test-console', title: 'Do it',
      applicableFindingTypes: ['llm-provider.key_valid'],
      consoleSteps: ['Click.'], expectedAfter: 'Done.', verifiedOn: '2026-08-05',
    };
    expect(renderGuideLines(minimal)).toEqual([
      'How to fix it: Do it',
      '  1. Click.',
      '  Expect: Done.',
      '  (path verified 2026-08-05)',
    ]);
  });

  it('collapses to title and URL in terse mode', () => {
    expect(renderGuideLines(guide, { terse: true })).toEqual([
      'How to fix it: Rotate the thing — https://console.example.com/keys',
    ]);
  });

  it('separates multiple guides with a blank line', () => {
    const lines = renderGuidesLines([guide, guide]);
    expect(lines.filter((l) => l === '')).toHaveLength(1);
  });
});

describe('guideReference', () => {
  it('builds a pipe-mode reference token', () => {
    expect(guideReference([guide])).toBe('guide:test-guide');
    expect(guideReference([guide, { ...guide, id: 'other' }])).toBe('guide:test-guide,other');
  });

  it('is empty when there are no guides', () => {
    expect(guideReference([])).toBe('');
  });
});

describe('formatGuideForPlan', () => {
  it('renders the full guide as one newline-joined block', () => {
    const text = formatGuideForPlan(guide);
    expect(text.split('\n')[0]).toBe('How to fix it: Rotate the thing');
    expect(text).toContain('  1. Open the console.');
  });
});

describe('attachment', () => {
  it('attaches guides to a scan finding by its own checkId', () => {
    const finding = attachGuidesToScanFinding({ checkId: 'llm-provider.key_valid', signals: [] });
    expect(finding.guides?.map((g) => g.id)).toContain('anthropic-rotate-key');
  });

  it('attaches guides from a signal checkId when the finding has none', () => {
    const finding = attachGuidesToScanFinding({
      signals: [{ checkId: 'llm-provider.quota_billing' }, { checkId: undefined }],
    });
    expect(finding.guides?.map((g) => g.id)).toContain('anthropic-billing-credits');
  });

  it('leaves a finding untouched when nothing matches', () => {
    const finding = attachGuidesToScanFinding({ checkId: 'nothing.matches', signals: [] });
    expect(finding.guides).toBeUndefined();
  });

  it('attaches guides to a readiness finding by rule id', () => {
    const finding = attachGuidesByRuleId({ ruleId: 'serverless-pooling' });
    expect(finding.guides?.map((g) => g.id)).toContain('supabase-pooler-mode');
  });

  it('honors the finding\'s platform scope', () => {
    const scoped = attachGuidesToScanFinding({
      checkId: 'llm-provider.key_valid',
      signals: [],
      guidancePlatforms: ['anthropic-console'],
    });
    expect(scoped.guides?.map((g) => g.id)).toEqual(['anthropic-rotate-key']);

    const unguided = attachGuidesToScanFinding({
      checkId: 'llm-provider.key_valid',
      signals: [],
      guidancePlatforms: [],
    });
    expect(unguided.guides).toBeUndefined();
  });

  it('attaches guides to diagnosis findings by checkId', () => {
    const diagnosis: DiagnosisResult = {
      status: 'identified',
      scenario: 'storage_full',
      confidence: 0.9,
      findings: [
        { source: 'rds_storage', observation: 'full', severity: 'critical', checkId: 'aws-rds.storage_full' },
        { source: 'rds_backup_config', observation: 'fine', severity: 'info' },
      ],
      diagnosticPlanNeeded: false,
    };
    const attached = attachGuidesToDiagnosis(diagnosis);
    expect(attached.findings[0]!.guides?.map((g) => g.id)).toContain('aws-rds-increase-storage');
    expect(attached.findings[1]!.guides).toBeUndefined();
  });

  it('does not mutate the guide in the registry when attaching', () => {
    const before = JSON.stringify(getGuideById('anthropic-rotate-key'));
    attachGuidesToScanFinding({ checkId: 'llm-provider.key_valid', signals: [] });
    expect(JSON.stringify(getGuideById('anthropic-rotate-key'))).toBe(before);
  });
});
