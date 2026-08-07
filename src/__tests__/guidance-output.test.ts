// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configure, setOutputOptions, printScanSummary, printDiagnosis } from '../cli/output.js';
import type { ScanResult } from '../cli/output.js';
import type { DiagnosisResult } from '../types/diagnosis-result.js';

function scanResultWithKeyFinding(): ScanResult {
  return {
    score: 40,
    findings: [{
      id: 'LLM-001',
      service: 'llm-provider (anthropic)',
      status: 'unhealthy',
      summary: 'Anthropic API key is not valid',
      confidence: 0.95,
      escalationLevel: 2,
      checkId: 'llm-provider.key_valid',
      guidancePlatforms: ['anthropic-console'],
      signals: [{ status: 'critical', detail: '401 authentication_error', source: 'llm_key_valid' }],
    }],
    recentChanges: [],
    scannedAt: '2026-08-05T12:00:00.000Z',
    durationMs: 120,
  };
}

describe('scan output — guidance', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    configure({ json: false, noColor: false, verbose: false, mode: 'human' });
    setOutputOptions({ terse: false });
  });

  it('human mode renders the numbered guide under the finding', () => {
    configure({ mode: 'human', noColor: true });
    printScanSummary(scanResultWithKeyFinding());
    const text = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(text).toContain('How to fix it: Rotate your Anthropic API key');
    expect(text).toContain('1. Open the Anthropic Console');
    expect(text).toContain('https://console.anthropic.com/settings/keys');
    expect(text).toContain('(path verified 2026-08-05)');
  });

  it('--terse collapses the guide to title and URL', () => {
    configure({ mode: 'human', noColor: true });
    setOutputOptions({ terse: true });
    printScanSummary(scanResultWithKeyFinding());
    const text = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(text).toContain('How to fix it: Rotate your Anthropic API key — https://console.anthropic.com/settings/keys');
    expect(text).not.toContain('1. Open the Anthropic Console');
  });

  it('pipe mode adds a guide:<id> reference column instead of the block', () => {
    configure({ mode: 'pipe', noColor: true });
    printScanSummary(scanResultWithKeyFinding());
    const lines = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    const fields = lines.find((l: string) => l.startsWith('finding\t'))!.split('\t');
    expect(fields).toHaveLength(7);
    // Scoped to anthropic-console, so the OpenAI rotate-key guide must not appear.
    expect(fields[6]).toBe('guide:anthropic-rotate-key');
    expect(lines.join('\n')).not.toContain('How to fix it');
  });

  it('pipe mode keeps the column present but empty when a finding has no guides', () => {
    configure({ mode: 'pipe', noColor: true });
    const result = scanResultWithKeyFinding();
    result.findings[0]!.checkId = 'nothing.matches';
    printScanSummary(result);
    const fields = logSpy.mock.calls.map((c: unknown[]) => String(c[0]))
      .find((l: string) => l.startsWith('finding\t'))!.split('\t');
    expect(fields).toHaveLength(7);
    expect(fields[6]).toBe('');
  });

  it('machine mode emits full guide objects under guides', () => {
    configure({ json: true, noColor: true });
    printScanSummary(scanResultWithKeyFinding());
    const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
    expect(parsed.type).toBe('scan');
    const guide = parsed.findings[0].guides[0];
    expect(guide.id).toBe('anthropic-rotate-key');
    expect(guide.consoleSteps.length).toBeGreaterThan(1);
    expect(guide.verifiedOn).toBe('2026-08-05');
  });

  // re-enabled in Task 9 (the aws-rds guides it asserts on are written there)
  it.skip('resolves aws-rds guide placeholders to concrete target values, not literal tokens', () => {
    configure({ mode: 'human', noColor: true });
    const result: ScanResult = {
      score: 55,
      findings: [{
        id: 'RDS-001',
        service: 'aws-rds (prod-db-01)',
        status: 'unhealthy',
        summary: 'RDS storage is full on instance prod-db-01',
        confidence: 0.95,
        escalationLevel: 2,
        guidancePlatforms: ['aws-rds'],
        signals: [{
          status: 'critical',
          detail: 'allocated storage exhausted',
          source: 'rds_storage',
          checkId: 'aws-rds.storage_full',
          guideVars: { instance: 'prod-db-01', 'target-storage-gb': '40' },
        }],
      }],
      recentChanges: [],
      scannedAt: '2026-08-05T12:00:00.000Z',
      durationMs: 90,
    };
    printScanSummary(result);
    const text = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(text).toContain('prod-db-01');
    expect(text).toContain('40 GiB');
    expect(text).not.toContain('<instance>');
    expect(text).not.toContain('<target-storage-gb>');
  });

  it('a finding with no matching checkId renders no guidance', () => {
    configure({ mode: 'human', noColor: true });
    const result = scanResultWithKeyFinding();
    result.findings[0]!.checkId = 'nothing.matches';
    printScanSummary(result);
    expect(logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).not.toContain('How to fix it');
  });
});

describe('diagnose output — guidance', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    configure({ json: false, noColor: false, verbose: false, mode: 'human' });
  });

  const diagnosis: DiagnosisResult = {
    status: 'identified',
    scenario: 'quota_exhausted',
    confidence: 0.9,
    findings: [{
      source: 'llm_provider_quota',
      observation: 'Anthropic credit balance is exhausted',
      severity: 'critical',
      checkId: 'llm-provider.quota_billing',
    }],
    diagnosticPlanNeeded: false,
  };

  it('human mode renders the guide under the finding', () => {
    configure({ mode: 'human', noColor: true });
    printDiagnosis(diagnosis, undefined, { platforms: ['anthropic-console'] });
    const text = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(text).toContain('How to fix it: Restore Anthropic billing or credit balance');
    expect(text).not.toContain('OpenAI');
  });

  it('machine mode carries guides on the finding', () => {
    configure({ json: true, noColor: true });
    printDiagnosis(diagnosis, undefined, { platforms: ['anthropic-console'] });
    const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
    expect(parsed.diagnosis.findings[0].guides.map((g: { id: string }) => g.id)).toEqual(['anthropic-billing-credits']);
  });

  it('without a scope, every platform that answers the check is offered', () => {
    configure({ json: true, noColor: true });
    printDiagnosis(diagnosis);
    const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
    const platforms = parsed.diagnosis.findings[0].guides.map((g: { platform: string }) => g.platform);
    expect(new Set(platforms)).toEqual(new Set(['anthropic-console', 'openai-platform']));
  });

  // re-enabled in Task 9 (the aws-rds guides it asserts on are written there)
  it.skip('resolves aws-rds guide placeholders to concrete target values, not literal tokens', () => {
    configure({ mode: 'human', noColor: true });
    const rdsDiagnosis: DiagnosisResult = {
      status: 'identified',
      scenario: 'storage_full',
      confidence: 0.9,
      findings: [{
        source: 'rds_storage',
        observation: 'RDS storage is full on instance prod-db-01',
        severity: 'critical',
        checkId: 'aws-rds.storage_full',
        guideVars: { instance: 'prod-db-01', 'target-storage-gb': '40' },
      }],
      diagnosticPlanNeeded: false,
    };
    printDiagnosis(rdsDiagnosis, undefined, { platforms: ['aws-rds'] });
    const text = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(text).toContain('prod-db-01');
    expect(text).toContain('40 GiB');
    expect(text).not.toContain('<instance>');
    expect(text).not.toContain('<target-storage-gb>');
  });
});
