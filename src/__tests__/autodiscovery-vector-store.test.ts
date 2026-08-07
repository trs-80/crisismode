// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect } from 'vitest';
import { deriveGatedTargets } from '../cli/autodiscovery.js';
import type { AppStackInfo } from '../cli/autodiscovery.js';

const EMPTY_STACK = { framework: null, dependencies: [] } as unknown as AppStackInfo;

/** cwd is a directory with no .env.example, so unrelated derivations stay quiet. */
const CWD = '/nonexistent-crisismode-test-dir';

describe('deriveGatedTargets — vector-store', () => {
  it('derives a vector-store target from PINECONE_API_KEY', async () => {
    const { targets, notes } = await deriveGatedTargets(EMPTY_STACK, CWD, { PINECONE_API_KEY: 'pc-secret' });
    const target = targets.find((t) => t.kind === 'vector-store');
    expect(target?.name).toBe('derived-vector-store');
    expect(target?.primary).toEqual({ host: 'auto', port: 0 });
    expect(notes['derived-vector-store']).toBe('from PINECONE_API_KEY');
  });

  it('derives from the upstash env vars too', async () => {
    const { notes } = await deriveGatedTargets(EMPTY_STACK, CWD, {
      UPSTASH_VECTOR_REST_URL: 'https://x.upstash.io',
      UPSTASH_VECTOR_REST_TOKEN: 'up-secret',
    });
    expect(notes['derived-vector-store']).toContain('UPSTASH_VECTOR_REST');
  });

  it('the note names the env var but never its value', async () => {
    const { notes } = await deriveGatedTargets(EMPTY_STACK, CWD, { PINECONE_API_KEY: 'pc-supersecret' });
    expect(JSON.stringify(notes)).not.toContain('pc-supersecret');
  });

  it('derives nothing with no vector-store credentials', async () => {
    const { targets } = await deriveGatedTargets(EMPTY_STACK, CWD, {});
    expect(targets.find((t) => t.kind === 'vector-store')).toBeUndefined();
  });

  it('derives exactly one target even when both providers are configured', async () => {
    const { targets } = await deriveGatedTargets(EMPTY_STACK, CWD, {
      PINECONE_API_KEY: 'pc-secret',
      UPSTASH_VECTOR_REST_URL: 'https://x.upstash.io',
      UPSTASH_VECTOR_REST_TOKEN: 'up-secret',
    });
    expect(targets.filter((t) => t.kind === 'vector-store')).toHaveLength(1);
  });

  it('derives nothing from a token-only upstash configuration (URL missing)', async () => {
    // buildVectorStoreConnections rejects a half-configured Upstash provider;
    // autodiscovery must agree, or registration.ts throws on a target that
    // was never actually connectable.
    const { targets } = await deriveGatedTargets(EMPTY_STACK, CWD, {
      UPSTASH_VECTOR_REST_TOKEN: 'up-secret',
    });
    expect(targets.find((t) => t.kind === 'vector-store')).toBeUndefined();
  });

  it('derives nothing from a URL-only upstash configuration (token missing)', async () => {
    const { targets } = await deriveGatedTargets(EMPTY_STACK, CWD, {
      UPSTASH_VECTOR_REST_URL: 'https://x.upstash.io',
    });
    expect(targets.find((t) => t.kind === 'vector-store')).toBeUndefined();
  });
});
