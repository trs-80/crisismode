// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * External check plugin contract.
 *
 * An external check plugin is any executable that:
 *   1. Receives a JSON request on stdin
 *   2. Returns a JSON result on stdout
 *   3. Uses exit codes: 0=OK, 1=warning, 2=critical, 3=unknown
 *
 * Three verbs are supported:
 *   - `health`   — quick health probe (used during `scan`)
 *   - `diagnose` — deeper read-only diagnosis
 *   - `plan`     — generate a recovery plan
 *
 * This module defines the wire types and the executor that spawns plugins.
 */

import { spawn } from 'node:child_process';
import type { HealthStatus } from '../types/health.js';
import type { RiskLevel } from '../types/common.js';
import { parseNagiosOutput, nagiosToHealthResult, nagiosToDiagnoseResult } from './nagios-adapter.js';
import { parseGossOutput, gossToHealthResult, gossToDiagnoseResult } from './goss-adapter.js';
import { parseSensuOutput, sensuToHealthResult, sensuToDiagnoseResult } from './sensu-adapter.js';
import type { SensuMetricFormat } from './sensu-adapter.js';

// ── Wire types (stdin → plugin) ──

export type CheckVerb = 'health' | 'diagnose' | 'plan';

export interface CheckRequest {
  /** The verb the plugin should execute */
  verb: CheckVerb;
  /** Target system information */
  target: CheckTargetInfo;
  /** Optional context passed from the caller */
  context?: Record<string, unknown>;
}

export interface CheckTargetInfo {
  name: string;
  kind: string;
  host?: string;
  port?: number;
  /** Additional target metadata */
  metadata?: Record<string, unknown>;
}

// ── Wire types (plugin → stdout) ──

export interface CheckHealthResult {
  status: HealthStatus;
  summary: string;
  confidence: number;
  signals?: CheckSignal[];
  recommendedActions?: string[];
}

export interface CheckSignal {
  source: string;
  status: 'healthy' | 'warning' | 'critical' | 'unknown';
  detail: string;
}

export interface CheckDiagnoseResult {
  healthy: boolean;
  summary: string;
  findings: CheckFinding[];
}

export interface CheckFinding {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  detail: string;
  evidence?: Record<string, unknown>;
}

export interface CheckPlanResult {
  name: string;
  description: string;
  steps: CheckPlanStep[];
}

export interface CheckPlanStep {
  id: string;
  description: string;
  riskLevel: RiskLevel;
  command?: string;
  rollback?: string;
}

export type CheckResult = CheckHealthResult | CheckDiagnoseResult | CheckPlanResult;

// ── Plugin manifest (declared in plugin's package.json or manifest.json) ──

export interface CheckPluginManifest {
  /** Unique plugin name (e.g. 'check-disk-usage') */
  name: string;
  /** Human-readable description */
  description: string;
  /** Plugin version (semver) */
  version: string;
  /** Target system kinds this plugin checks */
  targetKinds: string[];
  /** Supported verbs */
  verbs: CheckVerb[];
  /** Path to the executable (relative to plugin dir or absolute) */
  executable: string;
  /**
   * Plugin output format.
   *   - 'crisismode' (default): JSON wire protocol on stdin/stdout
   *   - 'nagios': Nagios plugin format (exit code + text line + optional perfdata)
   *     Nagios-format plugins receive no stdin input and are called with no arguments.
   *     They output a single status line optionally followed by | and performance data.
   *   - 'goss': Goss YAML validation format (JSON output from `goss validate --format json`)
   *     Goss-format plugins receive no stdin input.
   *     They output JSON with results array and summary object.
   *   - 'sensu': Sensu check format (Nagios-compatible exit codes + multiple metric output formats)
   *     Sensu-format plugins receive no stdin input.
   *     Metric format is specified via manifest.sensuMetricFormat (default: nagios_perfdata).
   */
  format?: 'crisismode' | 'nagios' | 'goss' | 'sensu';
  /** Sensu metric output format (only used when format is 'sensu'). Default: 'nagios_perfdata'. */
  sensuMetricFormat?: SensuMetricFormat;
  /** Max risk level of any plan step this plugin can generate */
  maxRiskLevel?: RiskLevel;
  /** Timeout in ms (default: 10000) */
  timeoutMs?: number;
  /** Author */
  author?: string;
  /** License */
  license?: string;
}

// ── Exit code mapping ──

export type CheckExitStatus = 'ok' | 'warning' | 'critical' | 'unknown';

const EXIT_CODE_MAP: Record<number, CheckExitStatus> = {
  0: 'ok',
  1: 'warning',
  2: 'critical',
  3: 'unknown',
};

export function exitCodeToStatus(code: number): CheckExitStatus {
  return EXIT_CODE_MAP[code] ?? 'unknown';
}

export function exitStatusToHealth(status: CheckExitStatus): HealthStatus {
  switch (status) {
    case 'ok': return 'healthy';
    case 'warning': return 'recovering';
    case 'critical': return 'unhealthy';
    default: return 'unknown';
  }
}

// ── Plugin executor ──

export interface PluginExecutionResult {
  exitStatus: CheckExitStatus;
  exitCode: number;
  result: CheckResult | null;
  stderr: string;
  durationMs: number;
}

/**
 * Execute a check plugin with the given request.
 *
 * Spawns the plugin executable, writes the request as JSON to stdin,
 * and reads the JSON result from stdout. Respects the configured timeout.
 */
export function executeCheckPlugin(
  executablePath: string,
  request: CheckRequest,
  options?: { timeoutMs?: number; cwd?: string; env?: Record<string, string> },
): Promise<PluginExecutionResult> {
  const timeoutMs = options?.timeoutMs ?? 10_000;

  return new Promise((resolve) => {
    const startTime = Date.now();
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn(executablePath, [], {
      cwd: options?.cwd,
      env: { ...process.env, ...options?.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;

      const exitCode = code ?? 3;
      const exitStatus = exitCodeToStatus(exitCode);
      const durationMs = Date.now() - startTime;

      let result: CheckResult | null = null;
      if (stdout.trim()) {
        try {
          result = JSON.parse(stdout.trim()) as CheckResult;
        } catch {
          // Plugin produced non-JSON output — treat as unknown
          stderr += `\nFailed to parse stdout as JSON: ${stdout.slice(0, 200)}`;
        }
      }

      resolve({ exitStatus, exitCode, result, stderr, durationMs });
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;

      resolve({
        exitStatus: 'unknown',
        exitCode: 3,
        result: null,
        stderr: err.message,
        durationMs: Date.now() - startTime,
      });
    });

    // Ignore EPIPE — the child may exit before we finish writing
    child.stdin.on('error', () => {});

    // Write the request and close stdin
    child.stdin.write(JSON.stringify(request));
    child.stdin.end();
  });
}

/**
 * Execute a Nagios-format check plugin.
 *
 * Nagios plugins receive no stdin input. They are called with optional arguments
 * and produce a single status line on stdout, optionally followed by `|` and
 * performance data. The exit code encodes the check status.
 *
 * The raw Nagios output is parsed and converted to CrisisMode check results.
 */
export function executeNagiosPlugin(
  executablePath: string,
  verb: CheckVerb,
  options?: { timeoutMs?: number; cwd?: string; env?: Record<string, string>; args?: string[] },
): Promise<PluginExecutionResult> {
  const timeoutMs = options?.timeoutMs ?? 10_000;

  return new Promise((resolve) => {
    const startTime = Date.now();
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn(executablePath, options?.args ?? [], {
      cwd: options?.cwd,
      env: { ...process.env, ...options?.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;

      const exitCode = code ?? 3;
      const exitStatus = exitCodeToStatus(exitCode);
      const durationMs = Date.now() - startTime;

      const parsed = parseNagiosOutput(stdout, exitCode);
      let result: CheckResult | null;

      if (verb === 'diagnose') {
        result = nagiosToDiagnoseResult(parsed);
      } else {
        // For 'health' and 'plan', return a health result
        // (Nagios plugins don't generate recovery plans)
        result = nagiosToHealthResult(parsed);
      }

      resolve({ exitStatus, exitCode, result, stderr, durationMs });
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;

      resolve({
        exitStatus: 'unknown',
        exitCode: 3,
        result: null,
        stderr: err.message,
        durationMs: Date.now() - startTime,
      });
    });
  });
}

/**
 * Execute a Goss-format check plugin.
 *
 * Goss plugins receive no stdin input. They are called with optional arguments
 * and produce JSON output with a results array and summary object
 * (as generated by `goss validate --format json`). The exit code encodes the
 * check status.
 *
 * The raw Goss output is parsed and converted to CrisisMode check results.
 */
export function executeGossPlugin(
  executablePath: string,
  verb: CheckVerb,
  options?: { timeoutMs?: number; cwd?: string; env?: Record<string, string>; args?: string[] },
): Promise<PluginExecutionResult> {
  const timeoutMs = options?.timeoutMs ?? 10_000;

  return new Promise((resolve) => {
    const startTime = Date.now();
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn(executablePath, options?.args ?? [], {
      cwd: options?.cwd,
      env: { ...process.env, ...options?.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;

      const exitCode = code ?? 3;
      const exitStatus = exitCodeToStatus(exitCode);
      const durationMs = Date.now() - startTime;

      const parsed = parseGossOutput(stdout, exitCode);
      let result: CheckResult | null;

      if (verb === 'diagnose') {
        result = gossToDiagnoseResult(parsed);
      } else {
        // For 'health' and 'plan', return a health result
        // (Goss plugins don't generate recovery plans)
        result = gossToHealthResult(parsed);
      }

      resolve({ exitStatus, exitCode, result, stderr, durationMs });
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;

      resolve({
        exitStatus: 'unknown',
        exitCode: 3,
        result: null,
        stderr: err.message,
        durationMs: Date.now() - startTime,
      });
    });
  });
}

/**
 * Execute a Sensu-format check plugin.
 *
 * Sensu plugins receive no stdin input. They are called with optional arguments
 * and produce output in one of the supported Sensu metric formats. The exit code
 * encodes the check status (same as Nagios: 0=OK, 1=WARNING, 2=CRITICAL, 3=UNKNOWN).
 *
 * The raw Sensu output is parsed and converted to CrisisMode check results.
 */
export function executeSensuPlugin(
  executablePath: string,
  verb: CheckVerb,
  options?: { timeoutMs?: number; cwd?: string; env?: Record<string, string>; args?: string[]; sensuMetricFormat?: SensuMetricFormat },
): Promise<PluginExecutionResult> {
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const metricFormat: SensuMetricFormat = options?.sensuMetricFormat ?? 'nagios_perfdata';

  return new Promise((resolve) => {
    const startTime = Date.now();
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn(executablePath, options?.args ?? [], {
      cwd: options?.cwd,
      env: { ...process.env, ...options?.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;

      const exitCode = code ?? 3;
      const exitStatus = exitCodeToStatus(exitCode);
      const durationMs = Date.now() - startTime;

      const parsed = parseSensuOutput(stdout, exitCode, metricFormat);
      let result: CheckResult | null;

      if (verb === 'diagnose') {
        result = sensuToDiagnoseResult(parsed);
      } else {
        // For 'health' and 'plan', return a health result
        // (Sensu plugins don't generate recovery plans)
        result = sensuToHealthResult(parsed);
      }

      resolve({ exitStatus, exitCode, result, stderr, durationMs });
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;

      resolve({
        exitStatus: 'unknown',
        exitCode: 3,
        result: null,
        stderr: err.message,
        durationMs: Date.now() - startTime,
      });
    });
  });
}
