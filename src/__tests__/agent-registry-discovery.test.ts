// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverAgentPlugins } from '../framework/registry/local.js';

/** Valid agent plugin manifest for testing. */
function validManifest(overrides?: Record<string, unknown>) {
  return {
    name: 'test-agent',
    version: '1.0.0',
    description: 'Test agent',
    kind: 'agent',
    entryPoint: './agent.js',
    targetKinds: ['postgresql'],
    crisismode: { minVersion: '0.3.0' },
    ...overrides,
  };
}

describe('agent plugin discovery', () => {
  const dirs: string[] = [];

  async function makeTmpDir(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), 'agent-disc-test-'));
    dirs.push(d);
    return d;
  }

  /** Create a plugin directory with a crisismode-agent.json manifest. */
  async function createAgentPlugin(
    parentDir: string,
    name: string,
    manifestOverrides?: Record<string, unknown>,
  ): Promise<string> {
    const pluginDir = join(parentDir, name);
    await mkdir(pluginDir, { recursive: true });

    const manifest = validManifest({ name, ...manifestOverrides });
    await writeFile(join(pluginDir, 'crisismode-agent.json'), JSON.stringify(manifest));
    return pluginDir;
  }

  beforeEach(() => {
    delete process.env.CRISISMODE_AGENT_PATH;
  });

  afterEach(async () => {
    for (const d of dirs) {
      await rm(d, { recursive: true, force: true }).catch(() => {});
    }
    dirs.length = 0;
    delete process.env.CRISISMODE_AGENT_PATH;
  });

  it('discovers agent plugins from project directory', async () => {
    const tmpDir = await makeTmpDir();
    const agentsDir = join(tmpDir, 'agents');
    await mkdir(agentsDir, { recursive: true });
    await createAgentPlugin(agentsDir, 'my-agent');

    const result = await discoverAgentPlugins({ projectDir: tmpDir });

    const projectPlugins = result.plugins.filter((p) => p.source === 'project');
    expect(projectPlugins).toHaveLength(1);
    const projectPlugin = projectPlugins[0]!;
    expect(projectPlugin.manifest.name).toBe('my-agent');
    expect(projectPlugin.manifest.kind).toBe('agent');
    expect(projectPlugin.source).toBe('project');
  });

  it('validates required manifest fields', async () => {
    const tmpDir = await makeTmpDir();
    const agentsDir = join(tmpDir, 'agents');
    await mkdir(agentsDir, { recursive: true });

    // Create a manifest missing `name`
    const pluginDir = join(agentsDir, 'bad-agent');
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, 'crisismode-agent.json'),
      JSON.stringify({ version: '1.0.0', kind: 'agent', description: 'missing name' }),
    );

    const result = await discoverAgentPlugins({ projectDir: tmpDir });

    expect(result.plugins).toHaveLength(0);
    const warning = result.warnings.find((w) => w.path.includes('bad-agent'));
    expect(warning).toBeDefined();
    expect(warning!.reason).toContain('name');
  });

  it('ignores directories without manifest', async () => {
    const tmpDir = await makeTmpDir();
    const agentsDir = join(tmpDir, 'agents');
    await mkdir(agentsDir, { recursive: true });

    // Directory without crisismode-agent.json
    await mkdir(join(agentsDir, 'no-manifest'), { recursive: true });

    const result = await discoverAgentPlugins({ projectDir: tmpDir });

    const projectPlugins = result.plugins.filter((p) => p.source === 'project');
    expect(projectPlugins).toHaveLength(0);
  });

  it('silently skips @crisismode-scoped npm packages without a manifest', async () => {
    const tmpDir = await makeTmpDir();
    const scopeDir = join(tmpDir, 'node_modules', '@crisismode');

    // A non-plugin package in the scope (e.g. the types-only agent-sdk)
    await mkdir(join(scopeDir, 'agent-sdk'), { recursive: true });
    await writeFile(join(scopeDir, 'agent-sdk', 'package.json'), '{"name":"@crisismode/agent-sdk"}');

    // A real plugin package alongside it
    await createAgentPlugin(scopeDir, 'real-plugin');

    const result = await discoverAgentPlugins({ projectDir: tmpDir });

    const nmPlugins = result.plugins.filter((p) => p.source === 'node_modules');
    expect(nmPlugins).toHaveLength(1);
    expect(nmPlugins[0]!.manifest.name).toBe('real-plugin');
    expect(result.warnings.filter((w) => w.path.includes('agent-sdk'))).toHaveLength(0);
  });

  it('still warns for a scoped npm package with a broken manifest', async () => {
    const tmpDir = await makeTmpDir();
    const scopeDir = join(tmpDir, 'node_modules', '@crisismode');
    await mkdir(join(scopeDir, 'broken-plugin'), { recursive: true });
    await writeFile(join(scopeDir, 'broken-plugin', 'crisismode-agent.json'), 'not json');

    const result = await discoverAgentPlugins({ projectDir: tmpDir });

    const warning = result.warnings.find((w) => w.path.includes('broken-plugin'));
    expect(warning).toBeDefined();
    expect(warning!.reason).toContain('Invalid JSON');
  });

  it('returns empty result for non-existent directory', async () => {
    const result = await discoverAgentPlugins({
      projectDir: '/tmp/nonexistent-agent-discovery-dir-' + Date.now(),
    });

    expect(result.plugins).toBeDefined();
    expect(result.warnings).toBeDefined();
    // No crash, no project-level plugins
    const projectPlugins = result.plugins.filter((p) => p.source === 'project');
    expect(projectPlugins).toHaveLength(0);
  });

  it('deduplicates by name', async () => {
    const dir1 = await makeTmpDir();
    const dir2 = await makeTmpDir();

    await createAgentPlugin(dir1, 'dup-agent', { version: '1.0.0' });
    await createAgentPlugin(dir2, 'dup-agent', { version: '2.0.0' });

    process.env.CRISISMODE_AGENT_PATH = `${dir1}:${dir2}`;

    const result = await discoverAgentPlugins({
      projectDir: '/tmp/nonexistent-agent-discovery-dir-' + Date.now(),
    });

    const envPlugins = result.plugins.filter(
      (p) => p.source === 'env' && p.manifest.name === 'dup-agent',
    );
    // Later source shadows earlier — should have exactly one
    expect(envPlugins).toHaveLength(1);
    expect(envPlugins[0]!.manifest.version).toBe('2.0.0');
  });
});
