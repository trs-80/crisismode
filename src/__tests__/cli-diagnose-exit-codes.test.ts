// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * `crisismode diagnose` — health verdict -> exit code.
 *
 * C8a: diagnose printed `unhealthy` and exited 0. It now returns the same
 * `severityExitCode` mapping scan uses, so the two commands can never
 * disagree about what "unhealthy" means to a shell.
 *
 * The agent, backend and network probe are mocked: what is under test is the
 * mapping from a health assessment to an exit code, not the assessment.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExitCode } from '../cli/exit-codes.js';
import { configure } from '../cli/output.js';
import type { HealthAssessment, HealthStatus } from '../types/health.js';
import type * as RuntimeModule from '../cli/runtime.js';
import type * as NetworkProfileModule from '../framework/network-profile.js';
import type * as CheckPluginModule from '../framework/check-plugin.js';

// vi.hoisted — see the note in cli-router-default-arm.test.ts.
const {
  loadConfigWithLocalTargets, probeNetwork, createForTarget, createFirst,
  discoverCheckPlugins, dispatchPluginExecution,
} = vi.hoisted(() => ({
  loadConfigWithLocalTargets: vi.fn(),
  probeNetwork: vi.fn(async () => ({
    mode: 'full',
    internet: { status: 'available', probes: [] },
    hub: { status: 'unknown' },
    dns: { available: true, latencyMs: 5 },
    targets: { status: 'available', probes: [] },
  })),
  createForTarget: vi.fn(),
  createFirst: vi.fn(),
  discoverCheckPlugins: vi.fn(async () => ({ plugins: [] as unknown[] })),
  dispatchPluginExecution: vi.fn(),
}));

vi.mock('../cli/runtime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeModule>();
  return { ...actual, loadConfigWithLocalTargets };
});

vi.mock('../framework/network-profile.js', async (importOriginal) => {
  const actual = await importOriginal<typeof NetworkProfileModule>();
  return { ...actual, probeNetwork };
});

class FakeAgentRegistry {
  createForTarget = createForTarget;
  createFirst = createFirst;
  static discoverVersion = vi.fn(async () => undefined);
}
vi.mock('../config/agent-registry.js', () => ({ AgentRegistry: FakeAgentRegistry }));

vi.mock('../framework/check-discovery.js', () => ({ discoverCheckPlugins }));
vi.mock('../framework/check-plugin.js', async (importOriginal) => {
  const actual = await importOriginal<typeof CheckPluginModule>();
  return { ...actual, dispatchPluginExecution };
});

const { runDiagnose } = await import('../cli/commands/diagnose.js');

const TARGET = { name: 'main-pg', kind: 'postgresql', primary: { host: 'h', port: 5432 } };

function health(status: HealthStatus): HealthAssessment {
  return {
    status,
    confidence: 0.9,
    summary: `postgresql is ${status}`,
    observedAt: new Date().toISOString(),
    signals: [],
    recommendedActions: [],
  };
}

function agentInstance(status: HealthStatus) {
  return {
    target: TARGET,
    backend: { close: vi.fn(async () => undefined) },
    agent: {
      // assembleContext (framework/context.ts) reads
      // spec.executionContexts; the rest is what the output printers touch.
      manifest: {
        metadata: { name: 'pg', version: '1.0.0', description: 'pg' },
        spec: { targetSystems: [], executionContexts: [{ name: 'kubernetes' }] },
      },
      assessHealth: vi.fn(async () => health(status)),
      diagnose: vi.fn(async () => ({
        summary: `postgresql is ${status}`,
        findings: [],
        confidence: 0.8,
        rootCause: null,
        evidence: [],
      })),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  configure({ json: false, noColor: true, mode: 'human' });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  loadConfigWithLocalTargets.mockResolvedValue({ config: { targets: [TARGET] }, source: 'file' });
  discoverCheckPlugins.mockResolvedValue({ plugins: [] });
});

describe('runDiagnose — health verdict becomes the exit code', () => {
  it.each([
    ['healthy', ExitCode.OK],
    // A single target whose health could not be determined is the
    // all-unknown case for diagnose: nothing was measured.
    ['unknown', ExitCode.INDETERMINATE],
    ['recovering', ExitCode.UNHEALTHY],
    ['unhealthy', ExitCode.UNHEALTHY],
  ] as const)('a %s target exits %i', async (status, expected) => {
    createFirst.mockResolvedValue(agentInstance(status));
    expect(await runDiagnose({})).toBe(expected);
  });

  it('closes the backend even when the target is unhealthy', async () => {
    const instance = agentInstance('unhealthy');
    createFirst.mockResolvedValue(instance);
    await runDiagnose({});
    expect(instance.backend.close).toHaveBeenCalled();
  });

  it('uses the named target when --target / a positional is given', async () => {
    createForTarget.mockResolvedValue(agentInstance('healthy'));
    expect(await runDiagnose({ targetName: 'main-pg' })).toBe(ExitCode.OK);
    expect(createForTarget).toHaveBeenCalledWith('main-pg');
  });
});

describe('runDiagnose — an unknown target name is a usage error, not an internal one', () => {
  /**
   * The validation used to sit *after* `probeNetwork(...)` was called, so a
   * typo'd target name fired real network probes against every configured
   * target before erroring. Under pressure a typo should fail in
   * milliseconds, not after a network round-trip.
   */
  it('fails before any network probe is started', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runDiagnose({ targetName: 'PG-001' });
    err.mockRestore();
    expect(code).toBe(ExitCode.USAGE);
    expect(probeNetwork).not.toHaveBeenCalled();
    expect(FakeAgentRegistry.discoverVersion).not.toHaveBeenCalled();
  });

  it('still probes the network for a target that does exist', async () => {
    createForTarget.mockResolvedValue(agentInstance('healthy'));
    await runDiagnose({ targetName: 'main-pg' });
    expect(probeNetwork).toHaveBeenCalled();
  });

  it('returns USAGE and names the target plus the available ones', async () => {
    // printError writes to stderr, not stdout.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runDiagnose({ targetName: 'PG-001' });
    const printed = err.mock.calls.map((c) => c.join(' ')).join('\n');
    err.mockRestore();
    // Previously this escaped as a bare Error from AgentRegistry and hit the
    // top-level catch — exit 1 before this PR, and indistinguishable from
    // "the database is down"; exit 70 if left unclassified.
    expect(code).toBe(ExitCode.USAGE);
    expect(printed).toContain('PG-001');
    expect(printed).toContain('main-pg');
    // The registry must never be asked to build an agent for a name that
    // does not exist.
    expect(createForTarget).not.toHaveBeenCalled();
  });
});

describe('runDiagnose — PLUG-* IDs route to the check plugin', () => {
  function plugin(name: string) {
    return {
      manifest: { name, verbs: ['diagnose'], targetKinds: ['tls'], timeoutMs: 1000, docs: {} },
      pluginDir: '/tmp/checks/' + name,
    };
  }

  it.each([
    [{ healthy: true, summary: 'all good' }, 'ok', ExitCode.OK],
    [{ healthy: false, summary: 'expiring soon' }, 'warning', ExitCode.UNHEALTHY],
    [{ healthy: false, summary: 'expired' }, 'critical', ExitCode.UNHEALTHY],
  ])('plugin result %j (%s) exits %i', async (result, exitStatus, expected) => {
    discoverCheckPlugins.mockResolvedValue({ plugins: [plugin('check-tls')] });
    dispatchPluginExecution.mockResolvedValue({ result, exitStatus });
    expect(await runDiagnose({ targetName: 'PLUG-001' })).toBe(expected);
  });

  it('returns USAGE when the PLUG index resolves to no plugin', async () => {
    discoverCheckPlugins.mockResolvedValue({ plugins: [] });
    // Nothing was checked, so nothing is known to be broken — the ID the
    // user passed does not resolve.
    expect(await runDiagnose({ targetName: 'PLUG-999' })).toBe(ExitCode.USAGE);
  });

  /**
   * A diagnose run that produced no diagnosis at all is the case code 3
   * exists for: CrisisMode determined nothing. Returning OK rendered that as
   * a successful CI status — a false green.
   */
  it.each([
    ['ok'],
    ['warning'],
    ['critical'],
    ['unknown'],
  ])('returns INDETERMINATE when the plugin produced no diagnosis output (exitStatus %s)', async (exitStatus) => {
    discoverCheckPlugins.mockResolvedValue({ plugins: [plugin('check-tls')] });
    dispatchPluginExecution.mockResolvedValue({ result: null, exitStatus });
    const code = await runDiagnose({ targetName: 'PLUG-001' });
    expect(code).toBe(ExitCode.INDETERMINATE);
    expect(code).not.toBe(ExitCode.OK);
  });

  it('renders findings and docs without changing the code', async () => {
    discoverCheckPlugins.mockResolvedValue({
      plugins: [{
        manifest: {
          name: 'check-tls', verbs: ['diagnose'], targetKinds: ['tls'], timeoutMs: 1000,
          docs: { explanation: 'checks certs', learnMoreUrl: 'https://example.invalid' },
        },
        pluginDir: '/tmp/checks/check-tls',
      }],
    });
    dispatchPluginExecution.mockResolvedValue({
      result: {
        healthy: false,
        summary: 'expired',
        findings: [
          { severity: 'critical', title: 'cert expired', detail: '3 days ago' },
          { severity: 'warning', title: 'chain incomplete', detail: 'missing intermediate' },
          { severity: 'info', title: 'note', detail: 'renewal scheduled' },
        ],
      },
      exitStatus: 'critical',
    });
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    const code = await runDiagnose({ targetName: 'PLUG-001' });
    const printed = logs.join('\n');
    expect(code).toBe(ExitCode.UNHEALTHY);
    // The test is named for the *rendering*; asserting only the exit code
    // would pass with either renderer deleted.
    expect(printed).toContain('cert expired');
    expect(printed).toContain('3 days ago');
    expect(printed).toContain('chain incomplete');
    expect(printed).toContain('renewal scheduled');
    expect(printed).toContain('checks certs');
    expect(printed).toContain('https://example.invalid');
  });
});
