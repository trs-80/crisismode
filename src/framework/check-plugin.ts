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
