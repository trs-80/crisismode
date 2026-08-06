// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, vi, afterEach } from 'vitest';
import { LlmProviderLiveClient } from '../agent/llm-provider/live-client.js';
import { LlmProviderDiagnosisAgent } from '../agent/llm-provider/agent.js';
import { assembleContext } from '../framework/context.js';
import type { AgentContext } from '../types/agent-context.js';

/** A distinctive fake key. If any of it reaches output, these tests fail. */
const SECRET = 'sk-ant-api03-DO-NOT-LEAK-THIS-VALUE-abcd';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers })),
  );
}

describe('llm-provider key secrecy', () => {
  it('keeps key material out of every value the agent emits, in every scenario', async () => {
    const scenarios: Array<[number, unknown]> = [
      [200, { data: [{ id: 'claude-sonnet-4-5' }] }],
      [401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }],
      [429, { type: 'error', error: { type: 'billing_error', message: 'credit balance is too low' } }],
    ];

    for (const [status, body] of scenarios) {
      stubFetch(status, body, { 'anthropic-ratelimit-requests-remaining': '5', 'anthropic-ratelimit-requests-limit': '1000' });

      const backend = new LlmProviderLiveClient({
        provider: 'anthropic',
        apiKey: SECRET,
        env: { ANTHROPIC_API_KEY: SECRET } as NodeJS.ProcessEnv,
      });
      const agent = new LlmProviderDiagnosisAgent(backend, async () => null);
      const trigger: AgentContext['trigger'] = {
        type: 'health_check',
        source: 'cli-scan',
        payload: { instance: 'derived-llm-anthropic', severity: 'info' },
        receivedAt: new Date().toISOString(),
      };
      const context = assembleContext(trigger, agent.manifest);

      const health = await agent.assessHealth(context);
      const diagnosis = await agent.diagnose(context);
      const plan = await agent.plan(context, diagnosis);

      const emitted = JSON.stringify({ health, diagnosis, plan });
      expect(emitted, `key leaked for HTTP ${status}`).not.toContain(SECRET);
      expect(emitted, `key body leaked for HTTP ${status}`).not.toContain('DO-NOT-LEAK-THIS-VALUE');
      // The fingerprint is the only key-derived value allowed out.
      expect(emitted).toContain('…abcd');
    }
  });

  it('keeps the key out of thrown errors when the provider misbehaves', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket hang up'); }));
    const backend = new LlmProviderLiveClient({ provider: 'openai', apiKey: SECRET });
    const validity = await backend.checkKeyValidity();
    expect(JSON.stringify(validity)).not.toContain(SECRET);
  });

  it('never puts the key in a request URL', async () => {
    const fn = vi.fn(async (_input: string | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fn);
    await new LlmProviderLiveClient({ provider: 'google', apiKey: SECRET }).checkKeyValidity();
    for (const call of fn.mock.calls) {
      expect(String(call[0])).not.toContain(SECRET);
    }
  });
});
