// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { renderTriagePipe, renderTriageReport, triageExitCode } from '../cli/commands/triage.js';
import type { TriageReport } from '../framework/triage.js';

const report: TriageReport = {
  verdict: 'network',
  explanation: 'This machine looks fine, but the network it is on does not: DNS is not resolving from this machine.',
  nextStep: 'Check the network you are on (Wi-Fi sign-in, VPN, router) — DNS traffic is not getting out.',
  observerContext: 'laptop',
  observerContextEvidence: 'macOS host with no server markers (assumption, not a measurement)',
  escalationLevel: 2,
  checkedAt: '2026-08-05T12:00:00.000Z',
  durationMs: 1234,
  layers: [
    { layer: 'interfaces', status: 'pass', detail: 'Active interfaces: en0', durationMs: 1 },
    { layer: 'gateway', status: 'pass', detail: 'Default gateway: 192.168.1.1 (context only — not probed)', durationMs: 4 },
    { layer: 'dns', status: 'fail', code: 'dns-unreachable', detail: 'Neither resolver answered.', nextStep: 'Check the network.', durationMs: 800 },
    { layer: 'captive-portal', status: 'unknown', detail: 'No connectivity-check endpoint responded.', durationMs: 800 },
    { layer: 'internet', status: 'fail', code: 'internet-unreachable', detail: 'No response.', durationMs: 800 },
    { layer: 'targets', status: 'skipped', detail: 'No targets to probe.', durationMs: 0 },
  ],
};

describe('triageExitCode', () => {
  it('exits 0 when this machine is not the problem', () => {
    expect(triageExitCode('healthy')).toBe(0);
    expect(triageExitCode('remote')).toBe(0);
  });

  it('exits 1 when the problem is local, network, or unresolved', () => {
    expect(triageExitCode('local')).toBe(1);
    expect(triageExitCode('network')).toBe(1);
    expect(triageExitCode('mixed')).toBe(1);
  });
});

describe('renderTriageReport', () => {
  const out = renderTriageReport(report).join('\n');

  it('leads with the verdict and its plain-language explanation', () => {
    expect(out).toContain('network');
    expect(out).toContain('the network it is on does not');
  });

  it('gives one next step', () => {
    expect(out).toContain('Next: Check the network you are on');
  });

  it('shows every layer with its detail', () => {
    for (const layer of report.layers) {
      expect(out).toContain(layer.layer);
      expect(out).toContain(layer.detail);
    }
  });

  it('names the escalation level and the observer-context caveat', () => {
    expect(out).toContain('Diagnose');
    expect(out).toContain('laptop');
    expect(out).toContain('assumption');
  });
});

describe('renderTriagePipe', () => {
  const lines = renderTriagePipe(report);

  it('emits a tab-separated verdict line first', () => {
    expect(lines[0]).toBe('triage\tnetwork\t2026-08-05T12:00:00.000Z\t1234');
  });

  it('emits one tab-separated line per layer', () => {
    expect(lines).toHaveLength(1 + report.layers.length);
    expect(lines[1]).toBe('layer\tinterfaces\tpass\tActive interfaces: en0');
  });
});
