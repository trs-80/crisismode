// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify } from 'yaml';
import { loadConfig } from '../config/loader.js';
import { serviceTargetsFromConfig } from '../cli/service-targets.js';
import type { SiteConfig } from '../config/schema.js';

const validConfig: SiteConfig = {
  apiVersion: 'crisismode/v1',
  kind: 'SiteConfig',
  metadata: { name: 'test-site', environment: 'development' },
  targets: [
    {
      name: 'test-pg',
      kind: 'postgresql',
      primary: { host: 'pg.local', port: 5432, database: 'testdb' },
      credentials: { type: 'value', username: 'admin', password: 'secret' },
    },
  ],
};

function writeYamlConfig(dir: string, config: object): string {
  const filePath = join(dir, 'crisismode.yaml');
  writeFileSync(filePath, stringify(config), 'utf-8');
  return filePath;
}

describe('services config', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempName();
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function mkdtempName(): string {
    return join(tmpdir(), `crisismode-svc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  }

  describe('valid entries', () => {
    it('accepts a catalog id', () => {
      const filePath = writeYamlConfig(tmpDir, { ...validConfig, services: ['github'] });
      const result = loadConfig({ configPath: filePath });
      expect(result.config.services).toEqual(['github']);
    });

    it('accepts a catalog alias', () => {
      const filePath = writeYamlConfig(tmpDir, { ...validConfig, services: ['flyio'] });
      const result = loadConfig({ configPath: filePath });
      expect(result.config.services).toEqual(['flyio']);
    });

    it('accepts a raw domain', () => {
      const filePath = writeYamlConfig(tmpDir, { ...validConfig, services: ['example.com'] });
      const result = loadConfig({ configPath: filePath });
      expect(result.config.services).toEqual(['example.com']);
    });

    it('accepts the long form {host, port}', () => {
      const filePath = writeYamlConfig(tmpDir, {
        ...validConfig,
        services: [{ host: 'example.com', port: 8443 }],
      });
      const result = loadConfig({ configPath: filePath });
      expect(result.config.services).toEqual([{ host: 'example.com', port: 8443 }]);
    });
  });

  describe('invalid entries', () => {
    it('rejects a URL with a scheme', () => {
      const filePath = writeYamlConfig(tmpDir, { ...validConfig, services: ['https://stripe.com'] });
      expect(() => loadConfig({ configPath: filePath })).toThrow(/github/);
    });

    it('rejects a value with a path', () => {
      const filePath = writeYamlConfig(tmpDir, { ...validConfig, services: ['foo/bar'] });
      expect(() => loadConfig({ configPath: filePath })).toThrow(/github/);
    });

    it('rejects a value with a space', () => {
      const filePath = writeYamlConfig(tmpDir, { ...validConfig, services: ['has space'] });
      expect(() => loadConfig({ configPath: filePath })).toThrow(/github/);
    });

    it('rejects long form with port 0', () => {
      const filePath = writeYamlConfig(tmpDir, {
        ...validConfig,
        services: [{ host: 'x', port: 0 }],
      });
      expect(() => loadConfig({ configPath: filePath })).toThrow(/github/);
    });

    it('rejects long form missing host', () => {
      const filePath = writeYamlConfig(tmpDir, {
        ...validConfig,
        services: [{ port: 443 }],
      });
      expect(() => loadConfig({ configPath: filePath })).toThrow(/github/);
    });

    it('error message lists at least three valid catalog ids', () => {
      const filePath = writeYamlConfig(tmpDir, { ...validConfig, services: ['https://stripe.com'] });
      let message = '';
      try {
        loadConfig({ configPath: filePath });
      } catch (err) {
        message = (err as Error).message;
      }
      const ids = ['github', 'stripe', 'vercel', 'netlify', 'supabase'];
      const matchCount = ids.filter((id) => message.includes(id)).length;
      expect(matchCount).toBeGreaterThanOrEqual(3);
    });
  });

  describe('targets/services relaxation', () => {
    it('loads a services-only config with no targets', () => {
      const filePath = writeYamlConfig(tmpDir, {
        apiVersion: 'crisismode/v1',
        kind: 'SiteConfig',
        metadata: { name: 'test-site', environment: 'development' },
        services: ['github'],
      });
      const result = loadConfig({ configPath: filePath });
      expect(result.config.services).toEqual(['github']);
    });

    it('normalizes targets to [] on a services-only config (not undefined)', () => {
      const filePath = writeYamlConfig(tmpDir, {
        apiVersion: 'crisismode/v1',
        kind: 'SiteConfig',
        metadata: { name: 'test-site', environment: 'development' },
        services: ['github'],
      });
      const result = loadConfig({ configPath: filePath });
      expect(result.config.targets).toEqual([]);
    });

    it('errors when neither targets nor services are declared, naming both keys', () => {
      const filePath = writeYamlConfig(tmpDir, {
        apiVersion: 'crisismode/v1',
        kind: 'SiteConfig',
        metadata: { name: 'test-site', environment: 'development' },
      });
      expect(() => loadConfig({ configPath: filePath })).toThrow(/targets/);
      expect(() => loadConfig({ configPath: filePath })).toThrow(/services/);
    });
  });

  describe('targets/services name collision', () => {
    /**
     * serviceTargetsFromConfig (src/cli/service-targets.ts) synthesizes each
     * services: entry into a target named after its resolved id.
     * AgentRegistry.createForTarget resolves by name and returns the FIRST
     * match — an uncaught collision means the other target's agent silently
     * runs under the service-status label. Reviewer repro shape from the
     * Task 6 review (task-6-review.md Finding 1): a `redis`-kind target
     * named "github" plus a `services: [github]` entry.
     */
    it('rejects a services entry whose resolved id collides with a targets[] name, naming both entries', () => {
      const filePath = writeYamlConfig(tmpDir, {
        apiVersion: 'crisismode/v1',
        kind: 'SiteConfig',
        metadata: { name: 'test-site', environment: 'development' },
        targets: [
          { name: 'github', kind: 'redis', primary: { host: 'localhost', port: 6379 } },
        ],
        services: ['github'],
      });
      expect(() => loadConfig({ configPath: filePath })).toThrow(/github/);
      expect(() => loadConfig({ configPath: filePath })).toThrow(/redis/);
      expect(() => loadConfig({ configPath: filePath })).toThrow(/collides/);
    });

    it('rejects a services alias whose resolved canonical id collides with a targets[] name', () => {
      const filePath = writeYamlConfig(tmpDir, {
        apiVersion: 'crisismode/v1',
        kind: 'SiteConfig',
        metadata: { name: 'test-site', environment: 'development' },
        targets: [
          { name: 'fly', kind: 'kubernetes', primary: { host: 'localhost', port: 6443 } },
        ],
        // 'flyio' resolves to the canonical catalog id 'fly' — the collision
        // must be caught on the resolved id, not the raw string.
        services: ['flyio'],
      });
      expect(() => loadConfig({ configPath: filePath })).toThrow(/fly/);
      expect(() => loadConfig({ configPath: filePath })).toThrow(/collides/);
    });

    it('rejects a services {host, port} entry whose host collides with a targets[] name', () => {
      const filePath = writeYamlConfig(tmpDir, {
        apiVersion: 'crisismode/v1',
        kind: 'SiteConfig',
        metadata: { name: 'test-site', environment: 'development' },
        targets: [
          { name: 'api.myvendor.example', kind: 'dns', primary: { host: 'localhost', port: 53 } },
        ],
        services: [{ host: 'api.myvendor.example' }],
      });
      expect(() => loadConfig({ configPath: filePath })).toThrow(/collides/);
    });

    it('does not throw and yields both a non-colliding target and a service entry (integration-shaped)', () => {
      const filePath = writeYamlConfig(tmpDir, {
        apiVersion: 'crisismode/v1',
        kind: 'SiteConfig',
        metadata: { name: 'test-site', environment: 'development' },
        targets: [
          { name: 'my-redis', kind: 'redis', primary: { host: 'localhost', port: 6379 } },
        ],
        services: ['github'],
      });

      const result = loadConfig({ configPath: filePath });

      expect(result.config.targets).toEqual([
        { name: 'my-redis', kind: 'redis', primary: { host: 'localhost', port: 6379 } },
      ]);
      expect(result.config.services).toEqual(['github']);

      // End-to-end through the actual synthesis path scan/watch use: the
      // loaded config, unmodified, still produces a service-status target
      // alongside the declared redis target once merged.
      const serviceTargets = serviceTargetsFromConfig(result.config);
      expect(serviceTargets).toEqual([
        { name: 'github', kind: 'service-status', primary: { host: 'api.github.com', port: 443 } },
      ]);
      const merged = [...result.config.targets, ...serviceTargets];
      expect(merged.map((t) => t.name)).toEqual(['my-redis', 'github']);
    });
  });
});
