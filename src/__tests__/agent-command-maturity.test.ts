// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Keep the test hermetic: no filesystem scan for plugin agents. One stub
// plugin so the plugin branches of list/info are exercised too. The literal
// is inline because vi.mock factories are hoisted above module-level consts.
vi.mock('../framework/registry/local.js', () => ({
  discoverAgentPlugins: vi.fn(async () => ({
    plugins: [
      {
        pluginDir: '/tmp/crisismode-agents/acme-mysql',
        source: 'project',
        manifest: {
          name: 'acme-mysql-recovery',
          version: '0.1.0',
          description: 'Community MySQL recovery agent',
          kind: 'agent',
          targetKinds: ['mysql'],
          riskProfile: { maxRiskLevel: 'elevated', dataLossPossible: false },
          crisismode: { minVersion: '0.1.0' },
        },
      },
    ],
    warnings: [],
  })),
}));

import { runAgent } from '../cli/commands/agent.js';

describe('crisismode agent list — maturity', () => {
  let lines: string[];
  beforeEach(() => {
    lines = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  });
  afterEach(() => vi.restoreAllMocks());

  it('reports maturity per agent in JSON mode', async () => {
    await runAgent({ subcommand: 'list', args: [], json: true });
    const entries = JSON.parse(lines.join('\n')) as Array<{ name: string; maturity: string }>;
    expect(entries.find((e) => e.name === 'postgresql-replication-recovery')!.maturity).toBe('live_validated');
    expect(entries.find((e) => e.name === 'kafka-recovery')!.maturity).toBe('simulator_only');
  });

  it('reports plugin agents as best-effort — nobody has validated them', async () => {
    await runAgent({ subcommand: 'list', args: [], json: true });
    const entries = JSON.parse(lines.join('\n')) as Array<{ name: string; maturity: string }>;
    expect(entries.find((e) => e.name === 'acme-mysql-recovery')!.maturity).toBe('simulator_only');
  });

  it('shows a maturity column in the human table', async () => {
    await runAgent({ subcommand: 'list', args: [] });
    const text = lines.join('\n');
    expect(text).toContain('Maturity');
    expect(lines.find((l) => l.includes('kafka-recovery'))).toContain('best-effort');
    expect(lines.find((l) => l.includes('postgresql-replication-recovery'))).toContain('live-validated');
    expect(lines.find((l) => l.includes('acme-mysql-recovery'))).toContain('best-effort');
  });
});

describe('crisismode agent info — maturity', () => {
  let lines: string[];
  beforeEach(() => {
    lines = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  });
  afterEach(() => vi.restoreAllMocks());

  it('prints the honest hint for a best-effort agent', async () => {
    await runAgent({ subcommand: 'info', args: ['kafka-recovery'] });
    const text = lines.join('\n');
    expect(text).toContain('best-effort');
    expect(text).toContain('never been validated against a real kafka');
  });

  it('prints no hint for a live-validated agent', async () => {
    await runAgent({ subcommand: 'info', args: ['postgresql-replication-recovery'] });
    const text = lines.join('\n');
    expect(text).toContain('live-validated');
    expect(text).not.toContain('never been validated');
  });

  it('includes maturity in JSON mode', async () => {
    await runAgent({ subcommand: 'info', args: ['kafka-recovery'], json: true });
    const parsed = JSON.parse(lines.join('\n')) as { maturity: string };
    expect(parsed.maturity).toBe('simulator_only');
  });

  it('shows maturity and the hint for a plugin agent too', async () => {
    await runAgent({ subcommand: 'info', args: ['acme-mysql-recovery'] });
    const text = lines.join('\n');
    expect(text).toContain('best-effort');
    expect(text).toContain('never been validated against a real mysql');
  });

  it('includes maturity in plugin JSON mode', async () => {
    await runAgent({ subcommand: 'info', args: ['acme-mysql-recovery'], json: true });
    const parsed = JSON.parse(lines.join('\n')) as { maturity: string; type: string };
    expect(parsed.type).toBe('plugin');
    expect(parsed.maturity).toBe('simulator_only');
  });
});
