// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Sensu check output adapter.
 *
 * Translates the Sensu check metric output formats into CrisisMode check results.
 * Sensu checks are fully Nagios-compatible at the exit code and status text level
 * (0=OK, 1=WARNING, 2=CRITICAL, 3=UNKNOWN), but add additional metric output
 * formats beyond Nagios perfdata.
 *
 * Supported metric formats (`output_metric_format`):
 *   - nagios_perfdata  — already handled by the Nagios adapter; delegated here
 *   - graphite_plaintext — `metric.name value timestamp`
 *   - influxdb_line    — `measurement,tag=val field=val timestamp`
 *   - opentsdb_line    — `metric timestamp value tag=val tag=val`
 *   - prometheus_text  — `metric{label="val"} value [timestamp]`
 *
 * For nagios_perfdata, this adapter delegates to the Nagios adapter and converts
 * the perfdata items to SensuMetricPoints. For all other formats, the stdout IS
 * the metric data — there is no status text / perfdata separation.
 *
 * This adapter converts Sensu output to CheckHealthResult or CheckDiagnoseResult
 * depending on the requested verb.
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
import { parseNagiosOutput } from './nagios-adapter.js';
import type { NagiosPerfDataItem } from './nagios-adapter.js';

// ── Sensu metric types ──

export interface SensuMetricPoint {
  name: string;
  value: number;
  timestamp: number | null;
  tags: Array<{ name: string; value: string }>;
}

export type SensuMetricFormat =
  | 'nagios_perfdata'
  | 'graphite_plaintext'
  | 'influxdb_line'
  | 'opentsdb_line'
  | 'prometheus_text';

export interface SensuParseResult {
  /** The status text (first line for non-nagios, or Nagios status text) */
  statusText: string;
  /** Parsed metric points */
  metrics: SensuMetricPoint[];
  /** The exit code status */
  exitStatus: CheckExitStatus;
  /** The mapped health status */
  healthStatus: HealthStatus;
  /** The metric format used */
  format: SensuMetricFormat;
}

// ── Individual line parsers ──

/**
 * Parse a Graphite plaintext line: `metric.name value timestamp`
 * Timestamp is optional.
 */
export function parseGraphiteLine(line: string): SensuMetricPoint | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) return null;

  const name = parts[0];
  const value = parseFloat(parts[1]);
  if (isNaN(value)) return null;

  const timestamp = parts.length >= 3 ? parseInt(parts[2], 10) : null;

  return {
    name,
    value,
    timestamp: timestamp !== null && !isNaN(timestamp) ? timestamp : null,
    tags: [],
  };
}

/**
 * Parse an InfluxDB line protocol line: `measurement,tag=val,tag=val field=val,field=val timestamp`
 * Creates one SensuMetricPoint per field. Tags are shared across all points.
 * Timestamp is optional.
 */
export function parseInfluxDBLine(line: string): SensuMetricPoint | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // Split into: measurement+tags, fields, optional timestamp
  const spaceParts = trimmed.split(/\s+/);
  if (spaceParts.length < 2) return null;

  const measurementAndTags = spaceParts[0];
  const fieldsStr = spaceParts[1];
  const timestampStr = spaceParts.length >= 3 ? spaceParts[2] : null;

  // Parse measurement and tags
  const commaParts = measurementAndTags.split(',');
  const measurement = commaParts[0];
  const tags: Array<{ name: string; value: string }> = [];
  for (let i = 1; i < commaParts.length; i++) {
    const eqIdx = commaParts[i].indexOf('=');
    if (eqIdx > 0) {
      tags.push({
        name: commaParts[i].slice(0, eqIdx),
        value: commaParts[i].slice(eqIdx + 1),
      });
    }
  }

  // Parse fields — return first valid numeric field as the primary point
  const fields = fieldsStr.split(',');
  for (const field of fields) {
    const eqIdx = field.indexOf('=');
    if (eqIdx <= 0) continue;

    const fieldName = field.slice(0, eqIdx);
    let fieldValStr = field.slice(eqIdx + 1);
    // InfluxDB integer values end with 'i'
    if (fieldValStr.endsWith('i')) {
      fieldValStr = fieldValStr.slice(0, -1);
    }
    const fieldVal = parseFloat(fieldValStr);
    if (isNaN(fieldVal)) continue;

    const timestamp = timestampStr ? parseInt(timestampStr, 10) : null;

    return {
      name: `${measurement}.${fieldName}`,
      value: fieldVal,
      timestamp: timestamp !== null && !isNaN(timestamp) ? timestamp : null,
      tags,
    };
  }

  return null;
}

/**
 * Parse an OpenTSDB line: `metric timestamp value tag=val tag=val`
 */
export function parseOpenTSDBLine(line: string): SensuMetricPoint | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(/\s+/);
  if (parts.length < 3) return null;

  const name = parts[0];
  const timestamp = parseInt(parts[1], 10);
  const value = parseFloat(parts[2]);
  if (isNaN(value)) return null;

  const tags: Array<{ name: string; value: string }> = [];
  for (let i = 3; i < parts.length; i++) {
    const eqIdx = parts[i].indexOf('=');
    if (eqIdx > 0) {
      tags.push({
        name: parts[i].slice(0, eqIdx),
        value: parts[i].slice(eqIdx + 1),
      });
    }
  }

  return {
    name,
    value,
    timestamp: !isNaN(timestamp) ? timestamp : null,
    tags,
  };
}

/**
 * Parse a Prometheus text format line: `metric{label="val",label="val"} value [timestamp]`
 * Skips comment lines starting with #.
 */
export function parsePrometheusLine(line: string): SensuMetricPoint | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  // Check if there are labels in braces
  const braceStart = trimmed.indexOf('{');
  let name: string;
  let rest: string;
  const tags: Array<{ name: string; value: string }> = [];

  if (braceStart >= 0) {
    name = trimmed.slice(0, braceStart);
    const braceEnd = trimmed.indexOf('}', braceStart);
    if (braceEnd < 0) return null;

    // Parse labels
    const labelsStr = trimmed.slice(braceStart + 1, braceEnd);
    const labelParts = labelsStr.split(',');
    for (const part of labelParts) {
      const eqIdx = part.indexOf('=');
      if (eqIdx > 0) {
        const labelName = part.slice(0, eqIdx).trim();
        let labelValue = part.slice(eqIdx + 1).trim();
        // Strip surrounding quotes
        if (labelValue.startsWith('"') && labelValue.endsWith('"')) {
          labelValue = labelValue.slice(1, -1);
        }
        tags.push({ name: labelName, value: labelValue });
      }
    }

    rest = trimmed.slice(braceEnd + 1).trim();
  } else {
    // No labels — split on first space
    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx < 0) return null;
    name = trimmed.slice(0, spaceIdx);
    rest = trimmed.slice(spaceIdx + 1).trim();
  }

  // rest is "value [timestamp]"
  const valueParts = rest.split(/\s+/);
  if (valueParts.length === 0) return null;

  const value = parseFloat(valueParts[0]);
  if (isNaN(value)) return null;

  const timestamp = valueParts.length >= 2 ? parseInt(valueParts[1], 10) : null;

  return {
    name,
    value,
    timestamp: timestamp !== null && !isNaN(timestamp) ? timestamp : null,
    tags,
  };
}

// ── Dispatch parser ──

/**
 * Parse stdout into metric points using the specified format.
 * Dispatches each non-empty line to the appropriate format parser.
 * Lines that fail to parse are silently skipped.
 */
export function parseSensuMetrics(stdout: string, format: SensuMetricFormat): SensuMetricPoint[] {
  const lines = stdout.split('\n').filter((l) => l.trim() !== '');
  const metrics: SensuMetricPoint[] = [];

  const parseLine = format === 'graphite_plaintext' ? parseGraphiteLine
    : format === 'influxdb_line' ? parseInfluxDBLine
      : format === 'opentsdb_line' ? parseOpenTSDBLine
        : format === 'prometheus_text' ? parsePrometheusLine
          : null;

  if (!parseLine) return metrics;

  for (const line of lines) {
    const point = parseLine(line);
    if (point) metrics.push(point);
  }

  return metrics;
}

// ── Full output parser ──

/**
 * Convert a NagiosPerfDataItem to a SensuMetricPoint.
 */
function perfDataToMetricPoint(item: NagiosPerfDataItem): SensuMetricPoint {
  const tags: Array<{ name: string; value: string }> = [];
  if (item.uom) tags.push({ name: 'uom', value: item.uom });
  if (item.warn !== null) tags.push({ name: 'warn', value: String(item.warn) });
  if (item.crit !== null) tags.push({ name: 'crit', value: String(item.crit) });

  return {
    name: item.label,
    value: item.value,
    timestamp: null,
    tags,
  };
}

/**
 * Parse full Sensu check output (stdout + exit code + metric format) into a structured result.
 *
 * For `nagios_perfdata`: delegates to the Nagios adapter's `parseNagiosOutput` and converts
 * the perfdata items to SensuMetricPoints.
 *
 * For other formats: the stdout IS the metric data. The exit code is the primary status signal.
 * The first line is used as the status text.
 */
export function parseSensuOutput(
  stdout: string,
  exitCode: number,
  format: SensuMetricFormat,
): SensuParseResult {
  const exitStatus = exitCodeToStatus(exitCode);
  const healthStatus = exitStatusToHealth(exitStatus);

  if (format === 'nagios_perfdata') {
    const nagiosParsed = parseNagiosOutput(stdout, exitCode);
    const metrics = nagiosParsed.perfData.map(perfDataToMetricPoint);

    return {
      statusText: nagiosParsed.statusText,
      metrics,
      exitStatus: nagiosParsed.exitStatus,
      healthStatus: nagiosParsed.healthStatus,
      format,
    };
  }

  // For non-nagios formats: parse all lines as metrics
  const metrics = parseSensuMetrics(stdout, format);
  const lines = stdout.split('\n').filter((l) => l.trim() !== '');
  const statusText = lines.length > 0 ? lines[0].trim() : '';

  return {
    statusText,
    metrics,
    exitStatus,
    healthStatus,
    format,
  };
}

// ── Conversion to CrisisMode types ──

/**
 * Convert parsed Sensu output to a CrisisMode CheckHealthResult.
 *
 * For `nagios_perfdata`: uses threshold-based signal logic (same as Nagios adapter).
 * Confidence: 0.85.
 *
 * For other formats: creates a summary signal from exit status + metric count.
 * Confidence: 0.8 (we have metrics but no threshold context).
 */
export function sensuToHealthResult(parsed: SensuParseResult): CheckHealthResult {
  const signals: CheckSignal[] = [];

  if (parsed.format === 'nagios_perfdata') {
    // Re-delegate to threshold-based logic via perfdata tags
    for (const metric of parsed.metrics) {
      const warnTag = metric.tags.find((t) => t.name === 'warn');
      const critTag = metric.tags.find((t) => t.name === 'crit');
      const warn = warnTag ? parseFloat(warnTag.value) : null;
      const crit = critTag ? parseFloat(critTag.value) : null;

      let status: CheckSignal['status'] = 'healthy';
      if (crit !== null && metric.value >= crit) status = 'critical';
      else if (warn !== null && metric.value >= warn) status = 'warning';

      const uomTag = metric.tags.find((t) => t.name === 'uom');
      const uom = uomTag?.value ?? '';
      let detail = `${metric.name}=${metric.value}${uom}`;
      if (warn !== null) detail += ` (warn: ${warn}${uom})`;
      if (crit !== null) detail += ` (crit: ${crit}${uom})`;

      signals.push({ source: metric.name, status, detail });
    }

    if (signals.length === 0 && parsed.statusText) {
      signals.push({
        source: 'sensu',
        status: parsed.exitStatus === 'ok' ? 'healthy'
          : parsed.exitStatus === 'warning' ? 'warning'
            : parsed.exitStatus === 'critical' ? 'critical'
              : 'unknown',
        detail: parsed.statusText,
      });
    }

    return {
      status: parsed.healthStatus,
      summary: parsed.statusText,
      confidence: parsed.metrics.length > 0 ? 0.85 : 0.7,
      signals,
      recommendedActions: [],
    };
  }

  // Non-nagios formats: summary signal from exit status + metric count
  const statusLabel = parsed.exitStatus === 'ok' ? 'healthy'
    : parsed.exitStatus === 'warning' ? 'warning'
      : parsed.exitStatus === 'critical' ? 'critical'
        : 'unknown';

  const metricSummary = parsed.metrics.length > 0
    ? `${parsed.metrics.length} metric(s) collected`
    : 'no metrics collected';

  signals.push({
    source: 'sensu',
    status: statusLabel,
    detail: `${parsed.statusText || 'Sensu check'} — ${metricSummary}`,
  });

  return {
    status: parsed.healthStatus,
    summary: parsed.statusText || `Sensu check exited with status: ${parsed.exitStatus}`,
    confidence: 0.8,
    signals,
    recommendedActions: [],
  };
}

/**
 * Convert parsed Sensu output to a CrisisMode CheckDiagnoseResult.
 *
 * For `nagios_perfdata`: uses threshold-based finding logic (same as Nagios adapter).
 *
 * For other formats: if exit code is non-zero, creates a finding from the status text
 * with evidence containing the metric points. If OK, returns empty findings.
 */
export function sensuToDiagnoseResult(parsed: SensuParseResult): CheckDiagnoseResult {
  const findings: CheckFinding[] = [];

  if (parsed.format === 'nagios_perfdata') {
    // Threshold-based findings via perfdata tags
    for (const metric of parsed.metrics) {
      const warnTag = metric.tags.find((t) => t.name === 'warn');
      const critTag = metric.tags.find((t) => t.name === 'crit');
      const warn = warnTag ? parseFloat(warnTag.value) : null;
      const crit = critTag ? parseFloat(critTag.value) : null;

      let sigStatus: 'healthy' | 'warning' | 'critical' = 'healthy';
      if (crit !== null && metric.value >= crit) sigStatus = 'critical';
      else if (warn !== null && metric.value >= warn) sigStatus = 'warning';

      if (sigStatus === 'healthy') continue;

      const uomTag = metric.tags.find((t) => t.name === 'uom');
      const uom = uomTag?.value ?? '';

      findings.push({
        id: `sensu-${metric.name.replace(/[^a-zA-Z0-9]/g, '-')}`,
        severity: sigStatus,
        title: `${metric.name} threshold exceeded`,
        detail: `${metric.name}=${metric.value}${uom} (warn: ${warn}${uom}, crit: ${crit}${uom})`,
        evidence: {
          value: metric.value,
          uom,
          warn,
          crit,
        },
      });
    }

    if (findings.length === 0 && parsed.exitStatus !== 'ok') {
      findings.push({
        id: 'sensu-status',
        severity: parsed.exitStatus === 'critical' ? 'critical' : 'warning',
        title: parsed.statusText,
        detail: `Sensu check exited with status: ${parsed.exitStatus}`,
      });
    }

    return {
      healthy: parsed.exitStatus === 'ok',
      summary: parsed.statusText,
      findings,
    };
  }

  // Non-nagios formats: finding from exit status if non-zero
  if (parsed.exitStatus !== 'ok') {
    const metricEvidence: Record<string, unknown> = {
      metricCount: parsed.metrics.length,
      format: parsed.format,
    };
    if (parsed.metrics.length > 0) {
      metricEvidence.metrics = parsed.metrics.slice(0, 10).map((m) => ({
        name: m.name,
        value: m.value,
        tags: m.tags,
      }));
    }

    findings.push({
      id: 'sensu-status',
      severity: parsed.exitStatus === 'critical' ? 'critical' : 'warning',
      title: parsed.statusText || `Sensu check failed (${parsed.exitStatus})`,
      detail: `Sensu check exited with status: ${parsed.exitStatus}, ${parsed.metrics.length} metric(s) collected`,
      evidence: metricEvidence,
    });
  }

  return {
    healthy: parsed.exitStatus === 'ok',
    summary: parsed.statusText || `Sensu check exited with status: ${parsed.exitStatus}`,
    findings,
  };
}
