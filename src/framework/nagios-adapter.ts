// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Nagios plugin output adapter.
 *
 * Translates the Nagios plugin output format into CrisisMode check results.
 * The Nagios format is the de facto standard for monitoring checks — thousands
 * of existing plugins from Nagios, Sensu, Icinga, and Checkmk use it.
 *
 * Nagios output format:
 *   STATUS_TEXT | perfdata
 *
 * Exit codes:
 *   0 = OK, 1 = WARNING, 2 = CRITICAL, 3 = UNKNOWN
 *
 * Performance data format (optional, after the pipe):
 *   label=value[UOM];[warn];[crit];[min];[max]
 *
 * This adapter converts Nagios output to CheckHealthResult, CheckDiagnoseResult,
 * or CheckPlanResult depending on the requested verb.
 */

import type { HealthStatus } from '../types/health.js';
import type {
  CheckHealthResult,
  CheckDiagnoseResult,
  CheckSignal,
  CheckFinding,
  CheckExitStatus,
} from './check-plugin.js';
import { exitCodeToStatus, exitStatusToHealth } from './check-plugin.js';

// ── Nagios perfdata types ──

export interface NagiosPerfDataItem {
  label: string;
  value: number;
  uom: string;
  warn: number | null;
  crit: number | null;
  min: number | null;
  max: number | null;
}

export interface NagiosParseResult {
  /** The status text before the pipe */
  statusText: string;
  /** Parsed performance data items (empty if no perfdata) */
  perfData: NagiosPerfDataItem[];
  /** The exit code status */
  exitStatus: CheckExitStatus;
  /** The mapped health status */
  healthStatus: HealthStatus;
}

// ── Parsing ──

/**
 * Parse a single Nagios performance data item.
 *
 * Format: label=value[UOM];[warn];[crit];[min];[max]
 * UOM can be: s, %, B, KB, MB, GB, TB, c, or empty
 */
export function parsePerfDataItem(raw: string): NagiosPerfDataItem | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Split on first '=' to get label and value portion
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx < 0) return null;

  const label = trimmed.slice(0, eqIdx).replace(/^'|'$/g, '');
  const rest = trimmed.slice(eqIdx + 1);

  // Split value portion by semicolons
  const parts = rest.split(';');
  if (parts.length === 0) return null;

  // Parse the value and UOM from the first part
  const valueMatch = parts[0].match(/^(-?[\d.]+)\s*([a-zA-Z%]*)/);
  if (!valueMatch) return null;

  const value = parseFloat(valueMatch[1]);
  if (isNaN(value)) return null;

  const uom = valueMatch[2] || '';

  const parseThreshold = (s: string | undefined): number | null => {
    if (!s || s.trim() === '') return null;
    // Strip range notation (e.g., @10:20 → just use the end value)
    const cleaned = s.replace(/^[@~]/, '').trim();
    const colonIdx = cleaned.indexOf(':');
    const numStr = colonIdx >= 0 ? cleaned.slice(colonIdx + 1) : cleaned;
    const n = parseFloat(numStr);
    return isNaN(n) ? null : n;
  };

  return {
    label,
    value,
    uom,
    warn: parseThreshold(parts[1]),
    crit: parseThreshold(parts[2]),
    min: parseThreshold(parts[3]),
    max: parseThreshold(parts[4]),
  };
}

/**
 * Parse the performance data string (everything after the `|` pipe).
 */
export function parsePerfData(perfString: string): NagiosPerfDataItem[] {
  if (!perfString.trim()) return [];

  // Performance data items are space-separated, but labels can be quoted
  const items: NagiosPerfDataItem[] = [];
  // Split on whitespace that's not inside single quotes
  const parts = perfString.match(/(?:'[^']*'|[^\s])+=[^\s]*/g) ?? [];

  for (const part of parts) {
    const item = parsePerfDataItem(part);
    if (item) items.push(item);
  }

  return items;
}

/**
 * Parse full Nagios plugin output (stdout + exit code) into a structured result.
 */
export function parseNagiosOutput(stdout: string, exitCode: number): NagiosParseResult {
  const exitStatus = exitCodeToStatus(exitCode);
  const healthStatus = exitStatusToHealth(exitStatus);

  // Split on first pipe to separate status text from perfdata
  const pipeIdx = stdout.indexOf('|');
  let statusText: string;
  let perfDataStr: string;

  if (pipeIdx >= 0) {
    statusText = stdout.slice(0, pipeIdx).trim();
    perfDataStr = stdout.slice(pipeIdx + 1).trim();
  } else {
    statusText = stdout.trim();
    perfDataStr = '';
  }

  // Handle multi-line output: Nagios allows additional lines after the first
  // Only the first line is the status line; subsequent lines are "long output"
  const lines = statusText.split('\n');
  statusText = lines[0].trim();

  const perfData = parsePerfData(perfDataStr);

  return { statusText, perfData, exitStatus, healthStatus };
}

// ── Conversion to CrisisMode types ──

/**
 * Derive signal status from a perfdata item's value relative to its thresholds.
 */
function perfDataSignalStatus(item: NagiosPerfDataItem): CheckSignal['status'] {
  if (item.crit !== null && item.value >= item.crit) return 'critical';
  if (item.warn !== null && item.value >= item.warn) return 'warning';
  return 'healthy';
}

/**
 * Format a perfdata item as a human-readable detail string.
 */
function perfDataDetail(item: NagiosPerfDataItem): string {
  let detail = `${item.label}=${item.value}${item.uom}`;
  if (item.warn !== null) detail += ` (warn: ${item.warn}${item.uom})`;
  if (item.crit !== null) detail += ` (crit: ${item.crit}${item.uom})`;
  return detail;
}

/**
 * Convert parsed Nagios output to a CrisisMode CheckHealthResult.
 */
export function nagiosToHealthResult(parsed: NagiosParseResult): CheckHealthResult {
  const signals: CheckSignal[] = parsed.perfData.map((item) => ({
    source: item.label,
    status: perfDataSignalStatus(item),
    detail: perfDataDetail(item),
  }));

  // If no perfdata, create a single signal from the status text
  if (signals.length === 0 && parsed.statusText) {
    signals.push({
      source: 'nagios',
      status: parsed.exitStatus === 'ok' ? 'healthy'
        : parsed.exitStatus === 'warning' ? 'warning'
          : parsed.exitStatus === 'critical' ? 'critical'
            : 'unknown',
      detail: parsed.statusText,
    });
  }

  // Confidence: higher if we have perfdata (quantitative), lower if text-only
  const confidence = parsed.perfData.length > 0 ? 0.85 : 0.7;

  return {
    status: parsed.healthStatus,
    summary: parsed.statusText,
    confidence,
    signals,
    recommendedActions: [],
  };
}

/**
 * Convert parsed Nagios output to a CrisisMode CheckDiagnoseResult.
 */
export function nagiosToDiagnoseResult(parsed: NagiosParseResult): CheckDiagnoseResult {
  const findings: CheckFinding[] = [];

  // Create findings from perfdata items that exceed thresholds
  for (const item of parsed.perfData) {
    const sigStatus = perfDataSignalStatus(item);
    if (sigStatus === 'healthy') continue;

    findings.push({
      id: `nagios-${item.label.replace(/[^a-zA-Z0-9]/g, '-')}`,
      severity: sigStatus === 'critical' ? 'critical' : 'warning',
      title: `${item.label} threshold exceeded`,
      detail: perfDataDetail(item),
      evidence: {
        value: item.value,
        uom: item.uom,
        warn: item.warn,
        crit: item.crit,
      },
    });
  }

  // If no perfdata findings but status is not OK, create a finding from the text
  if (findings.length === 0 && parsed.exitStatus !== 'ok') {
    findings.push({
      id: 'nagios-status',
      severity: parsed.exitStatus === 'critical' ? 'critical' : 'warning',
      title: parsed.statusText,
      detail: `Nagios check exited with status: ${parsed.exitStatus}`,
    });
  }

  return {
    healthy: parsed.exitStatus === 'ok',
    summary: parsed.statusText,
    findings,
  };
}
