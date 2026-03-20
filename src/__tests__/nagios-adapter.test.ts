// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import {
  parsePerfDataItem,
  parsePerfData,
  parseNagiosOutput,
  nagiosToHealthResult,
  nagiosToDiagnoseResult,
} from '../framework/nagios-adapter.js';

describe('parsePerfDataItem', () => {
  it('parses a simple value', () => {
    const item = parsePerfDataItem('load1=0.040');
    expect(item).toEqual({
      label: 'load1',
      value: 0.04,
      uom: '',
      warn: null,
      crit: null,
      min: null,
      max: null,
    });
  });

  it('parses value with UOM and thresholds', () => {
    const item = parsePerfDataItem('/=2643MB;5765;6456;0;7180');
    expect(item).toEqual({
      label: '/',
      value: 2643,
      uom: 'MB',
      warn: 5765,
      crit: 6456,
      min: 0,
      max: 7180,
    });
  });

  it('parses percentage values', () => {
    const item = parsePerfDataItem('cpu_usage=85%;80;90;0;100');
    expect(item).toEqual({
      label: 'cpu_usage',
      value: 85,
      uom: '%',
      warn: 80,
      crit: 90,
      min: 0,
      max: 100,
    });
  });

  it('parses value with only warn and crit thresholds', () => {
    const item = parsePerfDataItem('time=0.006s;15.000;30.000');
    expect(item).toEqual({
      label: 'time',
      value: 0.006,
      uom: 's',
      warn: 15,
      crit: 30,
      min: null,
      max: null,
    });
  });

  it('handles quoted labels', () => {
    const item = parsePerfDataItem("'disk /var'=45%;80;90;0;100");
    expect(item).toEqual({
      label: 'disk /var',
      value: 45,
      uom: '%',
      warn: 80,
      crit: 90,
      min: 0,
      max: 100,
    });
  });

  it('handles empty thresholds', () => {
    const item = parsePerfDataItem('rta=0.080ms;;');
    expect(item).toEqual({
      label: 'rta',
      value: 0.08,
      uom: 'ms',
      warn: null,
      crit: null,
      min: null,
      max: null,
    });
  });

  it('returns null for empty string', () => {
    expect(parsePerfDataItem('')).toBeNull();
  });

  it('returns null for string without equals sign', () => {
    expect(parsePerfDataItem('no-equals')).toBeNull();
  });

  it('returns null for non-numeric value', () => {
    expect(parsePerfDataItem('label=abc')).toBeNull();
  });

  it('handles negative values', () => {
    const item = parsePerfDataItem('temp=-5.2C;0;-10;-40;50');
    expect(item).toEqual({
      label: 'temp',
      value: -5.2,
      uom: 'C',
      warn: 0,
      crit: -10,
      min: -40,
      max: 50,
    });
  });
});

describe('parsePerfData', () => {
  it('parses multiple space-separated items', () => {
    const items = parsePerfData('/=2643MB;5765;6456;0;7180 /tmp=1234MB;2000;3000;0;4000');
    expect(items).toHaveLength(2);
    expect(items[0].label).toBe('/');
    expect(items[1].label).toBe('/tmp');
  });

  it('returns empty array for empty string', () => {
    expect(parsePerfData('')).toEqual([]);
  });

  it('parses real-world check_disk output', () => {
    const items = parsePerfData('/=2643MB;5765;6456;0;7180 /boot=68MB;88;93;0;99');
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      label: '/',
      value: 2643,
      uom: 'MB',
      warn: 5765,
      crit: 6456,
      min: 0,
      max: 7180,
    });
  });

  it('handles single item', () => {
    const items = parsePerfData('uptime=86400s');
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('uptime');
    expect(items[0].value).toBe(86400);
  });
});

describe('parseNagiosOutput', () => {
  it('parses OK output with perfdata', () => {
    const result = parseNagiosOutput(
      'DISK OK - free space: / 3326 MB (56%)|/=2643MB;5765;6456;0;7180',
      0,
    );
    expect(result.statusText).toBe('DISK OK - free space: / 3326 MB (56%)');
    expect(result.perfData).toHaveLength(1);
    expect(result.exitStatus).toBe('ok');
    expect(result.healthStatus).toBe('healthy');
  });

  it('parses CRITICAL output without perfdata', () => {
    const result = parseNagiosOutput('CRITICAL - Host unreachable', 2);
    expect(result.statusText).toBe('CRITICAL - Host unreachable');
    expect(result.perfData).toHaveLength(0);
    expect(result.exitStatus).toBe('critical');
    expect(result.healthStatus).toBe('unhealthy');
  });

  it('parses WARNING output', () => {
    const result = parseNagiosOutput('WARNING - Load average: 4.5, 3.2, 2.1|load1=4.5;5;10 load5=3.2;4;8', 1);
    expect(result.statusText).toBe('WARNING - Load average: 4.5, 3.2, 2.1');
    expect(result.perfData).toHaveLength(2);
    expect(result.exitStatus).toBe('warning');
    expect(result.healthStatus).toBe('recovering');
  });

  it('handles multi-line output (only first line is status)', () => {
    const result = parseNagiosOutput('OK - All checks passed\nDetailed info line 1\nDetailed info line 2', 0);
    expect(result.statusText).toBe('OK - All checks passed');
    expect(result.exitStatus).toBe('ok');
  });

  it('handles empty stdout', () => {
    const result = parseNagiosOutput('', 2);
    expect(result.statusText).toBe('');
    expect(result.perfData).toHaveLength(0);
    expect(result.exitStatus).toBe('critical');
    expect(result.healthStatus).toBe('unhealthy');
  });

  it('handles UNKNOWN exit code', () => {
    const result = parseNagiosOutput('UNKNOWN - Plugin error', 3);
    expect(result.exitStatus).toBe('unknown');
    expect(result.healthStatus).toBe('unknown');
  });

  it('handles non-standard exit codes as unknown', () => {
    const result = parseNagiosOutput('Something went wrong', 127);
    expect(result.exitStatus).toBe('unknown');
    expect(result.healthStatus).toBe('unknown');
  });
});

describe('nagiosToHealthResult', () => {
  it('converts OK result with perfdata', () => {
    const parsed = parseNagiosOutput(
      'DISK OK - free space: / 3326 MB (56%)|/=2643MB;5765;6456;0;7180',
      0,
    );
    const result = nagiosToHealthResult(parsed);

    expect(result.status).toBe('healthy');
    expect(result.summary).toBe('DISK OK - free space: / 3326 MB (56%)');
    expect(result.confidence).toBe(0.85);
    expect(result.signals).toHaveLength(1);
    expect(result.signals![0].source).toBe('/');
    expect(result.signals![0].status).toBe('healthy');
    expect(result.signals![0].detail).toContain('2643');
  });

  it('converts CRITICAL result with threshold breach', () => {
    const parsed = parseNagiosOutput(
      'DISK CRITICAL - / at 95%|/=6800MB;5765;6456;0;7180',
      2,
    );
    const result = nagiosToHealthResult(parsed);

    expect(result.status).toBe('unhealthy');
    expect(result.signals).toHaveLength(1);
    expect(result.signals![0].status).toBe('critical');
  });

  it('converts WARNING result with threshold breach', () => {
    const parsed = parseNagiosOutput(
      'DISK WARNING - / at 82%|/=5900MB;5765;6456;0;7180',
      1,
    );
    const result = nagiosToHealthResult(parsed);

    expect(result.status).toBe('recovering');
    expect(result.signals).toHaveLength(1);
    expect(result.signals![0].status).toBe('warning');
  });

  it('creates a text-based signal when no perfdata', () => {
    const parsed = parseNagiosOutput('CRITICAL - Host unreachable', 2);
    const result = nagiosToHealthResult(parsed);

    expect(result.status).toBe('unhealthy');
    expect(result.confidence).toBe(0.7);
    expect(result.signals).toHaveLength(1);
    expect(result.signals![0].source).toBe('nagios');
    expect(result.signals![0].status).toBe('critical');
    expect(result.signals![0].detail).toBe('CRITICAL - Host unreachable');
  });

  it('handles multiple perfdata items with mixed statuses', () => {
    const parsed = parseNagiosOutput(
      'WARNING|/=2643MB;5765;6456;0;7180 /var=5800MB;5765;6456;0;7180',
      1,
    );
    const result = nagiosToHealthResult(parsed);

    expect(result.signals).toHaveLength(2);
    expect(result.signals![0].status).toBe('healthy'); // / is below warn
    expect(result.signals![1].status).toBe('warning'); // /var exceeds warn but not crit
  });
});

describe('nagiosToDiagnoseResult', () => {
  it('produces findings from perfdata threshold breaches', () => {
    const parsed = parseNagiosOutput(
      'DISK WARNING|/=5900MB;5765;6456;0;7180 /tmp=100MB;2000;3000;0;4000',
      1,
    );
    const result = nagiosToDiagnoseResult(parsed);

    expect(result.healthy).toBe(false);
    expect(result.findings).toHaveLength(1); // Only / exceeds threshold
    expect(result.findings[0].id).toBe('nagios--');
    expect(result.findings[0].severity).toBe('warning');
    expect(result.findings[0].evidence).toEqual({
      value: 5900,
      uom: 'MB',
      warn: 5765,
      crit: 6456,
    });
  });

  it('produces critical finding for value exceeding crit threshold', () => {
    const parsed = parseNagiosOutput(
      'DISK CRITICAL|/=6800MB;5765;6456;0;7180',
      2,
    );
    const result = nagiosToDiagnoseResult(parsed);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('critical');
  });

  it('produces empty findings for OK status', () => {
    const parsed = parseNagiosOutput(
      'DISK OK|/=2643MB;5765;6456;0;7180',
      0,
    );
    const result = nagiosToDiagnoseResult(parsed);

    expect(result.healthy).toBe(true);
    expect(result.findings).toHaveLength(0);
  });

  it('creates text-based finding when no perfdata and not OK', () => {
    const parsed = parseNagiosOutput('CRITICAL - Host unreachable', 2);
    const result = nagiosToDiagnoseResult(parsed);

    expect(result.healthy).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].id).toBe('nagios-status');
    expect(result.findings[0].severity).toBe('critical');
    expect(result.findings[0].title).toBe('CRITICAL - Host unreachable');
  });

  it('returns healthy with no findings for OK without perfdata', () => {
    const parsed = parseNagiosOutput('OK - Everything is fine', 0);
    const result = nagiosToDiagnoseResult(parsed);

    expect(result.healthy).toBe(true);
    expect(result.findings).toHaveLength(0);
  });
});
