// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect } from 'vitest';
import {
  VECTOR_STORE_ENV_VARS, buildVectorStoreConnections,
} from '../agent/vector-store/provider-table.js';
import { VECTOR_STORE_CHECK_IDS } from '../agent/vector-store/check-ids.js';

describe('VECTOR_STORE_CHECK_IDS', () => {
  it('is a keyed object of the exact contract strings (PR 5 reads Object.values)', () => {
    expect(VECTOR_STORE_CHECK_IDS).toEqual({
      reachable: 'vector-store.reachable',
      authValid: 'vector-store.auth_valid',
      indexStatus: 'vector-store.index_status',
    });
  });

  it('is re-exported from backend.ts so consumers need only one import', async () => {
    const backend = await import('../agent/vector-store/backend.js');
    expect(backend.VECTOR_STORE_CHECK_IDS).toBe(VECTOR_STORE_CHECK_IDS);
  });
});

describe('VECTOR_STORE_ENV_VARS', () => {
  it('lists every credential env var the agent knows about', () => {
    expect(VECTOR_STORE_ENV_VARS.map((v) => v.envVar).sort()).toEqual([
      'PINECONE_API_KEY', 'UPSTASH_VECTOR_REST_TOKEN', 'UPSTASH_VECTOR_REST_URL',
    ]);
  });
});

describe('buildVectorStoreConnections', () => {
  it('builds a pinecone connection from the api key alone', () => {
    const conns = buildVectorStoreConnections({ PINECONE_API_KEY: 'pc-secret-1234' });
    expect(conns).toEqual([
      { provider: 'pinecone', baseUrl: 'https://api.pinecone.io', apiKey: 'pc-secret-1234' },
    ]);
  });

  it('builds an upstash connection from url + token', () => {
    const conns = buildVectorStoreConnections({
      UPSTASH_VECTOR_REST_URL: 'https://example-vector.upstash.io',
      UPSTASH_VECTOR_REST_TOKEN: 'up-secret-5678',
    });
    expect(conns).toEqual([
      { provider: 'upstash-vector', baseUrl: 'https://example-vector.upstash.io', apiKey: 'up-secret-5678' },
    ]);
  });

  it('strips a trailing slash from the upstash url', () => {
    const conns = buildVectorStoreConnections({
      UPSTASH_VECTOR_REST_URL: 'https://example-vector.upstash.io/',
      UPSTASH_VECTOR_REST_TOKEN: 'up-secret-5678',
    });
    expect(conns[0]?.baseUrl).toBe('https://example-vector.upstash.io');
  });

  it('skips upstash when only the token is set (never probe a guessed url)', () => {
    expect(buildVectorStoreConnections({ UPSTASH_VECTOR_REST_TOKEN: 'up-secret' })).toEqual([]);
  });

  it('skips upstash when only the url is set', () => {
    expect(buildVectorStoreConnections({ UPSTASH_VECTOR_REST_URL: 'https://x.upstash.io' })).toEqual([]);
  });

  it('returns an empty list with no credentials at all', () => {
    expect(buildVectorStoreConnections({})).toEqual([]);
  });

  it('builds both providers when both are configured', () => {
    const conns = buildVectorStoreConnections({
      PINECONE_API_KEY: 'pc',
      UPSTASH_VECTOR_REST_URL: 'https://x.upstash.io',
      UPSTASH_VECTOR_REST_TOKEN: 'up',
    });
    expect(conns.map((c) => c.provider)).toEqual(['pinecone', 'upstash-vector']);
  });
});
