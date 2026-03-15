// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, parseCliFlags } from '../config/loader.js';
import { resolveCredentials } from '../config/credentials.js';
import { resolveTargets } from '../config/resolve.js';
import { AgentRegistry } from '../config/agent-registry.js';
import { generateTemplate } from '../config/init.js';
import type { SiteConfig } from '../config/schema.js';

// ── Fixtures ──

const validConfig: SiteConfig = {
  apiVersion: 'crisismode/v1',
  kind: 'SiteConfig',
  metadata: { name: 'test-site', environment: 'development' },
  webhook: { port: 3000 },
  execution: { mode: 'dry-run' },
  targets: [
    {
      name: 'test-pg',
      kind: 'postgresql',
      primary: { host: 'pg.local', port: 5432, database: 'testdb' },
      replicas: [{ host: 'pg-replica.local', port: 5432 }],
      credentials: { type: 'value', username: 'admin', password: 'secret' },
    },
    {
      name: 'test-redis',
      kind: 'redis',
      primary: { host: 'redis.local', port: 6379 },
      credentials: { type: 'value', password: 'redis-secret' },
    },
  ],
};

function writeYamlConfig(dir: string, config: object): string {
  const { stringify } = require('yaml') as { stringify: (v: unknown) => string };
  const filePath = join(dir, 'crisismode.yaml');
  writeFileSync(filePath, stringify(config), 'utf-8');
  return filePath;
}

// ── Tests ──

describe('Config loader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `crisismode-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('loads a valid YAML config from explicit path', () => {
    const filePath = writeYamlConfig(tmpDir, validConfig);
    const result = loadConfig({ configPath: filePath });

    expect(result.source).toBe('file');
    expect(result.config.apiVersion).toBe('crisismode/v1');
    expect(result.config.targets).toHaveLength(2);
    expect(result.config.targets[0].name).toBe('test-pg');
  });

  it('rejects config with wrong apiVersion', () => {
    const filePath = writeYamlConfig(tmpDir, { ...validConfig, apiVersion: 'wrong/v2' });
    expect(() => loadConfig({ configPath: filePath })).toThrow('Unsupported apiVersion');
  });

  it('rejects config with no targets', () => {
    const filePath = writeYamlConfig(tmpDir, { ...validConfig, targets: [] });
    expect(() => loadConfig({ configPath: filePath })).toThrow('at least one target');
  });

  it('rejects config with invalid target (missing host)', () => {
    const bad = {
      ...validConfig,
      targets: [{ name: 'bad', kind: 'postgresql', primary: { port: 5432 } }],
    };
    const filePath = writeYamlConfig(tmpDir, bad);
    expect(() => loadConfig({ configPath: filePath })).toThrow('host');
  });

  it('throws if explicit config path does not exist', () => {
    expect(() => loadConfig({ configPath: '/nonexistent/crisismode.yaml' })).toThrow('not found');
  });

  it('falls back to legacy env vars when no config file exists', () => {
    vi.stubEnv('PG_HOST', '10.0.0.1');
    vi.stubEnv('PG_PORT', '5555');
    vi.stubEnv('PG_USER', 'myuser');
    vi.stubEnv('PG_PASSWORD', 'mypass');
    vi.stubEnv('PG_DATABASE', 'mydb');

    // Ensure no crisismode.yaml in CWD by changing to tmpDir
    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const result = loadConfig();
      expect(result.source).toBe('env-fallback');
      expect(result.config.targets[0].kind).toBe('postgresql');
      const pg = result.config.targets[0] as { primary: { host: string; port: number } };
      expect(pg.primary.host).toBe('10.0.0.1');
      expect(pg.primary.port).toBe(5555);
    } finally {
      process.chdir(origCwd);
    }
  });
});

describe('Credential resolution', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns empty for undefined ref', () => {
    expect(resolveCredentials(undefined)).toEqual({});
  });

  it('resolves env credential ref', () => {
    vi.stubEnv('MY_USER', 'alice');
    vi.stubEnv('MY_PASS', 'hunter2');

    const result = resolveCredentials({ type: 'env', username: 'MY_USER', password: 'MY_PASS' });
    expect(result.username).toBe('alice');
    expect(result.password).toBe('hunter2');
  });

  it('resolves value credential ref', () => {
    const result = resolveCredentials({ type: 'value', username: 'bob', password: 'pass123' });
    expect(result.username).toBe('bob');
    expect(result.password).toBe('pass123');
  });

  it('resolves env key credential ref (token)', () => {
    vi.stubEnv('MY_TOKEN', 'tok-abc');
    const result = resolveCredentials({ type: 'env', key: 'MY_TOKEN' });
    expect(result.token).toBe('tok-abc');
  });
});

describe('Target resolution', () => {
  it('resolves all targets from config', () => {
    const resolved = resolveTargets(validConfig);
    expect(resolved).toHaveLength(2);
    expect(resolved[0].name).toBe('test-pg');
    expect(resolved[0].kind).toBe('postgresql');
    expect(resolved[0].credentials.username).toBe('admin');
    expect(resolved[1].name).toBe('test-redis');
    expect(resolved[1].replicas).toEqual([]);
  });
});

describe('Agent registry', () => {
  it('creates an agent for a named target', async () => {
    const registry = new AgentRegistry(validConfig);
    const instance = await registry.createForTarget('test-pg');

    expect(instance.agent.manifest.metadata.name).toBe('postgresql-replication-recovery');
    expect(instance.target.name).toBe('test-pg');
  });

  it('creates the first agent when only one target exists', async () => {
    const singleTarget: SiteConfig = {
      ...validConfig,
      targets: [validConfig.targets[0]],
    };
    const registry = new AgentRegistry(singleTarget);
    const instance = await registry.createFirst();
    expect(instance.target.name).toBe('test-pg');
  });

  it('throws for unknown target name', async () => {
    const registry = new AgentRegistry(validConfig);
    await expect(registry.createForTarget('nonexistent')).rejects.toThrow('not found');
  });

  it('dispatches a PG replication alert to the PG agent', async () => {
    const registry = new AgentRegistry(validConfig);
    const instance = await registry.dispatchAlert({
      alertname: 'PostgresReplicationLagCritical',
      instance: 'pg.local:5432',
      severity: 'critical',
    });

    expect(instance).toBeDefined();
    expect(instance!.agent.manifest.metadata.name).toBe('postgresql-replication-recovery');
  });

  it('dispatches a Redis alert to the Redis agent', async () => {
    const registry = new AgentRegistry(validConfig);
    const instance = await registry.dispatchAlert({
      alertname: 'RedisMemoryPressureCritical',
      severity: 'critical',
    });

    expect(instance).toBeDefined();
    expect(instance!.agent.manifest.metadata.name).toBe('redis-memory-recovery');
  });

  it('returns undefined for unrecognized alerts', async () => {
    const registry = new AgentRegistry(validConfig);
    const instance = await registry.dispatchAlert({
      alertname: 'SomethingUnknown',
      severity: 'critical',
    });

    expect(instance).toBeUndefined();
  });

  it('lists supported kinds', () => {
    const registry = new AgentRegistry(validConfig);
    expect(registry.supportedKinds()).toContain('postgresql');
    expect(registry.supportedKinds()).toContain('redis');
  });

  it('lists registered agent names', () => {
    const registry = new AgentRegistry(validConfig);
    expect(registry.registeredAgents()).toContain('postgresql-replication-recovery');
    expect(registry.registeredAgents()).toContain('redis-memory-recovery');
  });

  it('accepts custom registrations', async () => {
    const { pgReplicationManifest } = await import('../agent/pg-replication/manifest.js');
    const customReg = {
      kind: 'postgresql',
      name: 'pg-vacuum-recovery',
      manifest: { ...pgReplicationManifest, metadata: { ...pgReplicationManifest.metadata, name: 'pg-vacuum-recovery' } },
      async createAgent(target: import('../config/schema.js').ResolvedTarget) {
        // Dummy — just reuse PG agent for the test
        const { PgReplicationAgent } = await import('../agent/pg-replication/agent.js');
        const { PgSimulator } = await import('../agent/pg-replication/simulator.js');
        const backend = new PgSimulator();
        const agent = new PgReplicationAgent(backend);
        return { agent, backend, target };
      },
    };

    const registry = new AgentRegistry(validConfig, [customReg]);
    expect(registry.registeredAgents()).toContain('pg-vacuum-recovery');
  });

  it('uses target.agent to pin a specific agent', async () => {
    const configWithPin: SiteConfig = {
      ...validConfig,
      targets: [
        { ...validConfig.targets[0], agent: 'postgresql-replication-recovery' },
      ],
    };
    const registry = new AgentRegistry(configWithPin);
    const instance = await registry.createFirst();
    expect(instance.agent.manifest.metadata.name).toBe('postgresql-replication-recovery');
  });
});

describe('CLI flag parsing', () => {
  it('parses --config and --target', () => {
    const flags = parseCliFlags(['--config', '/path/to/config.yaml', '--target', 'my-pg']);
    expect(flags.configPath).toBe('/path/to/config.yaml');
    expect(flags.targetName).toBe('my-pg');
  });

  it('returns undefined when flags not present', () => {
    const flags = parseCliFlags(['--execute', '--health-only']);
    expect(flags.configPath).toBeUndefined();
    expect(flags.targetName).toBeUndefined();
  });
});

describe('Init template', () => {
  it('generates valid YAML template', () => {
    const template = generateTemplate();
    expect(template).toContain('apiVersion: crisismode/v1');
    expect(template).toContain('kind: SiteConfig');
    expect(template).toContain('kind: postgresql');
    expect(template).toContain('targets:');
  });
});
