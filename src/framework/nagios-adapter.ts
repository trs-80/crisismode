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

// ── Nagios range/threshold types ──

/**
 * A Nagios threshold range, per the plugin development guidelines.
 *
 * Syntax: [@]start:end — `start:` may be omitted (defaults to 0), `~` means
 * negative infinity, an empty end means positive infinity, and a bare number
 * `n` is shorthand for `0:n`. A plain range alerts when the value falls
 * OUTSIDE start..end; the `@` prefix inverts that, alerting when the value is
 * INSIDE the range (bounds inclusive in both cases).
 */
export interface NagiosRange {
  /** The original threshold text, for display and evidence */
  raw: string;
  /** True for `@` ranges: alert when the value is inside the range */
  inside: boolean;
  /** Range start; -Infinity for `~` */
  start: number;
  /** Range end; Infinity when omitted */
  end: number;
}

/**
 * Parse a Nagios threshold range. Returns null for an empty, non-numeric, or
 * inverted (start > end) specification — an absent threshold and a malformed
 * one both mean "nothing to alert on".
 */
export function parseNagiosRange(raw: string): NagiosRange | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const inside = trimmed.startsWith('@');
  const body = inside ? trimmed.slice(1) : trimmed;
  if (!body) return null;

  let start: number;
  let end: number;

  const colonIdx = body.indexOf(':');
  if (colonIdx < 0) {
    // Bare number: shorthand for 0..n
    start = 0;
    end = parseFloat(body);
    if (isNaN(end)) return null;
  } else {
    const startStr = body.slice(0, colonIdx).trim();
    const endStr = body.slice(colonIdx + 1).trim();

    if (startStr === '~') {
      start = -Infinity;
    } else if (startStr === '') {
      start = 0;
    } else {
      start = parseFloat(startStr);
      if (isNaN(start)) return null;
    }

    if (endStr === '') {
      end = Infinity;
    } else {
      end = parseFloat(endStr);
      if (isNaN(end)) return null;
    }
  }

  if (start > end) return null;

  return { raw: trimmed, inside, start, end };
}

/** True when the value triggers an alert for this range. */
export function rangeViolated(range: NagiosRange, value: number): boolean {
  const insideRange = value >= range.start && value <= range.end;
  return range.inside ? insideRange : !insideRange;
}

// ── Nagios perfdata types ──

export interface NagiosPerfDataItem {
  label: string;
  value: number;
  uom: string;
  warn: NagiosRange | null;
  crit: NagiosRange | null;
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
  const valueMatch = parts[0]!.match(/^(-?[\d.]+)\s*([a-zA-Z%]*)/);
  if (!valueMatch) return null;

  const value = parseFloat(valueMatch[1]!);
  if (isNaN(value)) return null;

  const uom = valueMatch[2] || '';

  // min and max are plain numbers, not ranges
  const parseBound = (s: string | undefined): number | null => {
    if (!s || s.trim() === '') return null;
    const n = parseFloat(s.trim());
    return isNaN(n) ? null : n;
  };

  return {
    label,
    value,
    uom,
    warn: parseNagiosRange(parts[1] ?? ''),
    crit: parseNagiosRange(parts[2] ?? ''),
    min: parseBound(parts[3]),
    max: parseBound(parts[4]),
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
  statusText = lines[0]!.trim();

  const perfData = parsePerfData(perfDataStr);

  return { statusText, perfData, exitStatus, healthStatus };
}

// ── Conversion to CrisisMode types ──

/**
 * Derive signal status from a perfdata item's value relative to its thresholds.
 */
function perfDataSignalStatus(item: NagiosPerfDataItem): CheckSignal['status'] {
  if (item.crit !== null && rangeViolated(item.crit, item.value)) return 'critical';
  if (item.warn !== null && rangeViolated(item.warn, item.value)) return 'warning';
  return 'healthy';
}

/**
 * Format a perfdata item as a human-readable detail string.
 */
function perfDataDetail(item: NagiosPerfDataItem): string {
  let detail = `${item.label}=${item.value}${item.uom}`;
  if (item.warn !== null) detail += ` (warn: ${item.warn.raw})`;
  if (item.crit !== null) detail += ` (crit: ${item.crit.raw})`;
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
        warn: item.warn?.raw ?? null,
        crit: item.crit?.raw ?? null,
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
