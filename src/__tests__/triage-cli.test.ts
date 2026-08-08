// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import chalk from 'chalk';
import { renderTriagePipe, renderTriageReport, resolveTriageTargets, runTriageCommand, triageExitCode } from '../cli/commands/triage.js';
import { configure, setOutputOptions } from '../cli/output.js';
import { runTriage } from '../framework/triage.js';
import { ConfigValidationError } from '../config/loader.js';
import type * as TriageFramework from '../framework/triage.js';
import type { TriageReport } from '../framework/triage.js';
import type { ServiceStatusReport } from '../framework/service-status/types.js';
import type { CheckerDeps, ServiceTarget } from '../framework/service-status/checker.js';

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
  afterEach(() => setOutputOptions({ terse: false }));

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

  it('suppresses the explanation and next-step lines in terse mode, but keeps the verdict headline', () => {
    setOutputOptions({ terse: true });
    const terseOut = renderTriageReport(report).join('\n');
    expect(terseOut).not.toContain(report.explanation);
    expect(terseOut).not.toContain(`Next: ${report.nextStep}`);
    expect(terseOut).toContain('Verdict: network');
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

describe('runTriageCommand service-status enrichment', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let lines: string[];

  function fakeServiceReport(overrides: Partial<ServiceStatusReport>): ServiceStatusReport {
    return {
      id: 'github',
      label: 'GitHub',
      source: 'catalog',
      host: 'api.github.com',
      port: 443,
      statusAssessment: 'operational',
      incidents: [],
      probe: 'reachable',
      verdict: 'healthy',
      detail: 'GitHub is healthy and reachable.',
      checkedAt: '2026-08-08T00:00:00.000Z',
      durationMs: 5,
      ...overrides,
    };
  }

  beforeEach(() => {
    configure({ json: false, noColor: false, mode: 'human' });
    lines = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    configure({ json: false, noColor: false, mode: 'human' });
  });

  function loggedOutput(): string {
    return lines.join('\n');
  }

  it('appends a status-page incident line for a remote verdict with a configured service, without touching the verdict or exit code', async () => {
    vi.mocked(runTriage).mockResolvedValueOnce({ ...commandReport, verdict: 'remote' });
    const fakeCheckServices = vi.fn(async (_targets: ServiceTarget[], _deps?: CheckerDeps) => [
      fakeServiceReport({
        statusAssessment: 'incident_reported',
        incidents: [{ title: 'Elevated error rates', impact: 'major' }],
        verdict: 'confirmed_incident',
        detail: "GitHub is down for everyone — they've confirmed an incident.",
      }),
    ]);

    const exitCode = await runTriageCommand({ loadServices: () => ['github'], checkServices: fakeCheckServices });
    const withServicesOutput = loggedOutput();

    expect(withServicesOutput).toContain("GitHub's status page reports an incident:");
    expect(withServicesOutput).toContain('Elevated error rates');
    expect(fakeCheckServices).toHaveBeenCalledTimes(1);
    // Shared 1500ms deadline, no-op probe — triage already probed reachability upstream.
    expect(fakeCheckServices.mock.calls[0]?.[1]).toMatchObject({ statusTimeoutMs: 1500 });
    const probeImpl = fakeCheckServices.mock.calls[0]?.[1]?.probeImpl;
    await expect(probeImpl?.('irrelevant-host', 443, 1500)).resolves.toBe('reachable');

    // Verdict line and exit code must be unchanged vs. a no-services run of the same report.
    logSpy.mockClear();
    lines = [];
    vi.mocked(runTriage).mockResolvedValueOnce({ ...commandReport, verdict: 'remote' });
    const noServicesExitCode = await runTriageCommand({ loadServices: () => [] });
    const noServicesOutput = loggedOutput();

    expect(exitCode).toBe(noServicesExitCode);
    expect(withServicesOutput).toContain('Verdict: remote');
    expect(noServicesOutput).toContain('Verdict: remote');
  });

  it('never calls the checker for a local verdict', async () => {
    vi.mocked(runTriage).mockResolvedValueOnce({ ...commandReport, verdict: 'local' });
    const fakeCheckServices = vi.fn(async () => []);

    await runTriageCommand({ loadServices: () => ['github'], checkServices: fakeCheckServices });

    expect(fakeCheckServices).not.toHaveBeenCalled();
  });

  it('adds no extra lines when every configured service is operational', async () => {
    vi.mocked(runTriage).mockResolvedValueOnce({ ...commandReport, verdict: 'mixed' });
    const fakeCheckServices = vi.fn(async () => [fakeServiceReport({})]);

    await runTriageCommand({ loadServices: () => ['github'], checkServices: fakeCheckServices });

    expect(loggedOutput()).not.toContain('status page reports');
  });
});

describe('resolveTriageTargets — services/targets name collision surfaces to the caller', () => {
  // Task 6 review, rider 1: resolveTriageTargets used to catch only
  // ConfigNotFoundError, so a config that exists but fails validation
  // (including the services:/targets: name-collision check) was silently
  // swallowed and triage fell through to autodiscovery instead — mirrors
  // the same fix already made in scan.ts/down.ts (see
  // scan-config-collision.test.ts for the equivalent runScan-level test).
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'crisismode-triage-collision-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects with ConfigValidationError naming the collision, instead of silently probing auto-detected targets', async () => {
    const configPath = join(tmpDir, 'crisismode.yaml');
    const collidingConfigYaml = [
      'apiVersion: crisismode/v1',
      'kind: SiteConfig',
      'metadata:',
      '  name: test-site',
      '  environment: development',
      'targets:',
      '  - name: svc.test.invalid',
      '    kind: redis',
      '    primary:',
      '      host: localhost',
      '      port: 6379',
      'services:',
      '  - svc.test.invalid',
      '',
    ].join('\n');
    writeFileSync(configPath, collidingConfigYaml, 'utf-8');

    await expect(resolveTriageTargets(configPath)).rejects.toThrow(ConfigValidationError);
    await expect(resolveTriageTargets(configPath)).rejects.toThrow(/collides/);
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
