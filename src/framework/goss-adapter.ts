// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Goss YAML assertion runner output adapter.
 *
 * Translates the Goss JSON validation output into CrisisMode check results.
 * Goss is a YAML-based serverspec alternative for validating system state —
 * services, packages, files, ports, processes, and more.
 *
 * Goss JSON output format (`goss validate --format json`):
 *   { results: GossTestResult[], summary: GossSummary }
 *
 * Result status values:
 *   0 = SUCCESS, 1 = FAIL, 2 = SKIP, 3 = UNKNOWN
 *
 * Exit codes:
 *   0 = all passed, 1 = failures present
 *
 * Duration is in nanoseconds.
 *
 * This adapter converts Goss output to CheckHealthResult or CheckDiagnoseResult
 * depending on the requested verb.
 */

import type { HealthStatus } from '../types/health.js';
import type {
  CheckHealthResult,
  CheckDiagnoseResult,
  CheckSignal,
  CheckFinding,
} from './check-plugin.js';

// ── Goss output types ──

export interface GossMatcherResult {
  actual: unknown;
  expected: unknown[];
  message: string;
}

export interface GossTestResult {
  successful: boolean;
  skipped: boolean;
  'resource-id': string;
  'resource-type': string;
  property: string;
  title: string;
  meta: Record<string, unknown> | null;
  result: number;
  err: unknown | null;
  'matcher-result': GossMatcherResult;
  'start-time': string;
  'end-time': string;
  duration: number;
  'summary-line': string;
  'summary-line-compact': string;
}

export interface GossSummary {
  'test-count': number;
  'failed-count': number;
  'skipped-count': number;
  'total-duration': number;
  'summary-line': string;
}

export interface GossValidateOutput {
  results: GossTestResult[];
  summary: GossSummary;
}

export interface GossParseResult {
  /** All individual test results */
  results: GossTestResult[];
  /** The summary object from goss output */
  summary: GossSummary;
  /** The mapped health status */
  healthStatus: HealthStatus;
  /** Number of passed tests */
  passed: number;
  /** Number of failed tests */
  failed: number;
  /** Number of skipped tests */
  skipped: number;
  /** Total number of tests */
  total: number;
}

// ── Parsing ──

/**
 * Slugify a string for use in finding IDs.
 * Replaces non-alphanumeric characters with hyphens and lowercases.
 */
function slugify(s: string): string {
  return s.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
}

/**
 * Map goss results to a CrisisMode HealthStatus.
 * Any failures → unhealthy, all skipped → unknown, all pass → healthy.
 */
function computeHealthStatus(failed: number, skipped: number, total: number): HealthStatus {
  if (total === 0) return 'unknown';
  if (failed > 0) return 'unhealthy';
  if (skipped === total) return 'unknown';
  return 'healthy';
}

/**
 * Parse full Goss JSON output (stdout + exit code) into a structured result.
 *
 * Handles malformed JSON gracefully by returning an unhealthy result with
 * error information in the summary.
 */
export function parseGossOutput(stdout: string, exitCode: number): GossParseResult {
  let output: GossValidateOutput;

  try {
    output = JSON.parse(stdout.trim()) as GossValidateOutput;
  } catch {
    // Malformed JSON — return an unhealthy result with error info
    return {
      results: [],
      summary: {
        'test-count': 0,
        'failed-count': 0,
        'skipped-count': 0,
        'total-duration': 0,
        'summary-line': `Failed to parse goss output (exit code ${exitCode}): ${stdout.slice(0, 200)}`,
      },
      healthStatus: 'unhealthy',
      passed: 0,
      failed: 0,
      skipped: 0,
      total: 0,
    };
  }

  const results = output.results ?? [];
  const summary = output.summary ?? {
    'test-count': results.length,
    'failed-count': 0,
    'skipped-count': 0,
    'total-duration': 0,
    'summary-line': '',
  };

  let failed = 0;
  let skipped = 0;

  for (const r of results) {
    if (r.result === 1) failed++;
    else if (r.result === 2 || r.skipped) skipped++;
  }

  const total = results.length;
  const passed = total - failed - skipped;
  const healthStatus = computeHealthStatus(failed, skipped, total);

  return { results, summary, healthStatus, passed, failed, skipped, total };
}

// ── Conversion to CrisisMode types ──

/**
 * Convert parsed Goss output to a CrisisMode CheckHealthResult.
 *
 * Creates one CheckSignal per failed or skipped test result. Healthy tests
 * are omitted to avoid noise. If all tests pass, a single summary signal
 * is emitted instead.
 */
export function gossToHealthResult(parsed: GossParseResult): CheckHealthResult {
  const signals: CheckSignal[] = [];

  for (const r of parsed.results) {
    if (r.result === 1) {
      // Failed test
      signals.push({
        source: `${r['resource-type']}:${r['resource-id']}`,
        status: 'critical',
        detail: r['summary-line'] || `${r['resource-type']}: ${r['resource-id']}: ${r.property} failed`,
      });
    } else if (r.result === 2 || r.skipped) {
      // Skipped test
      signals.push({
        source: `${r['resource-type']}:${r['resource-id']}`,
        status: 'unknown',
        detail: r['summary-line'] || `${r['resource-type']}: ${r['resource-id']}: ${r.property} skipped`,
      });
    }
  }

  // If all tests passed, emit a single summary signal
  if (signals.length === 0 && parsed.total > 0) {
    signals.push({
      source: 'goss',
      status: 'healthy',
      detail: `All ${parsed.total} tests passed`,
    });
  }

  // Confidence: 0.9 — goss is structured and quantitative
  const confidence = 0.9;

  const summaryLine = parsed.summary['summary-line']
    || `Count: ${parsed.total}, Failed: ${parsed.failed}, Skipped: ${parsed.skipped}`;

  return {
    status: parsed.healthStatus,
    summary: summaryLine,
    confidence,
    signals,
    recommendedActions: [],
  };
}

/**
 * Convert parsed Goss output to a CrisisMode CheckDiagnoseResult.
 *
 * Creates one CheckFinding per failed test. Skipped tests are omitted from
 * findings. If all tests pass, returns empty findings with `healthy: true`.
 */
export function gossToDiagnoseResult(parsed: GossParseResult): CheckDiagnoseResult {
  const findings: CheckFinding[] = [];

  for (const r of parsed.results) {
    if (r.result !== 1) continue;

    const resourceType = slugify(r['resource-type']);
    const resourceId = slugify(r['resource-id']);
    const property = slugify(r.property);

    findings.push({
      id: `goss-${resourceType}-${resourceId}-${property}`,
      severity: 'warning',
      title: `${r['resource-type']}: ${r['resource-id']}: ${r.property} failed`,
      detail: r['summary-line'] || `Expected ${JSON.stringify(r['matcher-result']?.expected)} but got ${JSON.stringify(r['matcher-result']?.actual)}`,
      evidence: {
        actual: r['matcher-result']?.actual,
        expected: r['matcher-result']?.expected,
        resourceType: r['resource-type'],
        resourceId: r['resource-id'],
        property: r.property,
      },
    });
  }

  const summaryLine = parsed.summary['summary-line']
    || `Count: ${parsed.total}, Failed: ${parsed.failed}, Skipped: ${parsed.skipped}`;

  return {
    healthy: parsed.failed === 0,
    summary: summaryLine,
    findings,
  };
}
