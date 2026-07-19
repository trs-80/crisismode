// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify } from 'yaml';
import { loadConfig } from '../config/loader.js';
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

describe('network config block', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempName();
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function mkdtempName(): string {
    return join(tmpdir(), `crisismode-net-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  }

  it('parses network.egressMbps when present', () => {
    const filePath = writeYamlConfig(tmpDir, { ...validConfig, network: { egressMbps: 30 } });
    const result = loadConfig({ configPath: filePath });
    expect(result.config.network?.egressMbps).toBe(30);
  });

  it('absent network block yields undefined (not an error)', () => {
    const filePath = writeYamlConfig(tmpDir, validConfig);
    const result = loadConfig({ configPath: filePath });
    expect(result.config.network).toBeUndefined();
  });

  it('rejects non-positive egressMbps', () => {
    const filePath = writeYamlConfig(tmpDir, { ...validConfig, network: { egressMbps: -5 } });
    expect(() => loadConfig({ configPath: filePath })).toThrow(/network\.egressMbps/);
  });

  it('rejects non-numeric egressMbps', () => {
    const filePath = writeYamlConfig(tmpDir, { ...validConfig, network: { egressMbps: 'fast' } });
    expect(() => loadConfig({ configPath: filePath })).toThrow(/network\.egressMbps/);
  });

  it('rejects a null network block (key present, no value)', () => {
    const filePath = writeYamlConfig(tmpDir, { ...validConfig, network: null });
    expect(() => loadConfig({ configPath: filePath })).toThrow(/network/);
  });

  it('rejects a non-mapping network value', () => {
    const filePath = writeYamlConfig(tmpDir, { ...validConfig, network: 5 });
    expect(() => loadConfig({ configPath: filePath })).toThrow(/network/);
  });

  it('rejects egressMbps: 0 (boundary)', () => {
    const filePath = writeYamlConfig(tmpDir, { ...validConfig, network: { egressMbps: 0 } });
    expect(() => loadConfig({ configPath: filePath })).toThrow(/network\.egressMbps/);
  });
});
