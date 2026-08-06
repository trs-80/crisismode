// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  LlmProviderLiveClient,
  classifyAuthFailure,
  extractErrorInfo,
  DEFAULT_LLM_REQUEST_TIMEOUT_MS,
} from '../agent/llm-provider/live-client.js';
import { getProviderSpec } from '../agent/llm-provider/provider-table.js';
import { AGENT_TIMEOUT_MS } from '../cli/commands/scan.js';

interface MockRoute {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** Route requests by URL substring; records every request for assertions. */
function mockFetch(routes: Record<string, MockRoute>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fn = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    calls.push({ url, headers });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error(`unmocked fetch: ${url}`);
    const route = routes[key]!;
    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: route.headers ?? {},
    });
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('classifyAuthFailure', () => {
  it('treats 401 as an invalid key', () => {
    expect(classifyAuthFailure(401, 'authentication_error', 'invalid x-api-key')).toBe('invalid_key');
  });

  it('separates a billing 403 from a permission 403', () => {
    expect(classifyAuthFailure(403, 'billing_error', 'credit balance is too low')).toBe('billing_or_quota');
    expect(classifyAuthFailure(403, 'permission_error', 'not allowed to use this resource')).toBe('permission');
  });

  it('separates OpenAI insufficient_quota from ordinary rate limiting', () => {
    expect(classifyAuthFailure(429, 'insufficient_quota', 'You exceeded your current quota')).toBe('billing_or_quota');
    expect(classifyAuthFailure(429, 'rate_limit_error', 'Number of requests has exceeded your limit')).toBe('rate_limited');
  });

  it('recognises a Gemini invalid key reported as a 400', () => {
    expect(classifyAuthFailure(400, 'API_KEY_INVALID', 'API key not valid. Please pass a valid API key.')).toBe('invalid_key');
  });

  it('falls back to "other" rather than guessing', () => {
    expect(classifyAuthFailure(500, undefined, undefined)).toBe('other');
  });
});

describe('extractErrorInfo', () => {
  it('reads the Anthropic error shape', () => {
    expect(extractErrorInfo({ type: 'error', error: { type: 'authentication_error', message: 'nope' } }))
      .toEqual({ type: 'authentication_error', message: 'nope' });
  });

  it('prefers OpenAI error.code over error.type', () => {
    expect(extractErrorInfo({ error: { type: 'insufficient_quota', code: 'insufficient_quota', message: 'no quota' } }).type)
      .toBe('insufficient_quota');
  });

  it('reads the Google error.status shape', () => {
    expect(extractErrorInfo({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'denied' } }))
      .toEqual({ type: 'PERMISSION_DENIED', message: 'denied' });
  });

  it('returns an empty object for a non-JSON-object body', () => {
    expect(extractErrorInfo('<html>502</html>')).toEqual({});
    expect(extractErrorInfo(null)).toEqual({});
  });
});

describe('LlmProviderLiveClient key presence', () => {
  it('reports the env var name and a last-4 fingerprint, never the key', async () => {
    const client = new LlmProviderLiveClient({
      provider: 'anthropic',
      apiKey: 'sk-ant-api03-SECRETSECRET-1234',
      env: { ANTHROPIC_API_KEY: 'sk-ant-api03-SECRETSECRET-1234' } as NodeJS.ProcessEnv,
    });
    const presence = await client.checkKeyPresence();
    expect(presence.present).toBe(true);
    expect(presence.envVar).toBe('ANTHROPIC_API_KEY');
    expect(presence.fingerprint).toBe('…1234');
    expect(JSON.stringify(presence)).not.toContain('SECRETSECRET');
  });

  it('reports every env var it checked when no key is present', async () => {
    const client = new LlmProviderLiveClient({ provider: 'google', apiKey: '', env: {} as NodeJS.ProcessEnv });
    const presence = await client.checkKeyPresence();
    expect(presence.present).toBe(false);
    expect(presence.checkedEnvVars).toEqual(['GOOGLE_AI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY']);
  });
});

describe('LlmProviderLiveClient key validity', () => {
  it('sends the Anthropic auth and version headers to the models endpoint', async () => {
    const { calls } = mockFetch({ 'api.anthropic.com': { status: 200, body: { data: [{ id: 'claude-sonnet-4-5' }] } } });
    const client = new LlmProviderLiveClient({ provider: 'anthropic', apiKey: 'sk-ant-test-key' });

    const validity = await client.checkKeyValidity();

    expect(validity.outcome).toBe('valid');
    expect(validity.httpStatus).toBe(200);
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/models');
    expect(calls[0]!.headers['x-api-key']).toBe('sk-ant-test-key');
    expect(calls[0]!.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('sends a bearer token to the OpenAI models endpoint', async () => {
    const { calls } = mockFetch({ 'api.openai.com': { status: 200, body: { data: [{ id: 'gpt-4o' }] } } });
    await new LlmProviderLiveClient({ provider: 'openai', apiKey: 'sk-openai-test' }).checkKeyValidity();
    expect(calls[0]!.headers['Authorization']).toBe('Bearer sk-openai-test');
  });

  it('authenticates OpenRouter against its key-info endpoint', async () => {
    const { calls } = mockFetch({
      'openrouter.ai/api/v1/key': { status: 200, body: { data: { label: 'k', limit: 100, limit_remaining: 60, usage: 40, is_free_tier: false } } },
    });
    const validity = await new LlmProviderLiveClient({ provider: 'openrouter', apiKey: 'or-test' }).checkKeyValidity();
    expect(validity.outcome).toBe('valid');
    // Whichever path Task 1 Step 5's curl confirmed — assert against the table
    // rather than a hardcoded string, so this test follows the source of truth.
    expect(calls[0]!.url).toBe(getProviderSpec('openrouter')!.keyInfoUrl);
  });

  it('classifies a rejected key without echoing the key', async () => {
    mockFetch({
      'api.anthropic.com': { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } },
    });
    const validity = await new LlmProviderLiveClient({ provider: 'anthropic', apiKey: 'sk-ant-BADSECRET' }).checkKeyValidity();
    expect(validity.outcome).toBe('invalid_key');
    expect(validity.httpStatus).toBe(401);
    expect(validity.detail).toContain('401');
    expect(validity.detail).not.toContain('BADSECRET');
  });

  it('classifies an exhausted OpenAI quota as billing_or_quota', async () => {
    mockFetch({
      'api.openai.com': { status: 429, body: { error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } } },
    });
    const validity = await new LlmProviderLiveClient({ provider: 'openai', apiKey: 'sk-openai' }).checkKeyValidity();
    expect(validity.outcome).toBe('billing_or_quota');
  });

  it('describes a permission-scoped 403 honestly — the key is valid, just under-scoped for this probe', async () => {
    // A restricted-scope OpenAI key 403s on /v1/models while completions still
    // work. The old wording ("requests are failing") would over-alarm — the
    // key authenticated fine, it just can't do this particular call.
    mockFetch({
      'api.openai.com': { status: 403, body: { error: { type: 'permission_error', message: 'insufficient permissions for this operation' } } },
    });
    const validity = await new LlmProviderLiveClient({ provider: 'openai', apiKey: 'sk-openai-scoped' }).checkKeyValidity();
    expect(validity.outcome).toBe('permission');
    expect(validity.httpStatus).toBe(403);
    expect(validity.detail).not.toContain('requests are failing');
    expect(validity.detail.toLowerCase()).toContain('scope');
  });

  it('reports unknown — not "down" — when the network call fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND api.anthropic.com'); }));
    const validity = await new LlmProviderLiveClient({ provider: 'anthropic', apiKey: 'sk-ant' }).checkKeyValidity();
    expect(validity.outcome).toBe('unknown');
    expect(validity.httpStatus).toBeNull();
    expect(validity.detail).toContain('could not be reached');
    expect(validity.detail.toLowerCase()).not.toContain('is down');
  });

  it('reports unknown when there is no key to test, without calling the network', async () => {
    const { fn } = mockFetch({ 'api.anthropic.com': { status: 200, body: {} } });
    const validity = await new LlmProviderLiveClient({ provider: 'anthropic', apiKey: '' }).checkKeyValidity();
    expect(validity.outcome).toBe('unknown');
    expect(fn).not.toHaveBeenCalled();
  });

  it('makes exactly one authenticated request no matter how many checks run', async () => {
    const { fn } = mockFetch({
      'api.anthropic.com': { status: 200, body: { data: [{ id: 'claude-sonnet-4-5' }] } },
      'status.anthropic.com': { status: 200, body: { incidents: [] } },
    });
    const client = new LlmProviderLiveClient({ provider: 'anthropic', apiKey: 'sk-ant-test' });
    await client.checkKeyValidity();
    await client.checkKeyValidity();
    const apiCalls = fn.mock.calls.filter((c) => String(c[0]).includes('api.anthropic.com'));
    expect(apiCalls).toHaveLength(1);
  });

  it('fits inside scan\'s per-agent budget and actually passes an abort signal', async () => {
    // If a request outlives AGENT_TIMEOUT_MS, scan substitutes an assessment
    // with signals: [] — which erases every checkId and the guidance keyed on
    // them. This assertion breaks loudly if either number moves.
    expect(DEFAULT_LLM_REQUEST_TIMEOUT_MS).toBeLessThan(AGENT_TIMEOUT_MS);

    const { fn } = mockFetch({ 'api.anthropic.com': { status: 200, body: { data: [] } } });
    await new LlmProviderLiveClient({ provider: 'anthropic', apiKey: 'sk-ant' }).checkKeyValidity();
    const init = fn.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('never sends a POST — no billable inference call is ever made', async () => {
    const { fn } = mockFetch({ 'api.anthropic.com': { status: 200, body: { data: [] } } });
    await new LlmProviderLiveClient({ provider: 'anthropic', apiKey: 'sk-ant' }).checkKeyValidity();
    for (const call of fn.mock.calls) {
      const method = (call[1] as RequestInit | undefined)?.method;
      expect(method === undefined || method === 'GET').toBe(true);
    }
  });
});
