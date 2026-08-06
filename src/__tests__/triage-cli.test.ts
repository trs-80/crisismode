// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import chalk from 'chalk';
import { renderTriagePipe, renderTriageReport, runTriageCommand, triageExitCode } from '../cli/commands/triage.js';
import { configure } from '../cli/output.js';
import type * as TriageFramework from '../framework/triage.js';
import type { TriageReport } from '../framework/triage.js';

// The runTriageCommand human-output test below exercises the command for
// real. Autodiscovery reads the real filesystem and environment, so it is
// stubbed to keep the test from probing this machine — mirrors
// src/__tests__/observer-reframe.test.ts. runTriage is replaced with a fixed
// report so the test asserts on rendering, not probing.
const { commandReport } = vi.hoisted(() => ({
  commandReport: {
    verdict: 'healthy' as const,
    explanation: 'This machine, its network, and everything triage could reach look fine.',
    nextStep: 'Nothing to fix here — if a service is failing, run `crisismode scan` to check the services themselves.',
    observerContext: 'laptop' as const,
    observerContextEvidence: 'macOS host with no server markers (assumption, not a measurement)',
    escalationLevel: 2 as const,
    checkedAt: '2026-08-05T12:00:00.000Z',
    durationMs: 42,
    layers: [
      { layer: 'interfaces' as const, status: 'pass' as const, detail: 'Active interfaces: en0', durationMs: 1 },
      { layer: 'targets' as const, status: 'skipped' as const, detail: 'No targets to probe.', durationMs: 0 },
    ],
  },
}));

vi.mock('../cli/autodiscovery.js', () => ({
  discoverStack: vi.fn(async () => ({
    services: [],
    appStack: { framework: null, language: null, hasDockerfile: false, hasCIConfig: false, dependencies: [] },
    envHints: [],
    platform: { platform: null, detected: false, signals: [] },
    aiProviders: [],
    derivedTargets: [],
    derivedNotes: {},
    confidence: 0.5,
  })),
}));
vi.mock('../framework/triage.js', async (importOriginal) => ({
  ...(await importOriginal<typeof TriageFramework>()),
  runTriage: vi.fn(async () => commandReport),
}));

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

describe('runTriageCommand human output', () => {
  let lines: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let savedLevel: typeof chalk.level;

  beforeEach(() => {
    savedLevel = chalk.level;
    configure({ json: false, noColor: false, mode: 'human' });
    chalk.level = 1; // force ANSI (after configure, which zeroes it off-TTY)
    lines = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    chalk.level = savedLevel;
    configure({ json: false, noColor: false, mode: 'human' });
  });

  // The explanation and next-step lines are this feature's flagship
  // plain-language output. printInfo wraps every line in chalk.dim(`  ${msg}`),
  // graying them out and adding a two-space indent — this asserts the printed
  // lines are renderTriageReport's output verbatim, undimmed and unindented.
  it('prints renderTriageReport lines directly via console.log, not through printInfo', async () => {
    await runTriageCommand({});
    const expected = renderTriageReport(commandReport);
    // printBanner writes 3 lines first ('', the banner, '').
    const reportLines = lines.slice(3);
    expect(reportLines).toEqual(expected);
    expect(reportLines).toContain(commandReport.explanation);
    expect(reportLines).toContain(`Next: ${commandReport.nextStep}`);
  });
});

describe('CLI registration', () => {
  const indexSource = readFileSync(
    fileURLToPath(new URL('../cli/index.ts', import.meta.url)),
    'utf-8',
  );

  it('routes the triage subcommand to runTriageCommand', () => {
    expect(indexSource).toContain("case 'triage':");
    expect(indexSource).toContain("await import('./commands/triage.js')");
    expect(indexSource).toContain('runTriageCommand');
  });

  it('documents triage in the help text', () => {
    expect(indexSource).toContain('crisismode triage');
  });
});
