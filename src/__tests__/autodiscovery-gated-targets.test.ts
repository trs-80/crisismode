// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveGatedTargets } from '../cli/autodiscovery.js';
import type { AppStackInfo } from '../cli/autodiscovery.js';

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length) await rm(cleanups.pop()!, { recursive: true, force: true });
});

async function emptyDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'crisismode-gated-'));
  cleanups.push(dir);
  return dir;
}

function stack(deps: string[]): AppStackInfo {
  return { framework: null, language: 'typescript', hasDockerfile: false, hasCIConfig: false, dependencies: deps };
}

describe('deriveGatedTargets', () => {
  it('derives managed-database only with both DATABASE_URL and a migration tool', async () => {
    const dir = await emptyDir();
    const env = { DATABASE_URL: 'postgres://app:pw@db.internal:5433/appdb' } as NodeJS.ProcessEnv;

    const gated = await deriveGatedTargets(stack(['@prisma/client']), dir, env);
    const dbTarget = gated.targets.find((t) => t.kind === 'managed-database');
    expect(dbTarget?.primary).toEqual({ host: 'db.internal', port: 5433, database: 'appdb' });
    expect(gated.notes[dbTarget!.name]).toContain('DATABASE_URL');

    const ungated = await deriveGatedTargets(stack([]), dir, env);
    expect(ungated.targets.find((t) => t.kind === 'managed-database')).toBeUndefined();
  });

  it('derives message-queue only with both REDIS_URL and bullmq, carrying tls for rediss', async () => {
    const dir = await emptyDir();
    const env = { REDIS_TLS_URL: 'rediss://:pw@cache.internal:6380' } as NodeJS.ProcessEnv;

    const gated = await deriveGatedTargets(stack(['bullmq']), dir, env);
    const q = gated.targets.find((t) => t.kind === 'message-queue');
    expect(q?.primary?.host).toBe('cache.internal');
    expect(q?.queue?.tls).toBe(true);

    const ungated = await deriveGatedTargets(stack([]), dir, env);
    expect(ungated.targets.find((t) => t.kind === 'message-queue')).toBeUndefined();
  });

  it('derives ai-provider from an API key even without SDK deps', async () => {
    const dir = await emptyDir();
    const gated = await deriveGatedTargets(stack([]), dir, { ANTHROPIC_API_KEY: 'k' } as NodeJS.ProcessEnv);
    const ai = gated.targets.find((t) => t.kind === 'ai-provider');
    expect(ai?.primary?.host).toBe('auto');
  });

  it('derives ai-provider from an SDK dep even without keys', async () => {
    const dir = await emptyDir();
    const gated = await deriveGatedTargets(stack(['@anthropic-ai/sdk']), dir, {} as NodeJS.ProcessEnv);
    expect(gated.targets.find((t) => t.kind === 'ai-provider')).toBeDefined();
  });

  it('derives application-config only when an env template exists', async () => {
    const dir = await emptyDir();
    const without = await deriveGatedTargets(stack([]), dir, {} as NodeJS.ProcessEnv);
    expect(without.targets.find((t) => t.kind === 'application-config')).toBeUndefined();

    await writeFile(join(dir, '.env.example'), 'DATABASE_URL=\n');
    const withFile = await deriveGatedTargets(stack([]), dir, {} as NodeJS.ProcessEnv);
    expect(withFile.targets.find((t) => t.kind === 'application-config')).toBeDefined();
  });

  it('never leaks connection-string values into names or notes', async () => {
    const dir = await emptyDir();
    const env = { DATABASE_URL: 'postgres://app:supersecret@db:5432/appdb' } as NodeJS.ProcessEnv;
    const gated = await deriveGatedTargets(stack(['drizzle-orm']), dir, env);
    const serialized = JSON.stringify({ names: gated.targets.map((t) => t.name), notes: gated.notes });
    expect(serialized).not.toContain('supersecret');
  });
});
