// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect, vi, afterEach } from 'vitest';
import { VectorStoreLiveClient, DEFAULT_TIMEOUT_MS } from '../agent/vector-store/live-client.js';
import { VECTOR_STORE_CHECK_IDS } from '../agent/vector-store/check-ids.js';
import type { VectorStoreConnection } from '../agent/vector-store/provider-table.js';

const PINECONE: VectorStoreConnection = {
  provider: 'pinecone', baseUrl: 'https://api.pinecone.io', apiKey: 'pcsk-supersecret-9876',
};
const UPSTASH: VectorStoreConnection = {
  provider: 'upstash-vector', baseUrl: 'https://demo-vector.upstash.io', apiKey: 'up-supersecret-5432',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
}

function client(connections: VectorStoreConnection[]) {
  return new VectorStoreLiveClient({ connections });
}

const statusOf = (
  report: { checks: Array<{ checkId: string; status: string }> }, checkId: string,
): string | undefined => report.checks.find((c) => c.checkId === checkId)?.status;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('VectorStoreLiveClient — pinecone', () => {
  it('lists indexes from the control plane with the Api-Key header', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      indexes: [{ name: 'documents', dimension: 1536, host: 'documents-abc.svc.pinecone.io', status: { ready: true, state: 'Ready' } }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const [report] = await client([PINECONE]).queryVectorStores();

    const firstCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(firstCall[0]).toBe('https://api.pinecone.io/indexes');
    expect((firstCall[1].headers as Record<string, string>)['Api-Key']).toBe('pcsk-supersecret-9876');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.reachable)).toBe('pass');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.authValid)).toBe('pass');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.indexStatus)).toBe('pass');
    expect(report!.indexes[0]).toMatchObject({ name: 'documents', ready: true, dimension: 1536 });
  });

  it('classifies HTTP 401 as reachable-but-unauthenticated', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401)));
    const [report] = await client([PINECONE]).queryVectorStores();
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.reachable)).toBe('pass');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.authValid)).toBe('fail');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.indexStatus)).toBe('unknown');
  });

  it('classifies HTTP 403 as an auth failure too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'forbidden' }, 403)));
    const [report] = await client([PINECONE]).queryVectorStores();
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.authValid)).toBe('fail');
  });

  it('classifies HTTP 503 as reachable with honest unknowns, not an auth failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 503)));
    const [report] = await client([PINECONE]).queryVectorStores();
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.reachable)).toBe('pass');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.authValid)).toBe('unknown');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.indexStatus)).toBe('unknown');
  });

  it('classifies a network error as unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const [report] = await client([PINECONE]).queryVectorStores();
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.reachable)).toBe('fail');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.authValid)).toBe('unknown');
  });

  it('reports an index that is not ready as a failing index_status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      indexes: [{ name: 'documents', dimension: 1536, status: { ready: false, state: 'Initializing' } }],
    })));
    const [report] = await client([PINECONE]).queryVectorStores();
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.indexStatus)).toBe('fail');
    expect(report!.indexes[0]?.ready).toBe(false);
  });

  it('reports an empty account as a failing index_status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ indexes: [] })));
    const [report] = await client([PINECONE]).queryVectorStores();
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.indexStatus)).toBe('fail');
    expect(report!.indexes).toEqual([]);
  });

  it('leaves recordCount null when the data-plane stats call fails', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('describe_index_stats')) throw new TypeError('fetch failed');
      return jsonResponse({
        indexes: [{ name: 'documents', dimension: 1536, host: 'documents-abc.svc.pinecone.io', status: { ready: true, state: 'Ready' } }],
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const [report] = await client([PINECONE]).queryVectorStores();
    expect(report!.indexes[0]?.recordCount).toBeNull();
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.indexStatus)).toBe('pass');
  });

  it('reads recordCount from the data plane when available', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('describe_index_stats')) return jsonResponse({ totalVectorCount: 42_000 });
      return jsonResponse({
        indexes: [{ name: 'documents', dimension: 1536, host: 'documents-abc.svc.pinecone.io', status: { ready: true, state: 'Ready' } }],
      });
    }));
    const [report] = await client([PINECONE]).queryVectorStores();
    expect(report!.indexes[0]?.recordCount).toBe(42_000);
  });
});

describe('VectorStoreLiveClient — upstash-vector', () => {
  it('reads /info with a bearer token', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      result: { vectorCount: 1_200, pendingVectorCount: 0, dimension: 384, similarityFunction: 'COSINE' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const [report] = await client([UPSTASH]).queryVectorStores();

    const firstCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(firstCall[0]).toBe('https://demo-vector.upstash.io/info');
    expect((firstCall[1].headers as Record<string, string>)['Authorization'])
      .toBe('Bearer up-supersecret-5432');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.indexStatus)).toBe('pass');
    expect(report!.indexes[0]).toEqual({
      name: 'demo-vector.upstash.io', ready: true, dimension: 384, recordCount: 1_200,
    });
  });

  it('classifies a rejected token as an auth failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401)));
    const [report] = await client([UPSTASH]).queryVectorStores();
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.authValid)).toBe('fail');
  });
});

describe('VectorStoreLiveClient — degradation contract', () => {
  it('one provider failing never suppresses the other', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('https://api.pinecone.io')) throw new TypeError('fetch failed');
      return jsonResponse({ result: { vectorCount: 5, pendingVectorCount: 0, dimension: 384 } });
    }));
    const reports = await client([PINECONE, UPSTASH]).queryVectorStores();
    expect(reports).toHaveLength(2);
    expect(statusOf(reports[0]!, VECTOR_STORE_CHECK_IDS.reachable)).toBe('fail');
    expect(statusOf(reports[1]!, VECTOR_STORE_CHECK_IDS.reachable)).toBe('pass');
  });

  it('returns an empty report list when no provider is configured', async () => {
    expect(await client([]).queryVectorStores()).toEqual([]);
  });

  it('degrades a malformed pinecone body to unknown, not a false "no indexes" fail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ notIndexes: 'unexpected shape' })));
    const [report] = await client([PINECONE]).queryVectorStores();
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.reachable)).toBe('pass');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.authValid)).toBe('pass');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.indexStatus)).toBe('unknown');
  });

  it('degrades an unparseable pinecone body to unknown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })));
    const [report] = await client([PINECONE]).queryVectorStores();
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.indexStatus)).toBe('unknown');
  });

  it('degrades a missing upstash result field to unknown, not a false "ready" pass', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({})));
    const [report] = await client([UPSTASH]).queryVectorStores();
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.reachable)).toBe('pass');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.authValid)).toBe('pass');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.indexStatus)).toBe('unknown');
    expect(report!.indexes).toEqual([]);
  });

  it('degrades a malformed upstash result field to unknown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ result: 'not-an-object' })));
    const [report] = await client([UPSTASH]).queryVectorStores();
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.indexStatus)).toBe('unknown');
  });
});

describe('VectorStoreLiveClient — timeout budget', () => {
  it('defaults to a timeout that fits inside scan\'s per-agent budget', () => {
    // scan races assessHealth against AGENT_TIMEOUT_MS (2000ms). A slower
    // default would let a hanging provider blow that budget, and a timed-out
    // assessHealth returns a signal-less 'unknown' — wiping every checkId PR 5
    // anchors guidance to. Two sequential requests (Pinecone control plane then
    // data plane) must still fit, so this is the ceiling, not a preference.
    expect(DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(1500);
  });

  it('passes the configured timeout to the request signal', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return jsonResponse({ indexes: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    await new VectorStoreLiveClient({ connections: [PINECONE], timeoutMs: 50 }).queryVectorStores();
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe('VectorStoreLiveClient — secrecy', () => {
  it('no key material appears anywhere in the emitted reports', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401)));
    const reports = await client([PINECONE, UPSTASH]).queryVectorStores();
    const serialized = JSON.stringify(reports);
    expect(serialized).not.toContain(PINECONE.apiKey);
    expect(serialized).not.toContain(UPSTASH.apiKey);
    expect(serialized).toContain('…9876');
    expect(serialized).toContain('…5432');
  });
});
