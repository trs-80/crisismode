// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnvExampleKeys, findEnvExample, buildPresenceExpectations } from '../agent/config-drift/env-example.js';
import { ConfigDriftLiveClient } from '../agent/config-drift/live-client.js';

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length) await rm(cleanups.pop()!, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'crisismode-envex-'));
  cleanups.push(dir);
  return dir;
}

describe('parseEnvExampleKeys', () => {
  it('extracts keys, skipping comments, blanks, export prefixes, and quoted values', () => {
    const content = [
      '# Database',
      'DATABASE_URL=postgres://localhost/app',
      '',
      'export REDIS_URL="redis://localhost:6379"',
      '  API_KEY = secret',
      '# COMMENTED_OUT=1',
      'not a key line',
      '1BAD=nope',
    ].join('\n');
    expect(parseEnvExampleKeys(content)).toEqual(['DATABASE_URL', 'REDIS_URL', 'API_KEY']);
  });
});

describe('findEnvExample', () => {
  it('finds .env.example, preferring it over .env.template', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, '.env.example'), 'A=1\n');
    await writeFile(join(dir, '.env.template'), 'B=2\n');
    expect(await findEnvExample(dir)).toBe(join(dir, '.env.example'));
  });

  it('returns null when neither file exists', async () => {
    expect(await findEnvExample(await tempDir())).toBeNull();
  });

  it('honors an explicit path', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'custom.env'), 'A=1\n');
    expect(await findEnvExample(dir, join(dir, 'custom.env'))).toBe(join(dir, 'custom.env'));
  });
});

describe('presence-only expectations', () => {
  it('builds presence expectations that never carry values', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, '.env.example'), 'PRESENT_VAR=x\nMISSING_VAR=y\n');
    const expectations = await buildPresenceExpectations(dir);
    expect(expectations).toEqual([
      { path: 'PRESENT_VAR', expected: null, source: 'env', masked: true, presence: true },
      { path: 'MISSING_VAR', expected: null, source: 'env', masked: true, presence: true },
    ]);
  });

  it('reports presence drift without exposing values', async () => {
    process.env.CRISISMODE_TEST_PRESENT = 'super-secret-value';
    delete process.env.CRISISMODE_TEST_MISSING;
    try {
      const client = new ConfigDriftLiveClient({
        expectations: [
          { path: 'CRISISMODE_TEST_PRESENT', expected: null, source: 'env', masked: true, presence: true },
          { path: 'CRISISMODE_TEST_MISSING', expected: null, source: 'env', masked: true, presence: true },
        ],
      });
      const vars = await client.getEnvironmentVars();
      const present = vars.find((v) => v.name === 'CRISISMODE_TEST_PRESENT')!;
      const missing = vars.find((v) => v.name === 'CRISISMODE_TEST_MISSING')!;
      expect(present.expected).toBe(present.actual);        // no drift
      expect(missing.actual).toBeNull();                    // drift: expected set, actually missing
      expect(missing.expected).not.toBeNull();
      expect(JSON.stringify(vars)).not.toContain('super-secret-value');
    } finally {
      delete process.env.CRISISMODE_TEST_PRESENT;
    }
  });
});
