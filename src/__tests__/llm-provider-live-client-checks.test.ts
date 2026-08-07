// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  LlmProviderLiveClient,
  parseHeadroomFromHeaders,
  extractModelIds,
} from '../agent/llm-provider/live-client.js';

function routeFetch(routes: Record<string, { status: number; body: unknown; headers?: Record<string, string> }>) {
  const fn = vi.fn(async (input: string | URL) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error(`unmocked fetch: ${url}`);
    const route = routes[key]!;
    return new Response(JSON.stringify(route.body), { status: route.status, headers: route.headers ?? {} });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseHeadroomFromHeaders', () => {
  it('computes request and token percentages from an Anthropic response', () => {
    expect(parseHeadroomFromHeaders(
      {
        'anthropic-ratelimit-requests-limit': '1000',
        'anthropic-ratelimit-requests-remaining': '250',
        'anthropic-ratelimit-tokens-limit': '80000',
        'anthropic-ratelimit-tokens-remaining': '8000',
      },
      'anthropic-ratelimit-',
    )).toEqual({ requestsRemainingPct: 25, tokensRemainingPct: 10 });
  });

  it('computes percentages from OpenAI headers', () => {
    expect(parseHeadroomFromHeaders(
      { 'x-ratelimit-limit-requests': '500', 'x-ratelimit-remaining-requests': '5' },
      'x-ratelimit-',
    ).requestsRemainingPct).toBe(1);
  });

  it('falls back to input-token headers when the plain token headers are absent', () => {
    expect(parseHeadroomFromHeaders(
      {
        'anthropic-ratelimit-input-tokens-limit': '100',
        'anthropic-ratelimit-input-tokens-remaining': '15',
      },
      'anthropic-ratelimit-',
    ).tokensRemainingPct).toBe(15);
  });

  it('returns nulls rather than guessing when headers are missing or zero-limit', () => {
    expect(parseHeadroomFromHeaders({}, 'anthropic-ratelimit-')).toEqual({ requestsRemainingPct: null, tokensRemainingPct: null });
    expect(parseHeadroomFromHeaders(
      { 'x-ratelimit-limit-requests': '0', 'x-ratelimit-remaining-requests': '0' },
      'x-ratelimit-',
    ).requestsRemainingPct).toBeNull();
  });
});

describe('extractModelIds', () => {
  it('reads the data[].id shape', () => {
    expect(extractModelIds({ data: [{ id: 'a' }, { id: 'b' }] }, 'data_id')).toEqual(['a', 'b']);
  });

  it('reads the Google models[].name shape and strips the models/ prefix', () => {
    expect(extractModelIds({ models: [{ name: 'models/gemini-2.5-pro' }] }, 'models_name')).toEqual(['gemini-2.5-pro']);
  });

  it('returns an empty list for an unexpected body', () => {
    expect(extractModelIds({ unexpected: true }, 'data_id')).toEqual([]);
    expect(extractModelIds(null, 'models_name')).toEqual([]);
  });
});

describe('LlmProviderLiveClient.checkRateLimitHeadroom', () => {
  it('reads headroom from the cached authenticated response', async () => {
    routeFetch({
      'api.anthropic.com': {
        status: 200,
        body: { data: [{ id: 'claude-sonnet-4-5' }] },
        headers: {
          'anthropic-ratelimit-requests-limit': '1000',
          'anthropic-ratelimit-requests-remaining': '120',
        },
      },
    });
    const headroom = await new LlmProviderLiveClient({ provider: 'anthropic', apiKey: 'sk-ant' }).checkRateLimitHeadroom();
    expect(headroom.known).toBe(true);
    expect(headroom.requestsRemainingPct).toBe(12);
    expect(headroom.detail).toContain('12%');
  });

  it('reports honest unknown for a provider that publishes no ratelimit headers', async () => {
    routeFetch({ 'generativelanguage.googleapis.com': { status: 200, body: { models: [] } } });
    const headroom = await new LlmProviderLiveClient({ provider: 'google', apiKey: 'g-key' }).checkRateLimitHeadroom();
    expect(headroom.known).toBe(false);
    expect(headroom.requestsRemainingPct).toBeNull();
    expect(headroom.detail).toContain('does not publish');
  });

  it('derives OpenRouter headroom from remaining credit', async () => {
    routeFetch({
      'openrouter.ai/api/v1/key': {
        status: 200,
        body: { data: { label: 'k', limit: 200, limit_remaining: 10, usage: 190, is_free_tier: false } },
      },
    });
    const headroom = await new LlmProviderLiveClient({ provider: 'openrouter', apiKey: 'or-key' }).checkRateLimitHeadroom();
    expect(headroom.known).toBe(true);
    expect(headroom.requestsRemainingPct).toBe(5);
    expect(headroom.detail).toContain('credit');
  });

  it('reports unknown for an OpenRouter key with no credit cap', async () => {
    routeFetch({
      'openrouter.ai/api/v1/key': {
        status: 200,
        body: { data: { label: 'k', limit: null, limit_remaining: null, usage: 12, is_free_tier: false } },
      },
    });
    const headroom = await new LlmProviderLiveClient({ provider: 'openrouter', apiKey: 'or-key' }).checkRateLimitHeadroom();
    expect(headroom.known).toBe(false);
    expect(headroom.detail).toContain('no credit limit');
  });
});

describe('LlmProviderLiveClient.checkModel', () => {
  it('confirms a configured model that exists in the live list', async () => {
    routeFetch({ 'api.anthropic.com': { status: 200, body: { data: [{ id: 'claude-sonnet-4-5' }] } } });
    const model = await new LlmProviderLiveClient({
      provider: 'anthropic',
      apiKey: 'sk-ant',
      configuredModel: 'claude-sonnet-4-5',
    }).checkModel();
    expect(model.source).toBe('config');
    expect(model.presentInList).toBe(true);
  });

  it('flags a configured model that is gone, and offers live ids', async () => {
    routeFetch({ 'api.anthropic.com': { status: 200, body: { data: [{ id: 'claude-sonnet-4-5' }, { id: 'claude-opus-4-1' }] } } });
    const model = await new LlmProviderLiveClient({
      provider: 'anthropic',
      apiKey: 'sk-ant',
      configuredModel: 'claude-3-sonnet-20240229',
    }).checkModel();
    expect(model.presentInList).toBe(false);
    expect(model.sampleModels).toContain('claude-sonnet-4-5');
    expect(model.detail).toContain('mismatch');
  });

  it('falls back to the provider model env var when config declares none', async () => {
    routeFetch({ 'api.openai.com': { status: 200, body: { data: [{ id: 'gpt-4o' }] } } });
    const model = await new LlmProviderLiveClient({
      provider: 'openai',
      apiKey: 'sk-openai',
      env: { OPENAI_MODEL: 'gpt-4o' } as NodeJS.ProcessEnv,
    }).checkModel();
    expect(model.source).toBe('env');
    expect(model.configuredModel).toBe('gpt-4o');
    expect(model.presentInList).toBe(true);
  });

  it('distinguishes an unreadable model list from a genuinely empty one', async () => {
    // Unreadable: the check learned nothing.
    routeFetch({ 'api.openai.com': { status: 500, body: { error: { message: 'upstream error' } } } });
    const unreadable = await new LlmProviderLiveClient({
      provider: 'openai',
      apiKey: 'sk-openai',
      configuredModel: 'gpt-4o',
    }).checkModel();
    expect(unreadable.listKnown).toBe(false);
    expect(unreadable.presentInList).toBeNull();
    expect(unreadable.detail).toContain('could not be read');

    // Readable but empty: the provider answered, and the configured model is
    // definitively not there. That is a real finding, not an unknown.
    vi.unstubAllGlobals();
    routeFetch({ 'api.openai.com': { status: 200, body: { data: [] } } });
    const empty = await new LlmProviderLiveClient({
      provider: 'openai',
      apiKey: 'sk-openai',
      configuredModel: 'gpt-4o',
    }).checkModel();
    expect(empty.listKnown).toBe(true);
    expect(empty.presentInList).toBe(false);
    expect(empty.detail).toContain('returned an empty model list');
  });

  it('reports unknown — not a failure — when no model is configured anywhere', async () => {
    routeFetch({ 'api.openai.com': { status: 200, body: { data: [{ id: 'gpt-4o' }] } } });
    const model = await new LlmProviderLiveClient({ provider: 'openai', apiKey: 'sk-openai', env: {} as NodeJS.ProcessEnv }).checkModel();
    expect(model.configuredModel).toBeNull();
    expect(model.presentInList).toBeNull();
    expect(model.detail).toContain('no model id');
  });

  it('fetches the public models list separately for OpenRouter', async () => {
    const fn = routeFetch({
      'openrouter.ai/api/v1/key': { status: 200, body: { data: { limit: null, limit_remaining: null } } },
      'openrouter.ai/api/v1/models': { status: 200, body: { data: [{ id: 'anthropic/claude-sonnet-4.5' }] } },
    });
    const model = await new LlmProviderLiveClient({
      provider: 'openrouter',
      apiKey: 'or-key',
      configuredModel: 'anthropic/claude-sonnet-4.5',
    }).checkModel();
    expect(model.presentInList).toBe(true);
    expect(fn.mock.calls.some((c) => String(c[0]).includes('/api/v1/models'))).toBe(true);
  });

  it('follows Google nextPageToken to find a model beyond the first page', async () => {
    routeFetch({
      // Listed first: routeFetch's route matching is url.includes(key), and
      // Object.keys iterates in insertion order — this specific key must be
      // checked before the bare-host fallback below, or every call would
      // match the fallback instead.
      'pageToken=next-page-token': {
        status: 200,
        body: { models: [{ name: 'models/gemini-1.5-pro' }] },
      },
      'generativelanguage.googleapis.com': {
        status: 200,
        body: { models: [{ name: 'models/gemini-1.0-pro' }], nextPageToken: 'next-page-token' },
      },
    });
    const model = await new LlmProviderLiveClient({
      provider: 'google',
      apiKey: 'goog-key',
      configuredModel: 'gemini-1.5-pro',
    }).checkModel();
    expect(model.listKnown).toBe(true);
    expect(model.presentInList).toBe(true);
    expect(model.sampleModels).toContain('gemini-1.5-pro');
  });

  it('reports unknown, not deprecated, when the Google model list has more pages than the cap follows', async () => {
    // Every page returns a nextPageToken, so the loop exhausts
    // MAX_MODEL_LIST_PAGES (3) without ever reading a page containing the
    // configured model — this must never resolve to presentInList: false,
    // since the model might be on the page the check gave up before reaching.
    let page = 0;
    const fn = vi.fn(async () => {
      page += 1;
      return new Response(
        JSON.stringify({ models: [{ name: `models/filler-${page}` }], nextPageToken: `token-${page}` }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fn);
    const model = await new LlmProviderLiveClient({
      provider: 'google',
      apiKey: 'goog-key',
      configuredModel: 'gemini-1.5-pro',
    }).checkModel();
    expect(model.listKnown).toBe(false);
    expect(model.presentInList).toBeNull();
    expect(model.detail).toContain('more pages');
    expect(fn.mock.calls.length).toBe(3);
  });
});

describe('LlmProviderLiveClient.checkProviderStatus', () => {
  it('reports ongoing Statuspage incidents', async () => {
    routeFetch({
      'api.anthropic.com': { status: 200, body: { data: [] } },
      'status.claude.com': {
        status: 200,
        body: { incidents: [{ name: 'Elevated error rates', impact: 'major', shortlink: 'https://stspg.io/x', status: 'investigating' }] },
      },
    });
    const status = await new LlmProviderLiveClient({ provider: 'anthropic', apiKey: 'sk-ant' }).checkProviderStatus();
    expect(status.known).toBe(true);
    expect(status.ongoingIncidents).toEqual([
      { title: 'Elevated error rates', impact: 'major', url: 'https://stspg.io/x' },
    ]);
  });

  it('ignores resolved Statuspage incidents', async () => {
    routeFetch({
      'api.anthropic.com': { status: 200, body: { data: [] } },
      'status.claude.com': { status: 200, body: { incidents: [{ name: 'Old outage', impact: 'minor', status: 'resolved' }] } },
    });
    const status = await new LlmProviderLiveClient({ provider: 'anthropic', apiKey: 'sk-ant' }).checkProviderStatus();
    expect(status.ongoingIncidents).toEqual([]);
    expect(status.detail).toContain('no ongoing incidents');
  });

  it('reads unresolved Google Cloud incidents for AI services only', async () => {
    routeFetch({
      'generativelanguage.googleapis.com': { status: 200, body: { models: [] } },
      'status.cloud.google.com': {
        status: 200,
        body: [
          { external_desc: 'Gemini API elevated errors', severity: 'medium', service_name: 'Gemini API', uri: 'incidents/abc' },
          { external_desc: 'Old Cloud SQL issue', severity: 'high', service_name: 'Cloud SQL', end: '2026-08-01T00:00:00Z' },
          { external_desc: 'Resolved Gemini issue', severity: 'low', service_name: 'Gemini API', end: '2026-08-02T00:00:00Z' },
        ],
      },
    });
    const status = await new LlmProviderLiveClient({ provider: 'google', apiKey: 'g-key' }).checkProviderStatus();
    expect(status.known).toBe(true);
    expect(status.ongoingIncidents).toHaveLength(1);
    expect(status.ongoingIncidents[0]!.title).toBe('Gemini API elevated errors');
  });

  it('reports unknown when the status endpoint is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      if (String(input).includes('status.')) throw new Error('ENOTFOUND');
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }));
    const status = await new LlmProviderLiveClient({ provider: 'anthropic', apiKey: 'sk-ant' }).checkProviderStatus();
    expect(status.known).toBe(false);
    expect(status.ongoingIncidents).toEqual([]);
    expect(status.detail).toContain('could not be read');
  });

  it('reports unknown when the status body is not the shape we expect', async () => {
    routeFetch({
      'api.openai.com': { status: 200, body: { data: [] } },
      'status.openai.com': { status: 200, body: { unexpected: 'shape' } },
    });
    const status = await new LlmProviderLiveClient({ provider: 'openai', apiKey: 'sk-openai' }).checkProviderStatus();
    expect(status.known).toBe(false);
  });
});

describe('LlmProviderLiveClient.evaluateCheck', () => {
  it('fails closed on an unrecognized statement', async () => {
    // Matching the vector-store precedent: a check on a statement neither
    // backend recognizes is a plan-authoring bug, and must not silently pass.
    routeFetch({ 'api.anthropic.com': { status: 200, body: { data: [] } } });
    const client = new LlmProviderLiveClient({ provider: 'anthropic', apiKey: 'sk-ant' });
    expect(await client.evaluateCheck({ type: 'api_call', statement: 'nonsense_statement', expect: { operator: 'eq', value: 'ok' } })).toBe(false);
  });
});
