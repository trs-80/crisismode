// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import {
  parseGraphiteLine,
  parseInfluxDBLine,
  parseOpenTSDBLine,
  parsePrometheusLine,
  parseSensuMetrics,
  parseSensuOutput,
  sensuToHealthResult,
  sensuToDiagnoseResult,
} from '../framework/sensu-adapter.js';

describe('parseGraphiteLine', () => {
  it('parses a valid line with timestamp', () => {
    const point = parseGraphiteLine('servers.web01.cpu.usage 85.5 1609459200');
    expect(point).toEqual({
      name: 'servers.web01.cpu.usage',
      value: 85.5,
      timestamp: 1609459200,
      tags: [],
    });
  });

  it('parses a line without timestamp', () => {
    const point = parseGraphiteLine('servers.web01.memory 2048');
    expect(point).toEqual({
      name: 'servers.web01.memory',
      value: 2048,
      timestamp: null,
      tags: [],
    });
  });

  it('returns null for invalid value', () => {
    expect(parseGraphiteLine('metric.name abc 1609459200')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseGraphiteLine('')).toBeNull();
  });

  it('returns null for single token (no value)', () => {
    expect(parseGraphiteLine('metric.name')).toBeNull();
  });
});

describe('parseInfluxDBLine', () => {
  it('parses basic measurement with tags and fields', () => {
    const point = parseInfluxDBLine('cpu,host=server01,region=us-west usage=85.5 1609459200');
    expect(point).toEqual({
      name: 'cpu.usage',
      value: 85.5,
      timestamp: 1609459200,
      tags: [
        { name: 'host', value: 'server01' },
        { name: 'region', value: 'us-west' },
      ],
    });
  });

  it('parses measurement with no tags', () => {
    const point = parseInfluxDBLine('cpu usage=42.0 1609459200');
    expect(point).toEqual({
      name: 'cpu.usage',
      value: 42,
      timestamp: 1609459200,
      tags: [],
    });
  });

  it('parses measurement with integer field value (trailing i)', () => {
    const point = parseInfluxDBLine('memory,host=web01 used=8388608i 1609459200');
    expect(point).toEqual({
      name: 'memory.used',
      value: 8388608,
      timestamp: 1609459200,
      tags: [{ name: 'host', value: 'web01' }],
    });
  });

  it('parses measurement with no timestamp', () => {
    const point = parseInfluxDBLine('disk,path=/var free=1024000');
    expect(point).toEqual({
      name: 'disk.free',
      value: 1024000,
      timestamp: null,
      tags: [{ name: 'path', value: '/var' }],
    });
  });

  it('returns null for empty string', () => {
    expect(parseInfluxDBLine('')).toBeNull();
  });

  it('returns null for single token', () => {
    expect(parseInfluxDBLine('measurement')).toBeNull();
  });
});

describe('parseOpenTSDBLine', () => {
  it('parses basic line with tags', () => {
    const point = parseOpenTSDBLine('sys.cpu.user 1609459200 85.5 host=web01 dc=us-east');
    expect(point).toEqual({
      name: 'sys.cpu.user',
      value: 85.5,
      timestamp: 1609459200,
      tags: [
        { name: 'host', value: 'web01' },
        { name: 'dc', value: 'us-east' },
      ],
    });
  });

  it('parses line without tags', () => {
    const point = parseOpenTSDBLine('sys.mem.free 1609459200 4096');
    expect(point).toEqual({
      name: 'sys.mem.free',
      value: 4096,
      timestamp: 1609459200,
      tags: [],
    });
  });

  it('returns null for invalid value', () => {
    expect(parseOpenTSDBLine('metric 1609459200 not-a-number')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseOpenTSDBLine('')).toBeNull();
  });

  it('returns null for too few parts', () => {
    expect(parseOpenTSDBLine('metric 1609459200')).toBeNull();
  });
});

describe('parsePrometheusLine', () => {
  it('parses metric with labels', () => {
    const point = parsePrometheusLine('http_requests_total{method="GET",code="200"} 1027 1609459200');
    expect(point).toEqual({
      name: 'http_requests_total',
      value: 1027,
      timestamp: 1609459200,
      tags: [
        { name: 'method', value: 'GET' },
        { name: 'code', value: '200' },
      ],
    });
  });

  it('parses metric without labels', () => {
    const point = parsePrometheusLine('process_cpu_seconds_total 42.5');
    expect(point).toEqual({
      name: 'process_cpu_seconds_total',
      value: 42.5,
      timestamp: null,
      tags: [],
    });
  });

  it('returns null for comment lines', () => {
    expect(parsePrometheusLine('# HELP http_requests_total The total number of HTTP requests.')).toBeNull();
    expect(parsePrometheusLine('# TYPE http_requests_total counter')).toBeNull();
  });

  it('parses metric with labels but no timestamp', () => {
    const point = parsePrometheusLine('node_memory_bytes{type="free"} 8388608');
    expect(point).toEqual({
      name: 'node_memory_bytes',
      value: 8388608,
      timestamp: null,
      tags: [{ name: 'type', value: 'free' }],
    });
  });

  it('returns null for empty string', () => {
    expect(parsePrometheusLine('')).toBeNull();
  });
});

describe('parseSensuMetrics', () => {
  it('dispatches to graphite parser', () => {
    const metrics = parseSensuMetrics(
      'cpu.usage 85.5 1609459200\nmemory.used 2048 1609459200',
      'graphite_plaintext',
    );
    expect(metrics).toHaveLength(2);
    expect(metrics[0].name).toBe('cpu.usage');
    expect(metrics[1].name).toBe('memory.used');
  });

  it('dispatches to influxdb parser', () => {
    const metrics = parseSensuMetrics(
      'cpu,host=web01 usage=85.5 1609459200',
      'influxdb_line',
    );
    expect(metrics).toHaveLength(1);
    expect(metrics[0].name).toBe('cpu.usage');
  });

  it('dispatches to opentsdb parser', () => {
    const metrics = parseSensuMetrics(
      'sys.cpu.user 1609459200 85.5 host=web01',
      'opentsdb_line',
    );
    expect(metrics).toHaveLength(1);
    expect(metrics[0].name).toBe('sys.cpu.user');
  });

  it('dispatches to prometheus parser', () => {
    const metrics = parseSensuMetrics(
      '# HELP process_cpu\nprocess_cpu_seconds_total 42.5',
      'prometheus_text',
    );
    expect(metrics).toHaveLength(1);
    expect(metrics[0].name).toBe('process_cpu_seconds_total');
  });

  it('handles empty lines', () => {
    const metrics = parseSensuMetrics(
      '\ncpu.usage 85.5\n\nmemory.used 2048\n',
      'graphite_plaintext',
    );
    expect(metrics).toHaveLength(2);
  });

  it('skips unparseable lines', () => {
    const metrics = parseSensuMetrics(
      'cpu.usage 85.5\nnot a valid line\nmemory.used 2048',
      'graphite_plaintext',
    );
    expect(metrics).toHaveLength(2);
  });

  it('returns empty for nagios_perfdata format', () => {
    // nagios_perfdata is not handled by parseSensuMetrics (only by parseSensuOutput)
    const metrics = parseSensuMetrics('OK|load=0.5;1;2', 'nagios_perfdata');
    expect(metrics).toEqual([]);
  });
});

describe('parseSensuOutput', () => {
  it('nagios_perfdata format delegates to nagios adapter', () => {
    const result = parseSensuOutput(
      'DISK OK - free space: / 3326 MB (56%)|/=2643MB;5765;6456;0;7180',
      0,
      'nagios_perfdata',
    );

    expect(result.statusText).toBe('DISK OK - free space: / 3326 MB (56%)');
    expect(result.exitStatus).toBe('ok');
    expect(result.healthStatus).toBe('healthy');
    expect(result.format).toBe('nagios_perfdata');
    expect(result.metrics).toHaveLength(1);
    expect(result.metrics[0].name).toBe('/');
    expect(result.metrics[0].value).toBe(2643);
  });

  it('graphite format parses all lines as metrics', () => {
    const result = parseSensuOutput(
      'cpu.usage 85.5 1609459200\nmemory.used 2048 1609459200',
      0,
      'graphite_plaintext',
    );

    expect(result.format).toBe('graphite_plaintext');
    expect(result.exitStatus).toBe('ok');
    expect(result.healthStatus).toBe('healthy');
    expect(result.metrics).toHaveLength(2);
    expect(result.statusText).toBe('cpu.usage 85.5 1609459200');
  });

  it('maps exit codes correctly', () => {
    const warning = parseSensuOutput('cpu.usage 85.5', 1, 'graphite_plaintext');
    expect(warning.exitStatus).toBe('warning');
    expect(warning.healthStatus).toBe('recovering');

    const critical = parseSensuOutput('cpu.usage 99.9', 2, 'graphite_plaintext');
    expect(critical.exitStatus).toBe('critical');
    expect(critical.healthStatus).toBe('unhealthy');

    const unknown = parseSensuOutput('', 3, 'graphite_plaintext');
    expect(unknown.exitStatus).toBe('unknown');
    expect(unknown.healthStatus).toBe('unknown');
  });

  it('handles empty stdout for non-nagios format', () => {
    const result = parseSensuOutput('', 0, 'graphite_plaintext');
    expect(result.statusText).toBe('');
    expect(result.metrics).toHaveLength(0);
    expect(result.exitStatus).toBe('ok');
  });

  it('prometheus_text skips HELP/TYPE comment lines for statusText', () => {
    const result = parseSensuOutput(
      '# HELP node_load1 1-minute load average\n# TYPE node_load1 gauge\nnode_load1 0.85\n',
      1,
      'prometheus_text',
    );

    expect(result.format).toBe('prometheus_text');
    expect(result.exitStatus).toBe('warning');
    expect(result.metrics).toHaveLength(1);
    expect(result.metrics[0].name).toBe('node_load1');
    // statusText should be the first data line, NOT the # HELP comment
    expect(result.statusText).toBe('node_load1 0.85');
    expect(result.statusText).not.toContain('# HELP');
  });

  it('prometheus_text with only comments synthesises statusText from metric count', () => {
    // Edge case: all lines are comments, no actual data lines
    const result = parseSensuOutput(
      '# HELP node_load1 1-minute load average\n# TYPE node_load1 gauge\n',
      1,
      'prometheus_text',
    );

    expect(result.metrics).toHaveLength(0);
    expect(result.statusText).toBe('');
    expect(result.statusText).not.toContain('# HELP');
  });
});

describe('sensuToHealthResult', () => {
  it('nagios_perfdata with thresholds produces threshold-based signals', () => {
    const parsed = parseSensuOutput(
      'DISK WARNING|/=5900MB;5765;6456;0;7180',
      1,
      'nagios_perfdata',
    );
    const result = sensuToHealthResult(parsed);

    expect(result.status).toBe('recovering');
    expect(result.confidence).toBe(0.85);
    expect(result.signals).toHaveLength(1);
    expect(result.signals![0].source).toBe('/');
    expect(result.signals![0].status).toBe('warning');
  });

  it('non-nagios format healthy', () => {
    const parsed = parseSensuOutput(
      'cpu.usage 42.5 1609459200\nmemory.free 4096 1609459200',
      0,
      'graphite_plaintext',
    );
    const result = sensuToHealthResult(parsed);

    expect(result.status).toBe('healthy');
    expect(result.confidence).toBe(0.8);
    expect(result.signals).toHaveLength(1);
    expect(result.signals![0].source).toBe('sensu');
    expect(result.signals![0].status).toBe('healthy');
    expect(result.signals![0].detail).toContain('2 metric(s) collected');
  });

  it('non-nagios format unhealthy', () => {
    const parsed = parseSensuOutput(
      'cpu.usage 99.9 1609459200',
      2,
      'graphite_plaintext',
    );
    const result = sensuToHealthResult(parsed);

    expect(result.status).toBe('unhealthy');
    expect(result.confidence).toBe(0.8);
    expect(result.signals).toHaveLength(1);
    expect(result.signals![0].status).toBe('critical');
  });

  it('nagios_perfdata without perfdata falls back to text signal', () => {
    const parsed = parseSensuOutput('CRITICAL - Host unreachable', 2, 'nagios_perfdata');
    const result = sensuToHealthResult(parsed);

    expect(result.status).toBe('unhealthy');
    expect(result.confidence).toBe(0.7);
    expect(result.signals).toHaveLength(1);
    expect(result.signals![0].source).toBe('sensu');
    expect(result.signals![0].status).toBe('critical');
  });
});

describe('sensuToDiagnoseResult', () => {
  it('nagios_perfdata with threshold breach produces finding', () => {
    const parsed = parseSensuOutput(
      'DISK CRITICAL|/=6800MB;5765;6456;0;7180',
      2,
      'nagios_perfdata',
    );
    const result = sensuToDiagnoseResult(parsed);

    expect(result.healthy).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].id).toBe('sensu--');
    expect(result.findings[0].severity).toBe('critical');
    expect(result.findings[0].title).toBe('/ threshold exceeded');
    expect(result.findings[0].evidence).toEqual({
      value: 6800,
      uom: 'MB',
      warn: 5765,
      crit: 6456,
    });
  });

  it('non-nagios format ok returns empty findings', () => {
    const parsed = parseSensuOutput(
      'cpu.usage 42.5 1609459200',
      0,
      'graphite_plaintext',
    );
    const result = sensuToDiagnoseResult(parsed);

    expect(result.healthy).toBe(true);
    expect(result.findings).toHaveLength(0);
  });

  it('non-nagios format failing creates finding with metric evidence', () => {
    const parsed = parseSensuOutput(
      'cpu.usage 99.9 1609459200\nmemory.used 8192 1609459200',
      2,
      'graphite_plaintext',
    );
    const result = sensuToDiagnoseResult(parsed);

    expect(result.healthy).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].id).toBe('sensu-status');
    expect(result.findings[0].severity).toBe('critical');
    expect(result.findings[0].evidence).toBeDefined();
    expect(result.findings[0].evidence!.metricCount).toBe(2);
    expect(result.findings[0].evidence!.format).toBe('graphite_plaintext');
  });

  it('nagios_perfdata ok returns empty findings', () => {
    const parsed = parseSensuOutput(
      'DISK OK|/=2643MB;5765;6456;0;7180',
      0,
      'nagios_perfdata',
    );
    const result = sensuToDiagnoseResult(parsed);

    expect(result.healthy).toBe(true);
    expect(result.findings).toHaveLength(0);
  });

  it('nagios_perfdata with no perfdata and non-ok exit creates text finding', () => {
    const parsed = parseSensuOutput('WARNING - High load', 1, 'nagios_perfdata');
    const result = sensuToDiagnoseResult(parsed);

    expect(result.healthy).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].id).toBe('sensu-status');
    expect(result.findings[0].severity).toBe('warning');
    expect(result.findings[0].title).toBe('WARNING - High load');
  });

  it('prometheus_text summary does not contain HELP comments', () => {
    const parsed = parseSensuOutput(
      '# HELP node_load1 1-minute load average\n# TYPE node_load1 gauge\nnode_load1 0.85\n',
      1,
      'prometheus_text',
    );
    const result = sensuToDiagnoseResult(parsed);

    expect(result.healthy).toBe(false);
    expect(result.summary).not.toContain('# HELP');
    expect(result.summary).toContain('1 metric(s) collected');
  });
});
