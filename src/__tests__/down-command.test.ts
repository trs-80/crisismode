// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  downExitCode,
  renderDownHuman,
  renderDownPipeLine,
  runDownCommand,
} from '../cli/commands/down.js';
import { parseCli } from '../cli/args.js';
import { runCli, HELP } from '../cli/run.js';
import { configure, setOutputOptions } from '../cli/output.js';
import { getProviderSpec } from '../agent/llm-provider/provider-table.js';
import { ConfigValidationError } from '../config/loader.js';
import type { CheckerDeps } from '../framework/service-status/checker.js';
import type { ProbeOutcome, ServiceStatusReport, ServiceVerdict } from '../framework/service-status/types.js';

function statuspageBody(
  indicator: string,
  incidents: Array<{ name: string; status: string; impact: string }> = [],
): unknown {
  return { status: { indicator }, incidents, components: [] };
}

function fakeFetch(body: unknown, ok = true): typeof fetch {
  return (async () => ({ ok, json: async () => body }) as unknown as Response) as unknown as typeof fetch;
}

function fakeProbe(outcome: ProbeOutcome): NonNullable<CheckerDeps['probeImpl']> {
  return async () => outcome;
}

function makeReport(verdict: ServiceVerdict, overrides: Partial<ServiceStatusReport> = {}): ServiceStatusReport {
  return {
    id: 'svc',
    label: 'Svc',
    source: 'catalog',
    host: 'svc.example.com',
    port: 443,
    statusAssessment: 'operational',
    incidents: [],
    probe: 'reachable',
    verdict,
    detail: `Svc verdict: ${verdict}`,
    checkedAt: '2026-08-08T00:00:00.000Z',
    durationMs: 5,
    ...overrides,
  };
}

afterEach(() => {
  configure({ json: false, noColor: false, mode: 'human' });
  setOutputOptions({ terse: false });
});

describe('downExitCode', () => {
  it('exits 0 for every healthy-flavored verdict', () => {
    expect(downExitCode([makeReport('healthy')])).toBe(0);
    expect(downExitCode([makeReport('healthy_unverified')])).toBe(0);
    expect(downExitCode([makeReport('healthy_probe_only')])).toBe(0);
  });

  it('exits 0 when offline_skipped — a skip is not evidence of a problem', () => {
    expect(downExitCode([makeReport('offline_skipped')])).toBe(0);
  });

  it('exits 1 for confirmed_incident', () => {
    expect(downExitCode([makeReport('confirmed_incident')])).toBe(1);
  });

  it('exits 1 when down_for_you is present among otherwise-healthy reports', () => {
    expect(downExitCode([makeReport('healthy'), makeReport('down_for_you')])).toBe(1);
  });

  it('exits 1 for degraded_upstream, unreachable_unverified, and unreachable_probe_only', () => {
    expect(downExitCode([makeReport('degraded_upstream')])).toBe(1);
    expect(downExitCode([makeReport('unreachable_unverified')])).toBe(1);
    expect(downExitCode([makeReport('unreachable_probe_only')])).toBe(1);
  });
});

/**
 * `down`'s private re-parser (`parseDownArgs`) is deleted. It existed only
 * because index.ts's global `parseArgs({ strict: false })` silently accepted
 * any unrecognized flag, so `down` had to re-validate the raw argv itself —
 * the fix applied at one call site instead of once, centrally.
 *
 * The same guarantees now come from `cli/args.ts` for every command, so the
 * cases that used to be asserted against `parseDownArgs` are asserted
 * against the shared parser, at the same `crisismode down ...` argv the user
 * actually types.
 */
describe('down flag validation (now central, in cli/args.ts)', () => {
  it('collects positionals as service ids', () => {
    const parsed = parseCli(['down', 'stripe', 'github']);
    expect(parsed.kind).toBe('command');
    if (parsed.kind !== 'command') return;
    expect(parsed.command).toBe('down');
    expect(parsed.positionals).toEqual(['stripe', 'github']);
  });

  it('keeps known flags (and --config\'s value) out of the service ids', () => {
    const parsed = parseCli(['down', 'stripe', '--json', '--config', '/tmp/x.yaml', '--terse']);
    expect(parsed.kind).toBe('command');
    if (parsed.kind !== 'command') return;
    expect(parsed.positionals).toEqual(['stripe']);
    expect(parsed.values.config).toBe('/tmp/x.yaml');
  });

  it('reports the unrecognized flag', () => {
    const parsed = parseCli(['down', 'stripe', '--bogus']);
    expect(parsed.kind).toBe('usage');
    if (parsed.kind !== 'usage') return;
    expect(parsed.message).toContain('--bogus');
  });

  /**
   * CodeRabbit wave: a bare `--config` (nothing after it, or the next token
   * is itself a flag) used to be consumed unconditionally — `down --config`
   * silently proceeded with no path, and `down --config --terse` swallowed
   * `--terse` as a literal config-file path ("Config file not found:
   * .../--terse"). Both are a missing/flag-like value, a usage error.
   */
  it.each([
    [['down', '--config']],
    [['down', '--config', '--terse']],
  ])('%j is a usage error naming --config', (argv) => {
    const parsed = parseCli(argv as string[]);
    expect(parsed.kind).toBe('usage');
    if (parsed.kind !== 'usage') return;
    expect(parsed.message).toContain('--config');
  });

  it('still accepts a well-formed --config <path>', () => {
    const parsed = parseCli(['down', 'stripe', '--config', '/tmp/x.yaml']);
    expect(parsed.kind).toBe('command');
    if (parsed.kind !== 'command') return;
    expect(parsed.positionals).toEqual(['stripe']);
  });
});

describe('renderDownHuman / renderDownReportLines', () => {
  afterEach(() => setOutputOptions({ terse: false }));

  it('shows the verdict and detail, with incident titles indented beneath', () => {
    const report = makeReport('confirmed_incident', {
      label: 'Stripe',
      detail: 'Stripe is down for everyone — they\'ve confirmed an incident.',
      incidents: [{ title: 'Stripe API outage', impact: 'critical' }],
    });
    const lines = renderDownHuman([report]).join('\n');
    expect(lines).toContain('confirmed_incident');
    expect(lines).toContain(report.detail);
    expect(lines).toContain('Stripe API outage');
  });

  it('drops the detail line in --terse but keeps the verdict', () => {
    setOutputOptions({ terse: true });
    const report = makeReport('confirmed_incident', { detail: 'explanation text that should vanish' });
    const lines = renderDownHuman([report]).join('\n');
    expect(lines).not.toContain('explanation text that should vanish');
    expect(lines).toContain('confirmed_incident');
  });
});

describe('renderDownPipeLine', () => {
  it('is tab-separated: id, verdict, statusAssessment, probe, detail', () => {
    const report = makeReport('healthy', { id: 'github', label: 'GitHub', detail: 'GitHub is healthy and reachable.' });
    expect(renderDownPipeLine(report)).toBe('github\thealthy\toperational\treachable\tGitHub is healthy and reachable.');
  });
});

describe('runDownCommand', () => {
  it('down stripe: human output contains the verdict and incident title; exits 1 for confirmed_incident', async () => {
    configure({ json: false, noColor: true, mode: 'human' });
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => logs.push(a.map(String).join(' ')));
    const fetchImpl = fakeFetch(statuspageBody('major', [{ name: 'Stripe API outage', status: 'investigating', impact: 'critical' }]));
    const probeImpl = fakeProbe('reachable');
    const code = await runDownCommand(['stripe'], { fetchImpl, probeImpl, offlineGate: async () => null });
    spy.mockRestore();
    const out = logs.join('\n');
    expect(out).toContain('confirmed_incident');
    expect(out).toContain('Stripe API outage');
    expect(code).toBe(1);
  });

  it('exits 0 when everything checked is healthy', async () => {
    configure({ json: false, noColor: true, mode: 'human' });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchImpl = fakeFetch(statuspageBody('none'));
    const probeImpl = fakeProbe('reachable');
    const code = await runDownCommand(['github'], { fetchImpl, probeImpl, offlineGate: async () => null });
    spy.mockRestore();
    expect(code).toBe(0);
  });

  it('exits 0 for healthy_unverified (status page unreachable, service reachable)', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchImpl = fakeFetch({}, false);
    const probeImpl = fakeProbe('reachable');
    const code = await runDownCommand(['vercel'], { fetchImpl, probeImpl, offlineGate: async () => null });
    spy.mockRestore();
    expect(code).toBe(0);
  });

  it('exits 0 for healthy_probe_only (raw domain, no catalog entry, reachable)', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchImpl = vi.fn();
    const probeImpl = fakeProbe('reachable');
    const code = await runDownCommand(['example.com'], { fetchImpl: fetchImpl as unknown as typeof fetch, probeImpl, offlineGate: async () => null });
    spy.mockRestore();
    expect(code).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('down_for_you: exits 1 and suggests crisismode triage', async () => {
    configure({ json: false, noColor: true, mode: 'human' });
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => logs.push(a.map(String).join(' ')));
    const fetchImpl = fakeFetch(statuspageBody('none'));
    const probeImpl = fakeProbe('dns_failed');
    const code = await runDownCommand(['github'], { fetchImpl, probeImpl, offlineGate: async () => null });
    spy.mockRestore();
    const out = logs.join('\n');
    expect(out).toContain('down_for_you');
    expect(out.toLowerCase()).toContain('crisismode triage');
    expect(code).toBe(1);
  });

  it('bare down with no configured services: exits 0, shows both usage forms, is not an error', async () => {
    configure({ json: false, noColor: true, mode: 'human' });
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => logs.push(a.map(String).join(' ')));
    const loadConfig = (() => ({ config: null, source: 'none' as const })) as never;
    const code = await runDownCommand([], { loadConfig });
    spy.mockRestore();
    const out = logs.join('\n');
    expect(out).toContain('crisismode down <service>');
    expect(out).toContain('services:');
    expect(code).toBe(0);
  });

  /**
   * Round 2 fix (Task 6 review, re-review Medium 1): `runDownCommand` used
   * to swallow anything except `ConfigNotFoundError` from `loadConfig` and
   * fall through to "No services configured to check" (exit 0) — including
   * a genuine validation failure such as a services:/targets: name
   * collision. Drives the real `runDownCommand` command surface (the
   * injectable `loadConfig` seam `RunDownCommandDeps` already exists for)
   * to prove the error now propagates instead.
   */
  it('propagates a ConfigValidationError instead of printing "no services configured"', async () => {
    configure({ json: false, noColor: true, mode: 'human' });
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => logs.push(a.map(String).join(' ')));
    const loadConfig = (() => {
      throw new ConfigValidationError(
        'Config error: services entry "github" resolves to the name "github", which collides with ' +
        'targets[] entry "github" (kind: redis).',
      );
    }) as never;

    await expect(runDownCommand([], { loadConfig })).rejects.toThrow(ConfigValidationError);
    await expect(runDownCommand([], { loadConfig })).rejects.toThrow(/collides/);

    spy.mockRestore();
    const out = logs.join('\n');
    expect(out).not.toContain('No services configured');
  });

  it('bare down with configured services: checks exactly those', async () => {
    configure({ json: false, noColor: true, mode: 'pipe' });
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => logs.push(a.map(String).join(' ')));
    const fetchImpl = fakeFetch(statuspageBody('none'));
    const probeImpl = fakeProbe('reachable');
    const loadConfig = (() => ({ config: { services: ['github', 'stripe'] }, source: 'file' as const })) as never;
    const code = await runDownCommand([], { fetchImpl, probeImpl, offlineGate: async () => null, loadConfig });
    spy.mockRestore();
    const ids = logs.map((l) => l.split('\t')[0]).sort();
    expect(ids).toEqual(['github', 'stripe']);
    expect(code).toBe(0);
  });

  it('down anthropic resolves via the llm-provider table statusUrl, not raw-domain DNS', async () => {
    const spec = getProviderSpec('anthropic')!;
    const fetchImpl = vi.fn(fakeFetch(statuspageBody('none')));
    const probeImpl = vi.fn(fakeProbe('reachable'));
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runDownCommand(['anthropic'], { fetchImpl, probeImpl, offlineGate: async () => null });
    spy.mockRestore();
    expect(fetchImpl).toHaveBeenCalledWith(spec.statusUrl, expect.anything());
    expect(probeImpl).toHaveBeenCalledWith(spec.apiHost, 443, expect.any(Number));
    expect(code).toBe(0);
  });

  it('down openai resolves via the llm-provider table statusUrl, not raw-domain DNS', async () => {
    const spec = getProviderSpec('openai')!;
    const fetchImpl = vi.fn(fakeFetch(statuspageBody('none')));
    const probeImpl = vi.fn(fakeProbe('reachable'));
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runDownCommand(['openai'], { fetchImpl, probeImpl, offlineGate: async () => null });
    spy.mockRestore();
    expect(fetchImpl).toHaveBeenCalledWith(spec.statusUrl, expect.anything());
    expect(probeImpl).toHaveBeenCalledWith(spec.apiHost, 443, expect.any(Number));
    expect(code).toBe(0);
  });

  it('exits 2 on an unrecognized flag (rejected by the shared parser, before the command runs)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runCli(['down', 'stripe', '--bogus']);
    errSpy.mockRestore();
    expect(code).toBe(2);
  });

  /**
   * Medium 4: a malformed ad-hoc positional (URL, path, spaces) used to fall
   * through to raw-domain DNS handling and exit 1 with a misleading "may be
   * your network" reachability line — a usage error reported as a
   * reachability failure. The config path already rejects these at load
   * time (service-status-config.test.ts); this is the ad-hoc-arg
   * equivalent, checked before any network call.
   */
  it('exits 2 on a malformed ad-hoc service argument, naming the bad arg, without ever probing DNS', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn();
    const probeImpl = vi.fn();
    const code = await runDownCommand(
      ['http://api.foo.com/path'],
      { fetchImpl: fetchImpl as unknown as typeof fetch, probeImpl },
    );
    const errOut = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    errSpy.mockRestore();
    expect(code).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(probeImpl).not.toHaveBeenCalled();
    expect(errOut).toContain('http://api.foo.com/path');
  });

  it('exits 2 on an ad-hoc argument containing a space', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runDownCommand(['has space']);
    errSpy.mockRestore();
    expect(code).toBe(2);
  });

  it('a valid raw domain and a catalog id are unaffected by the ad-hoc validation', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchImpl = fakeFetch(statuspageBody('none'));
    const probeImpl = fakeProbe('reachable');
    const code = await runDownCommand(['example.com', 'github'], { fetchImpl, probeImpl, offlineGate: async () => null });
    spy.mockRestore();
    expect(code).toBe(0);
  });

  /**
   * CodeRabbit wave: bare/flag-swallowing `--config` used to silently
   * proceed (missing value) or eat the next flag as a literal path
   * (flag-like value) instead of failing usage. Drives the real
   * runDownCommand surface so a regression here is caught at the command
   * boundary, not just in parseDownArgs' return shape.
   */
  it('exits 2 on a bare --config with nothing after it, naming --config', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runCli(['down', '--config']);
    const errOut = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    errSpy.mockRestore();
    expect(code).toBe(2);
    expect(errOut).toContain('--config');
  });

  it('exits 2 on --config immediately followed by another flag, never treating the flag as a path', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runCli(['down', '--config', '--terse']);
    errSpy.mockRestore();
    expect(code).toBe(2);
  });

  it('--json emits one parseable JSON object per service with id/verdict/statusAssessment/probe/detail', async () => {
    configure({ json: true, noColor: true });
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => logs.push(a.map(String).join(' ')));
    const fetchImpl = fakeFetch(statuspageBody('none'));
    const probeImpl = fakeProbe('reachable');
    await runDownCommand(['github'], { fetchImpl, probeImpl, offlineGate: async () => null });
    spy.mockRestore();
    expect(logs).toHaveLength(1);
    const parsed = JSON.parse(logs[0]!) as Record<string, unknown>;
    expect(parsed).toMatchObject({ id: 'github', verdict: 'healthy', statusAssessment: 'operational', probe: 'reachable' });
    expect(typeof parsed.detail).toBe('string');
  });

  it('--json with multiple services emits one parseable JSON object per line', async () => {
    configure({ json: true, noColor: true });
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => logs.push(a.map(String).join(' ')));
    const fetchImpl = fakeFetch(statuspageBody('none'));
    const probeImpl = fakeProbe('reachable');
    await runDownCommand(['github', 'stripe'], { fetchImpl, probeImpl, offlineGate: async () => null });
    spy.mockRestore();
    expect(logs).toHaveLength(2);
    const parsed = logs.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed.map((p) => p.id).sort()).toEqual(['github', 'stripe']);
    for (const p of parsed) {
      expect(p).toMatchObject({ verdict: 'healthy', statusAssessment: 'operational', probe: 'reachable' });
      expect(typeof p.detail).toBe('string');
    }
  });

  it('pipe mode: tab-separated id/verdict/statusAssessment/probe/detail, no ANSI', async () => {
    configure({ json: false, noColor: true, mode: 'pipe' });
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => logs.push(a.map(String).join(' ')));
    const fetchImpl = fakeFetch(statuspageBody('none'));
    const probeImpl = fakeProbe('reachable');
    await runDownCommand(['github'], { fetchImpl, probeImpl, offlineGate: async () => null });
    spy.mockRestore();
    expect(logs).toEqual(['github\thealthy\toperational\treachable\tGitHub is healthy and reachable.']);
    // eslint-disable-next-line no-control-regex
    expect(logs[0]).not.toMatch(/\x1b\[/);
  });
});

describe('CLI registration', () => {
  // Routing and the help text moved from index.ts to run.ts when the
  // exit-code contract was centralized; index.ts is now the process boundary.
  const runSource = readFileSync(fileURLToPath(new URL('../cli/run.ts', import.meta.url)), 'utf-8');
  const completionsSource = readFileSync(
    fileURLToPath(new URL('../cli/commands/completions.ts', import.meta.url)),
    'utf-8',
  );

  it('routes the down subcommand to runDownCommand', () => {
    const parsed = parseCli(['down']);
    expect(parsed.kind).toBe('command');
    if (parsed.kind === 'command') expect(parsed.command).toBe('down');
    expect(runSource).toContain("case 'down':");
    expect(runSource).toContain("await import('./commands/down.js')");
    expect(runSource).toContain('runDownCommand');
  });

  it('documents down and its exit codes in the help text', () => {
    expect(HELP).toContain('crisismode down');
    expect(HELP).toContain('exit 0/1/2');
  });

  it('lists down alongside triage in the completion scripts', () => {
    expect(completionsSource).toContain('down');
  });
});
