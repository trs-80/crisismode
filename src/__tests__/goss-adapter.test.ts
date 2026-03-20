// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import type { GossTestResult } from '../framework/goss-adapter.js';
import {
  parseGossOutput,
  gossToHealthResult,
  gossToDiagnoseResult,
} from '../framework/goss-adapter.js';

function makeGossResult(overrides: Partial<GossTestResult> = {}): GossTestResult {
  return {
    successful: true,
    skipped: false,
    'resource-id': 'sshd',
    'resource-type': 'Service',
    property: 'running',
    title: '',
    meta: null,
    result: 0,
    err: null,
    'matcher-result': { actual: true, expected: [true], message: 'to equal' },
    'start-time': '2024-01-15T10:30:00.000Z',
    'end-time': '2024-01-15T10:30:00.050Z',
    duration: 50000000,
    'summary-line': 'Service: sshd: running: matches expectation: [true]',
    'summary-line-compact': 'Service: sshd: running: matches expectation: [true]',
    ...overrides,
  };
}

function makeGossJson(
  results: GossTestResult[],
  summaryOverrides: Record<string, unknown> = {},
) {
  const failed = results.filter((r) => r.result === 1).length;
  const skipped = results.filter((r) => r.result === 2 || r.skipped).length;
  return JSON.stringify({
    results,
    summary: {
      'test-count': results.length,
      'failed-count': failed,
      'skipped-count': skipped,
      'total-duration': 120000000,
      'summary-line': `Count: ${results.length}, Failed: ${failed}, Skipped: ${skipped}`,
      ...summaryOverrides,
    },
  });
}

describe('parseGossOutput', () => {
  it('all tests pass (exit code 0)', () => {
    const results = [
      makeGossResult(),
      makeGossResult({
        'resource-id': '22',
        'resource-type': 'Port',
        property: 'listening',
        'summary-line': 'Port: 22: listening: matches expectation: [true]',
      }),
    ];
    const parsed = parseGossOutput(makeGossJson(results), 0);

    expect(parsed.healthStatus).toBe('healthy');
    expect(parsed.passed).toBe(2);
    expect(parsed.failed).toBe(0);
    expect(parsed.skipped).toBe(0);
    expect(parsed.total).toBe(2);
  });

  it('some failures (exit code 1)', () => {
    const results = [
      makeGossResult(),
      makeGossResult({
        successful: false,
        'resource-id': 'nginx',
        'resource-type': 'Service',
        property: 'running',
        result: 1,
        'matcher-result': { actual: false, expected: [true], message: 'to equal' },
        'summary-line': 'Service: nginx: running: Expected [true] but got false',
      }),
    ];
    const parsed = parseGossOutput(makeGossJson(results), 1);

    expect(parsed.healthStatus).toBe('unhealthy');
    expect(parsed.passed).toBe(1);
    expect(parsed.failed).toBe(1);
    expect(parsed.total).toBe(2);
  });

  it('mixed pass/fail/skip', () => {
    const results = [
      makeGossResult(),
      makeGossResult({
        successful: false,
        'resource-id': 'nginx',
        'resource-type': 'Service',
        property: 'running',
        result: 1,
      }),
      makeGossResult({
        skipped: true,
        'resource-id': 'httpd',
        'resource-type': 'Package',
        property: 'installed',
        result: 2,
      }),
    ];
    const parsed = parseGossOutput(makeGossJson(results), 1);

    expect(parsed.healthStatus).toBe('unhealthy');
    expect(parsed.passed).toBe(1);
    expect(parsed.failed).toBe(1);
    expect(parsed.skipped).toBe(1);
    expect(parsed.total).toBe(3);
  });

  it('all skipped', () => {
    const results = [
      makeGossResult({ skipped: true, result: 2, 'resource-id': 'sshd' }),
      makeGossResult({ skipped: true, result: 2, 'resource-id': 'nginx' }),
    ];
    const parsed = parseGossOutput(makeGossJson(results), 0);

    expect(parsed.healthStatus).toBe('unknown');
    expect(parsed.skipped).toBe(2);
    expect(parsed.passed).toBe(0);
    expect(parsed.failed).toBe(0);
  });

  it('empty results array', () => {
    const parsed = parseGossOutput(makeGossJson([]), 0);

    expect(parsed.healthStatus).toBe('unknown');
    expect(parsed.total).toBe(0);
    expect(parsed.passed).toBe(0);
    expect(parsed.failed).toBe(0);
    expect(parsed.skipped).toBe(0);
  });

  it('malformed JSON (not JSON at all)', () => {
    const parsed = parseGossOutput('Error: goss binary not found', 1);

    expect(parsed.healthStatus).toBe('unhealthy');
    expect(parsed.results).toEqual([]);
    expect(parsed.total).toBe(0);
    expect(parsed.summary['summary-line']).toContain('Failed to parse goss output');
    expect(parsed.summary['summary-line']).toContain('Error: goss binary not found');
  });

  it('empty stdout', () => {
    const parsed = parseGossOutput('', 2);

    expect(parsed.healthStatus).toBe('unhealthy');
    expect(parsed.results).toEqual([]);
    expect(parsed.total).toBe(0);
    expect(parsed.summary['summary-line']).toContain('Failed to parse goss output');
  });

  it('missing summary field in JSON', () => {
    const json = JSON.stringify({
      results: [makeGossResult()],
    });
    const parsed = parseGossOutput(json, 0);

    expect(parsed.healthStatus).toBe('healthy');
    expect(parsed.total).toBe(1);
    expect(parsed.summary['test-count']).toBe(1);
    expect(parsed.summary['summary-line']).toBe('');
  });

  it('missing results field in JSON', () => {
    const json = JSON.stringify({
      summary: {
        'test-count': 0,
        'failed-count': 0,
        'skipped-count': 0,
        'total-duration': 0,
        'summary-line': 'Count: 0, Failed: 0, Skipped: 0',
      },
    });
    const parsed = parseGossOutput(json, 0);

    expect(parsed.healthStatus).toBe('unknown');
    expect(parsed.results).toEqual([]);
    expect(parsed.total).toBe(0);
  });
});

describe('gossToHealthResult', () => {
  it('all tests pass — single summary signal', () => {
    const results = [
      makeGossResult(),
      makeGossResult({
        'resource-id': '22',
        'resource-type': 'Port',
        property: 'listening',
      }),
    ];
    const parsed = parseGossOutput(makeGossJson(results), 0);
    const health = gossToHealthResult(parsed);

    expect(health.status).toBe('healthy');
    expect(health.confidence).toBe(0.9);
    expect(health.signals).toHaveLength(1);
    expect(health.signals![0].source).toBe('goss');
    expect(health.signals![0].status).toBe('healthy');
    expect(health.signals![0].detail).toContain('2');
  });

  it('failed tests — one signal per failure with critical status', () => {
    const results = [
      makeGossResult({
        successful: false,
        'resource-id': 'sshd',
        'resource-type': 'Service',
        property: 'running',
        result: 1,
        'summary-line': 'Service: sshd: running: Expected [true] but got false',
      }),
      makeGossResult({
        successful: false,
        'resource-id': '8080',
        'resource-type': 'Port',
        property: 'listening',
        result: 1,
        'summary-line': 'Port: 8080: listening: Expected [true] but got false',
      }),
    ];
    const parsed = parseGossOutput(makeGossJson(results), 1);
    const health = gossToHealthResult(parsed);

    expect(health.status).toBe('unhealthy');
    expect(health.signals).toHaveLength(2);
    expect(health.signals![0].source).toBe('Service:sshd');
    expect(health.signals![0].status).toBe('critical');
    expect(health.signals![1].source).toBe('Port:8080');
    expect(health.signals![1].status).toBe('critical');
  });

  it('skipped tests — one signal per skip with unknown status', () => {
    const results = [
      makeGossResult({
        skipped: true,
        'resource-id': '/etc/nginx/nginx.conf',
        'resource-type': 'File',
        property: 'exists',
        result: 2,
        'summary-line': 'File: /etc/nginx/nginx.conf: exists: skipped',
      }),
    ];
    const parsed = parseGossOutput(makeGossJson(results), 0);
    const health = gossToHealthResult(parsed);

    expect(health.signals).toHaveLength(1);
    expect(health.signals![0].source).toBe('File:/etc/nginx/nginx.conf');
    expect(health.signals![0].status).toBe('unknown');
  });

  it('mixed failures and skips — signals for both, none for passing', () => {
    const results = [
      makeGossResult(), // pass — no signal
      makeGossResult({
        successful: false,
        'resource-id': 'nginx',
        'resource-type': 'Service',
        property: 'running',
        result: 1,
        'summary-line': 'Service: nginx: running: failed',
      }),
      makeGossResult({
        skipped: true,
        'resource-id': 'redis',
        'resource-type': 'Package',
        property: 'installed',
        result: 2,
        'summary-line': 'Package: redis: installed: skipped',
      }),
    ];
    const parsed = parseGossOutput(makeGossJson(results), 1);
    const health = gossToHealthResult(parsed);

    expect(health.signals).toHaveLength(2);
    expect(health.signals![0].status).toBe('critical');
    expect(health.signals![0].source).toBe('Service:nginx');
    expect(health.signals![1].status).toBe('unknown');
    expect(health.signals![1].source).toBe('Package:redis');
  });

  it('no results — empty signals', () => {
    const parsed = parseGossOutput(makeGossJson([]), 0);
    const health = gossToHealthResult(parsed);

    expect(health.status).toBe('unknown');
    expect(health.signals).toHaveLength(0);
  });
});

describe('gossToDiagnoseResult', () => {
  it('all tests pass — healthy with empty findings', () => {
    const results = [
      makeGossResult(),
      makeGossResult({
        'resource-id': '/etc/hosts',
        'resource-type': 'File',
        property: 'exists',
      }),
    ];
    const parsed = parseGossOutput(makeGossJson(results), 0);
    const diag = gossToDiagnoseResult(parsed);

    expect(diag.healthy).toBe(true);
    expect(diag.findings).toHaveLength(0);
  });

  it('failed tests — one finding per failure with correct id and evidence', () => {
    const results = [
      makeGossResult({
        successful: false,
        'resource-id': 'sshd',
        'resource-type': 'Service',
        property: 'running',
        result: 1,
        'matcher-result': { actual: false, expected: [true], message: 'to equal' },
        'summary-line': 'Service: sshd: running: Expected [true] but got false',
      }),
      makeGossResult({
        successful: false,
        'resource-id': '443',
        'resource-type': 'Port',
        property: 'listening',
        result: 1,
        'matcher-result': { actual: false, expected: [true], message: 'to equal' },
        'summary-line': 'Port: 443: listening: Expected [true] but got false',
      }),
    ];
    const parsed = parseGossOutput(makeGossJson(results), 1);
    const diag = gossToDiagnoseResult(parsed);

    expect(diag.healthy).toBe(false);
    expect(diag.findings).toHaveLength(2);

    expect(diag.findings[0].id).toBe('goss-service-sshd-running');
    expect(diag.findings[0].severity).toBe('warning');
    expect(diag.findings[0].title).toBe('Service: sshd: running failed');
    expect(diag.findings[0].evidence).toEqual({
      actual: false,
      expected: [true],
      resourceType: 'Service',
      resourceId: 'sshd',
      property: 'running',
    });

    expect(diag.findings[1].id).toBe('goss-port-443-listening');
    expect(diag.findings[1].evidence).toEqual({
      actual: false,
      expected: [true],
      resourceType: 'Port',
      resourceId: '443',
      property: 'listening',
    });
  });

  it('mixed pass/fail — only failed tests produce findings', () => {
    const results = [
      makeGossResult(), // pass
      makeGossResult({
        successful: false,
        'resource-id': 'curl',
        'resource-type': 'Package',
        property: 'installed',
        result: 1,
        'matcher-result': { actual: false, expected: [true], message: 'to equal' },
        'summary-line': 'Package: curl: installed: Expected [true] but got false',
      }),
    ];
    const parsed = parseGossOutput(makeGossJson(results), 1);
    const diag = gossToDiagnoseResult(parsed);

    expect(diag.healthy).toBe(false);
    expect(diag.findings).toHaveLength(1);
    expect(diag.findings[0].id).toBe('goss-package-curl-installed');
  });

  it('skipped tests — no findings produced', () => {
    const results = [
      makeGossResult({
        skipped: true,
        'resource-id': 'httpd',
        'resource-type': 'Service',
        property: 'running',
        result: 2,
      }),
    ];
    const parsed = parseGossOutput(makeGossJson(results), 0);
    const diag = gossToDiagnoseResult(parsed);

    expect(diag.healthy).toBe(true);
    expect(diag.findings).toHaveLength(0);
  });

  it('all failures — healthy false, all findings present', () => {
    const results = [
      makeGossResult({
        successful: false,
        'resource-id': 'sshd',
        'resource-type': 'Service',
        property: 'running',
        result: 1,
      }),
      makeGossResult({
        successful: false,
        'resource-id': '/var/log/app.log',
        'resource-type': 'File',
        property: 'exists',
        result: 1,
      }),
      makeGossResult({
        successful: false,
        'resource-id': '5432',
        'resource-type': 'Port',
        property: 'listening',
        result: 1,
      }),
    ];
    const parsed = parseGossOutput(makeGossJson(results), 1);
    const diag = gossToDiagnoseResult(parsed);

    expect(diag.healthy).toBe(false);
    expect(diag.findings).toHaveLength(3);
    expect(diag.findings[0].id).toBe('goss-service-sshd-running');
    expect(diag.findings[1].id).toBe('goss-file--var-log-app-log-exists');
    expect(diag.findings[2].id).toBe('goss-port-5432-listening');
  });
});
