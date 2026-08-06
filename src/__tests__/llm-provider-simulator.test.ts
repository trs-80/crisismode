// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { LlmProviderSimulator } from '../agent/llm-provider/simulator.js';

describe('LlmProviderSimulator', () => {
  it('reports every check passing in the healthy scenario', async () => {
    const sim = new LlmProviderSimulator('healthy');
    expect((await sim.checkKeyPresence()).present).toBe(true);
    expect((await sim.checkKeyValidity()).outcome).toBe('valid');
    expect((await sim.checkRateLimitHeadroom()).requestsRemainingPct).toBeGreaterThan(20);
    expect((await sim.checkModel()).presentInList).toBe(true);
    expect((await sim.checkProviderStatus()).ongoingIncidents).toEqual([]);
  });

  it('never exposes key material, only a last-4 fingerprint', async () => {
    const presence = await new LlmProviderSimulator('healthy').checkKeyPresence();
    expect(presence.fingerprint).toBe('…lkey');
    expect(presence.envVar).toBe('ANTHROPIC_API_KEY');
  });

  it('reports a missing key without inventing a validity result', async () => {
    const sim = new LlmProviderSimulator('no_key');
    const presence = await sim.checkKeyPresence();
    expect(presence.present).toBe(false);
    expect(presence.fingerprint).toBeNull();
    expect(presence.checkedEnvVars).toContain('ANTHROPIC_API_KEY');
    expect((await sim.checkKeyValidity()).outcome).toBe('unknown');
  });

  it('classifies a rejected key as invalid_key with the HTTP status', async () => {
    const validity = await new LlmProviderSimulator('bad_key').checkKeyValidity();
    expect(validity.outcome).toBe('invalid_key');
    expect(validity.httpStatus).toBe(401);
  });

  it('classifies an exhausted balance as billing_or_quota', async () => {
    const validity = await new LlmProviderSimulator('quota_exhausted').checkKeyValidity();
    expect(validity.outcome).toBe('billing_or_quota');
    expect(validity.detail.toLowerCase()).toContain('quota');
  });

  it('reports low headroom in the rate_limited scenario', async () => {
    const headroom = await new LlmProviderSimulator('rate_limited').checkRateLimitHeadroom();
    expect(headroom.known).toBe(true);
    expect(headroom.requestsRemainingPct).toBeLessThan(20);
  });

  it('classifies the rate_limited scenario as an observed 429, not a bare "valid"', async () => {
    // Finding 2: the agent's degraded-on-observed-429 logic keys off
    // outcome === 'rate_limited'. Before this fix the scenario named
    // 'rate_limited' returned outcome 'valid', which meant no test ever
    // exercised that branch through the simulator.
    const validity = await new LlmProviderSimulator('rate_limited').checkKeyValidity();
    expect(validity.outcome).toBe('rate_limited');
    expect(validity.httpStatus).toBe(429);
  });

  it('classifies a permission-scoped key as valid-but-narrow, not invalid', async () => {
    const validity = await new LlmProviderSimulator('key_scope_limited').checkKeyValidity();
    expect(validity.outcome).toBe('permission');
    expect(validity.httpStatus).toBe(403);
    expect(validity.detail).not.toContain('requests are failing');
  });

  it('reports a configured model missing from the live list', async () => {
    const model = await new LlmProviderSimulator('deprecated_model').checkModel();
    expect(model.listKnown).toBe(true);
    expect(model.presentInList).toBe(false);
    expect(model.configuredModel).toBe('claude-3-sonnet-20240229');
    expect(model.sampleModels.length).toBeGreaterThan(0);
  });

  it('reports an ongoing incident in the provider_incident scenario', async () => {
    const status = await new LlmProviderSimulator('provider_incident').checkProviderStatus();
    expect(status.known).toBe(true);
    expect(status.ongoingIncidents).toHaveLength(1);
    expect(status.ongoingIncidents[0]!.title).toContain('Elevated error rates');
  });

  it('reports unknown headroom for a provider that exposes no ratelimit headers', async () => {
    const headroom = await new LlmProviderSimulator('healthy', 'google').checkRateLimitHeadroom();
    expect(headroom.known).toBe(false);
    expect(headroom.requestsRemainingPct).toBeNull();
    expect(headroom.detail).toContain('does not publish');
  });

  it('switches scenario via transition()', async () => {
    const sim = new LlmProviderSimulator('healthy');
    sim.transition('bad_key');
    expect((await sim.checkKeyValidity()).outcome).toBe('invalid_key');
  });

  it('answers evaluateCheck statements from scenario state', async () => {
    const sim = new LlmProviderSimulator('bad_key');
    expect(await sim.evaluateCheck({ type: 'api_call', statement: 'llm_key_valid', expect: { operator: 'eq', value: 'ok' } })).toBe(false);
    sim.transition('healthy');
    expect(await sim.evaluateCheck({ type: 'api_call', statement: 'llm_key_valid', expect: { operator: 'eq', value: 'ok' } })).toBe(true);
  });
});
