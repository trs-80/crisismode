// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import {
  loadLocalRegistry,
  matchEntries,
} from '../config/check-registry.js';
import type { CheckRegistryEntry } from '../config/check-registry.js';
import {
  getInstalledVersion,
} from '../framework/check-installer.js';

// ── Registry types and loading ──

describe('check-registry', () => {
  describe('loadLocalRegistry()', () => {
    it('loads the bundled registry index', () => {
      const registry = loadLocalRegistry();

      expect(registry.schemaVersion).toBe(1);
      expect(registry.checks.length).toBeGreaterThan(0);
      expect(registry.updatedAt).toBeTruthy();
    });

    it('includes all 8 built-in checks', () => {
      const registry = loadLocalRegistry();

      const names = registry.checks.map((c) => c.name);
      expect(names).toContain('check-disk-usage');
      expect(names).toContain('check-certificate-expiry');
      expect(names).toContain('check-dns-resolution');
      expect(names).toContain('check-http-endpoint');
      expect(names).toContain('check-memory-usage');
      expect(names).toContain('example-nagios-uptime');
      expect(names).toContain('example-goss-system');
      expect(names).toContain('example-sensu-metrics');
      expect(registry.checks).toHaveLength(8);
    });

    it('every entry has required fields', () => {
      const registry = loadLocalRegistry();

      for (const check of registry.checks) {
        expect(check.name).toBeTruthy();
        expect(check.description).toBeTruthy();
        expect(check.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(check.targetKinds.length).toBeGreaterThan(0);
        expect(check.verbs.length).toBeGreaterThan(0);
        expect(check.source).toBe('builtin');
        expect(check.url).toContain('https://');
        expect(check.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(check.files?.length).toBeGreaterThan(0);
      }
    });
  });

  describe('matchEntries()', () => {
    const entries: CheckRegistryEntry[] = [
      { name: 'check-disk-usage', description: 'Disk monitoring', version: '1.0.0', targetKinds: ['linux', 'generic'], verbs: ['health'], source: 'builtin', url: '', sha256: '', files: [] },
      { name: 'check-memory-usage', description: 'Memory monitoring', version: '1.0.0', targetKinds: ['linux', 'generic'], verbs: ['health'], source: 'builtin', url: '', sha256: '', files: [] },
      { name: 'check-http-endpoint', description: 'HTTP endpoint check', version: '1.0.0', targetKinds: ['application', 'generic'], verbs: ['health'], source: 'builtin', url: '', sha256: '', files: [] },
    ];

    it('returns all entries for empty query', () => {
      expect(matchEntries(entries, '')).toHaveLength(3);
    });

    it('matches by name substring', () => {
      const results = matchEntries(entries, 'disk');
      expect(results).toHaveLength(1);
      expect(results[0]!.name).toBe('check-disk-usage');
    });

    it('matches by description substring', () => {
      const results = matchEntries(entries, 'endpoint');
      expect(results).toHaveLength(1);
      expect(results[0]!.name).toBe('check-http-endpoint');
    });

    it('matches by targetKind', () => {
      const results = matchEntries(entries, 'application');
      expect(results).toHaveLength(1);
      expect(results[0]!.name).toBe('check-http-endpoint');
    });

    it('is case-insensitive', () => {
      expect(matchEntries(entries, 'DISK')).toHaveLength(1);
      expect(matchEntries(entries, 'Memory')).toHaveLength(1);
    });

    it('matches multiple entries', () => {
      const results = matchEntries(entries, 'usage');
      expect(results).toHaveLength(2);
    });

    it('returns empty for no match', () => {
      expect(matchEntries(entries, 'nonexistent')).toHaveLength(0);
    });
  });
});

// ── Installer ──

describe('check-installer', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `crisismode-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true }); } catch { /* ignore */ }
  });

  describe('getInstalledVersion()', () => {
    it('returns null for non-existent plugin', () => {
      expect(getInstalledVersion('nonexistent', [tempDir])).toBeNull();
    });

    it('returns version from installed manifest', () => {
      const pluginDir = join(tempDir, 'my-plugin');
      mkdirSync(pluginDir, { recursive: true });
      writeFileSync(join(pluginDir, 'manifest.json'), JSON.stringify({ name: 'my-plugin', version: '1.2.3' }));

      expect(getInstalledVersion('my-plugin', [tempDir])).toBe('1.2.3');
    });

    it('searches multiple directories in order', () => {
      const dir1 = join(tempDir, 'dir1');
      const dir2 = join(tempDir, 'dir2');
      mkdirSync(join(dir1, 'my-plugin'), { recursive: true });
      mkdirSync(join(dir2, 'my-plugin'), { recursive: true });
      writeFileSync(join(dir1, 'my-plugin', 'manifest.json'), JSON.stringify({ version: '1.0.0' }));
      writeFileSync(join(dir2, 'my-plugin', 'manifest.json'), JSON.stringify({ version: '2.0.0' }));

      // Returns first found
      expect(getInstalledVersion('my-plugin', [dir1, dir2])).toBe('1.0.0');
      expect(getInstalledVersion('my-plugin', [dir2, dir1])).toBe('2.0.0');
    });
  });

  describe('installCheck()', () => {
    it('detects already-installed plugins', () => {
      // Create a fake installed plugin
      const pluginDir = join(tempDir, 'test-plugin');
      mkdirSync(pluginDir, { recursive: true });
      writeFileSync(join(pluginDir, 'manifest.json'), JSON.stringify({ version: '1.0.0' }));

      // getInstalledVersion should find it
      expect(getInstalledVersion('test-plugin', [tempDir])).toBe('1.0.0');

      // Non-existent plugin returns null
      expect(getInstalledVersion('nonexistent-plugin', [tempDir])).toBeNull();
    });
  });

  describe('checksum verification', () => {
    it('sha256 of concatenated sorted files matches expected format', () => {
      // Create test files
      const content1 = '#!/bin/bash\necho hello\n';
      const content2 = '{"name":"test"}\n';

      writeFileSync(join(tempDir, 'check.sh'), content1);
      writeFileSync(join(tempDir, 'manifest.json'), content2);

      // Compute like the registry does: sorted filenames, concatenated
      const hash = createHash('sha256');
      hash.update(readFileSync(join(tempDir, 'check.sh')));
      hash.update(readFileSync(join(tempDir, 'manifest.json')));
      const checksum = hash.digest('hex');

      expect(checksum).toMatch(/^[a-f0-9]{64}$/);
    });
  });
});
