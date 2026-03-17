// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, mkdtemp, rm, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverCheckPlugins, loadPlugin } from '../framework/check-discovery.js';

describe('check-discovery', () => {
  const dirs: string[] = [];

  async function makeTmpDir(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), 'check-disc-test-'));
    dirs.push(d);
    return d;
  }

  /** Create a valid plugin directory with a manifest and executable. */
  async function createPlugin(
    parentDir: string,
    name: string,
    overrides?: Record<string, unknown>,
  ): Promise<string> {
    const pluginDir = join(parentDir, name);
    await mkdir(pluginDir, { recursive: true });

    const manifest = {
      name,
      description: `Test plugin ${name}`,
      version: '1.0.0',
      targetKinds: ['generic'],
      verbs: ['health'],
      executable: './run.sh',
      ...overrides,
    };
    await writeFile(join(pluginDir, 'manifest.json'), JSON.stringify(manifest));

    const execPath = join(pluginDir, 'run.sh');
    await writeFile(execPath, '#!/bin/bash\necho "{}"\n', { mode: 0o755 });
    await chmod(execPath, 0o755);

    return pluginDir;
  }

  afterEach(async () => {
    for (const d of dirs) {
      await rm(d, { recursive: true, force: true }).catch(() => {});
    }
    dirs.length = 0;
    // Clean up env var
    delete process.env.CRISISMODE_CHECK_PATH;
  });

  // ── discoverCheckPlugins ──

  describe('discoverCheckPlugins', () => {
    it('discovers plugins from CRISISMODE_CHECK_PATH', async () => {
      const envDir = await makeTmpDir();
      await createPlugin(envDir, 'my-check');

      process.env.CRISISMODE_CHECK_PATH = envDir;

      // Use a non-existent project dir to avoid picking up real plugins
      const result = await discoverCheckPlugins({ projectDir: '/tmp/nonexistent-project-dir' });

      // Filter to only env-sourced plugins to avoid user-level noise
      const envPlugins = result.plugins.filter((p) => p.source === 'env');
      expect(envPlugins.length).toBeGreaterThanOrEqual(1);
      expect(envPlugins.find((p) => p.manifest.name === 'my-check')).toBeDefined();
    });

    it('skips directories without manifest.json', async () => {
      const envDir = await makeTmpDir();
      // Create a directory with no manifest
      await mkdir(join(envDir, 'no-manifest'));
      await createPlugin(envDir, 'valid-check');

      process.env.CRISISMODE_CHECK_PATH = envDir;
      const result = await discoverCheckPlugins({ projectDir: '/tmp/nonexistent-project-dir' });

      const envPlugins = result.plugins.filter((p) => p.source === 'env');
      expect(envPlugins.length).toBe(1);
      expect(envPlugins[0].manifest.name).toBe('valid-check');

      // The directory without manifest should generate a warning
      const relevantWarnings = result.warnings.filter((w) => w.path.includes('no-manifest'));
      expect(relevantWarnings.length).toBe(1);
    });

    it('warns on invalid manifests', async () => {
      const envDir = await makeTmpDir();
      const badDir = join(envDir, 'bad-manifest');
      await mkdir(badDir, { recursive: true });
      await writeFile(join(badDir, 'manifest.json'), '{ not valid json !!!');

      process.env.CRISISMODE_CHECK_PATH = envDir;
      const result = await discoverCheckPlugins({ projectDir: '/tmp/nonexistent-project-dir' });

      const envPlugins = result.plugins.filter((p) => p.source === 'env');
      expect(envPlugins.length).toBe(0);
      expect(result.warnings.find((w) => w.path.includes('bad-manifest'))).toBeDefined();
    });

    it('deduplicates plugins by name (later source shadows earlier)', async () => {
      const dir1 = await makeTmpDir();
      const dir2 = await makeTmpDir();

      await createPlugin(dir1, 'dup-check', { version: '1.0.0' });
      await createPlugin(dir2, 'dup-check', { version: '2.0.0' });

      process.env.CRISISMODE_CHECK_PATH = `${dir1}:${dir2}`;
      const result = await discoverCheckPlugins({ projectDir: '/tmp/nonexistent-project-dir' });

      const envPlugins = result.plugins.filter(
        (p) => p.source === 'env' && p.manifest.name === 'dup-check',
      );
      // Should have exactly one, the later one (version 2.0.0)
      expect(envPlugins.length).toBe(1);
      expect(envPlugins[0].manifest.version).toBe('2.0.0');
    });

    it('returns empty results when no plugin directories exist', async () => {
      delete process.env.CRISISMODE_CHECK_PATH;
      const result = await discoverCheckPlugins({ projectDir: '/tmp/nonexistent-project-dir' });
      // We may get user-level plugins; at minimum no crash
      expect(result.plugins).toBeDefined();
      expect(result.warnings).toBeDefined();
    });
  });

  // ── loadPlugin ──

  describe('loadPlugin', () => {
    it('loads a valid plugin directory', async () => {
      const parentDir = await makeTmpDir();
      const pluginDir = await createPlugin(parentDir, 'load-test');

      const plugin = await loadPlugin(pluginDir, 'project');
      expect(plugin.manifest.name).toBe('load-test');
      expect(plugin.source).toBe('project');
      expect(plugin.executablePath).toContain('run.sh');
    });

    it('rejects a directory without manifest.json', async () => {
      const emptyDir = await makeTmpDir();
      await expect(loadPlugin(emptyDir)).rejects.toThrow('Missing manifest.json');
    });

    it('rejects a directory with non-executable file', async () => {
      const parentDir = await makeTmpDir();
      const pluginDir = join(parentDir, 'no-exec');
      await mkdir(pluginDir, { recursive: true });

      const manifest = {
        name: 'no-exec',
        description: 'test',
        version: '1.0.0',
        targetKinds: ['generic'],
        verbs: ['health'],
        executable: './run.sh',
      };
      await writeFile(join(pluginDir, 'manifest.json'), JSON.stringify(manifest));
      // Write the script but do NOT make it executable
      await writeFile(join(pluginDir, 'run.sh'), '#!/bin/bash\necho "{}"\n', { mode: 0o644 });

      await expect(loadPlugin(pluginDir)).rejects.toThrow('not found or not executable');
    });

    it('rejects a manifest missing required fields', async () => {
      const parentDir = await makeTmpDir();
      const pluginDir = join(parentDir, 'bad-fields');
      await mkdir(pluginDir, { recursive: true });
      await writeFile(
        join(pluginDir, 'manifest.json'),
        JSON.stringify({ description: 'missing name and executable' }),
      );

      await expect(loadPlugin(pluginDir)).rejects.toThrow('missing');
    });
  });
});
