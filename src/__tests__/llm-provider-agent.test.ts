// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { buildLlmProviderManifest, llmProviderManifests } from '../agent/llm-provider/manifest.js';
import type { LlmProviderId } from '../agent/llm-provider/provider-table.js';
import { isKnownCapability } from '../framework/capability-registry.js';
import { explainSource } from '../framework/signal-explanations.js';
import { LlmProviderDiagnosisAgent } from '../agent/llm-provider/agent.js';
import { LlmProviderSimulator } from '../agent/llm-provider/simulator.js';
import { LLM_PROVIDER_CHECK_IDS } from '../agent/llm-provider/check-ids.js';
import { assembleContext } from '../framework/context.js';
import { healthToSignals } from '../framework/health-to-signals.js';
import type { AgentContext } from '../types/agent-context.js';
import type { OfflineGate } from '../agent/llm-provider/offline-gate.js';
import type { LlmProviderScenario } from '../agent/llm-provider/simulator.js';

describe('llmProviderManifest', () => {
  it('builds manifests for all four providers with per-provider maturity', () => {
    const expectations: Record<LlmProviderId, 'live_validated' | 'simulator_only'> = {
      anthropic: 'live_validated',
      openai: 'live_validated',
      google: 'simulator_only',
      openrouter: 'simulator_only',
    };

    for (const [provider, expectedMaturity] of Object.entries(expectations)) {
      const manifest = llmProviderManifests[provider as LlmProviderId];
      expect(manifest, `manifest missing for ${provider}`).toBeDefined();
      expect(manifest.metadata.plugin.maturity).toBe(expectedMaturity);
      expect(manifest.metadata.plugin.id).toBe(`llm-provider.${provider}`);
    }
  });

  it('buildLlmProviderManifest returns consistent results (deterministic)', () => {
    const m1 = buildLlmProviderManifest('anthropic');
    const m2 = buildLlmProviderManifest('anthropic');
    expect(JSON.stringify(m1)).toBe(JSON.stringify(m2));
  });

  it('claims live_validated maturity at routine risk for validated providers', () => {
    const manifest = llmProviderManifests.anthropic;
    expect(manifest.metadata.plugin.maturity).toBe('live_validated');
    expect(manifest.spec.riskProfile.maxRiskLevel).toBe('routine');
    expect(manifest.spec.riskProfile.dataLossPossible).toBe(false);
    expect(manifest.spec.riskProfile.serviceDisruptionPossible).toBe(false);
  });

  it('declares only read privilege — this agent never mutates', () => {
    for (const manifest of Object.values(llmProviderManifests)) {
      for (const ctx of manifest.spec.executionContexts) {
        expect(ctx.privilege).toBe('read');
      }
    }
  });

  it('registers every capability it declares', () => {
    for (const manifest of Object.values(llmProviderManifests)) {
      for (const ctx of manifest.spec.executionContexts) {
        for (const capability of ctx.capabilities ?? []) {
          expect(isKnownCapability(capability), `unregistered capability ${capability}`).toBe(true);
        }
      }
    }
  });

  it('has a plain-language explanation for every signal source it emits', () => {
    for (const source of [
      'llm_key_present',
      'llm_key_valid',
      'llm_quota_billing',
      'llm_rate_limit_headroom',
      'llm_model_deprecated',
      'llm_provider_status',
    ]) {
      expect(explainSource(source), `no EXPLANATIONS entry for ${source}`).toBeDefined();
    }
  });
});

function setup(scenario: LlmProviderScenario = 'healthy', gate?: OfflineGate) {
  const simulator = new LlmProviderSimulator(scenario);
  const agent = new LlmProviderDiagnosisAgent(simulator, gate ?? (async () => null));
  const trigger: AgentContext['trigger'] = {
    type: 'health_check',
    source: 'cli-scan',
    payload: { alertname: 'llm-providerScanCheck', instance: 'derived-llm-anthropic', severity: 'info' },
    receivedAt: new Date().toISOString(),
  };
  return { simulator, agent, context: assembleContext(trigger, agent.manifest) };
}

describe('LlmProviderDiagnosisAgent.assessHealth', () => {
  it('is healthy when every check passes', async () => {
    const { agent, context } = setup('healthy');
    const health = await agent.assessHealth(context);
    expect(health.status).toBe('healthy');
    expect(health.signals).toHaveLength(6);
  });

  it('tags every signal with its stable checkId', async () => {
    const { agent, context } = setup('healthy');
    const health = await agent.assessHealth(context);
    expect(health.signals.map((s) => s.checkId)).toEqual([
      LLM_PROVIDER_CHECK_IDS.keyPresent,
      LLM_PROVIDER_CHECK_IDS.keyValid,
      LLM_PROVIDER_CHECK_IDS.quotaBilling,
      LLM_PROVIDER_CHECK_IDS.rateLimitHeadroom,
      LLM_PROVIDER_CHECK_IDS.modelDeprecated,
      LLM_PROVIDER_CHECK_IDS.providerStatus,
    ]);
  });

  it('is unhealthy with a critical key_valid signal when the key is rejected', async () => {
    const { agent, context } = setup('bad_key');
    const health = await agent.assessHealth(context);
    expect(health.status).toBe('unhealthy');
    const keyValid = health.signals.find((s) => s.checkId === LLM_PROVIDER_CHECK_IDS.keyValid)!;
    expect(keyValid.status).toBe('critical');
    expect(keyValid.detail).toContain('401');
  });

  it('is unhealthy with a critical quota_billing signal when the account is out of credit', async () => {
    const { agent, context } = setup('quota_exhausted');
    const health = await agent.assessHealth(context);
    expect(health.status).toBe('unhealthy');
    const quota = health.signals.find((s) => s.checkId === LLM_PROVIDER_CHECK_IDS.quotaBilling)!;
    expect(quota.status).toBe('critical');
  });

  it('is degraded when rate-limit headroom is below 20%', async () => {
    const { agent, context } = setup('rate_limited');
    const health = await agent.assessHealth(context);
    expect(health.status).toBe('recovering');
    expect(health.signals.find((s) => s.checkId === LLM_PROVIDER_CHECK_IDS.rateLimitHeadroom)!.status).toBe('warning');
  });

  it('is degraded when the provider reports an ongoing incident', async () => {
    const { agent, context } = setup('provider_incident');
    const health = await agent.assessHealth(context);
    expect(health.status).toBe('recovering');
  });

  it('names the env vars it checked and the no-.env rule when no key is present', async () => {
    const { agent, context } = setup('no_key');
    const health = await agent.assessHealth(context);
    expect(health.status).toBe('unhealthy');
    const presence = health.signals.find((s) => s.checkId === LLM_PROVIDER_CHECK_IDS.keyPresent)!;
    expect(presence.status).toBe('critical');
    expect(presence.detail).toContain('ANTHROPIC_API_KEY');
    expect(presence.detail).toContain('.env');
  });

  it('defers to the triage verdict instead of reporting the provider down when offline', async () => {
    const gate: OfflineGate = async () => ({
      verdict: 'network',
      explanation: 'this machine has no working internet connection (DNS resolves, but no host is reachable)',
    });
    const { agent, context } = setup('bad_key', gate);
    const health = await agent.assessHealth(context);

    expect(health.status).toBe('unknown');
    const networkChecks = health.signals.filter((s) => s.checkId !== LLM_PROVIDER_CHECK_IDS.keyPresent);
    expect(networkChecks).toHaveLength(5);
    for (const signal of networkChecks) {
      expect(signal.status).toBe('unknown');
      expect(signal.detail).toContain('no working internet connection');
    }
    // key_present still works offline.
    expect(health.signals.find((s) => s.checkId === LLM_PROVIDER_CHECK_IDS.keyPresent)!.status).toBe('healthy');
    expect(health.summary.toLowerCase()).not.toContain('provider is down');
  });

  it('maps its critical and warning signals onto the existing signal vocabulary', async () => {
    const { agent, context } = setup('bad_key');
    const mapped = healthToSignals(await agent.assessHealth(context));
    for (const signal of mapped) {
      expect(['connection', 'error_rate', 'config_mismatch', 'custom']).toContain(signal.type);
    }
    expect(mapped.find((s) => s.source === 'llm_key_valid')!.type).toBe('error_rate');

    const deprecated = setup('deprecated_model');
    const deprecatedMapped = healthToSignals(await deprecated.agent.assessHealth(deprecated.context));
    expect(deprecatedMapped.find((s) => s.source === 'llm_model_deprecated')!.type).toBe('config_mismatch');
  });

  it('names the check that came back unknown instead of claiming it is fine when overall status is still healthy', async () => {
    // Google publishes no rate-limit response headers, so checkRateLimitHeadroom
    // returns known: false even in the 'healthy' scenario — every other check
    // passes, so overallStatus is still 'healthy', but the summary must not
    // claim rate-limit headroom is fine when it was never actually read.
    const simulator = new LlmProviderSimulator('healthy', 'google');
    const agent = new LlmProviderDiagnosisAgent(simulator, async () => null);
    const context = assembleContext(
      {
        type: 'health_check',
        source: 'cli-scan',
        payload: { alertname: 'llm-providerScanCheck', instance: 'derived-llm-google', severity: 'info' },
        receivedAt: new Date().toISOString(),
      },
      agent.manifest,
    );
    const health = await agent.assessHealth(context);

    expect(health.status).toBe('healthy');
    const headroom = health.signals.find((s) => s.checkId === LLM_PROVIDER_CHECK_IDS.rateLimitHeadroom)!;
    expect(headroom.status).toBe('unknown');
    expect(health.summary).toContain('rate-limit headroom could not be determined');
    expect(health.summary).not.toContain('rate-limit headroom is fine');
  });

  it('never lets the raw fixture key reach assessHealth or diagnose output', async () => {
    // Mirrors simulator.ts's private FIXTURE_KEY, duplicated here because the
    // simulator does not export it. A leak of this literal into either
    // method's output means a fingerprinted field regressed to carrying the
    // raw key instead of presence.fingerprint.
    const FIXTURE_KEY = 'sk-ant-simulator-fixture-notarealkey';
    const { agent, context } = setup('healthy');
    const health = await agent.assessHealth(context);
    const diagnosis = await agent.diagnose(context);
    const serialized = JSON.stringify({ health, diagnosis });

    expect(serialized).not.toContain(FIXTURE_KEY);
    expect(serialized).toContain('…lkey');
  });
});

describe('LlmProviderDiagnosisAgent.diagnose', () => {
  it('identifies an invalid key', async () => {
    const { agent, context } = setup('bad_key');
    const diagnosis = await agent.diagnose(context);
    expect(diagnosis.status).toBe('identified');
    expect(diagnosis.scenario).toBe('api_key_invalid');
    expect(diagnosis.findings.length).toBeGreaterThan(0);
  });

  it('identifies exhausted quota ahead of other scenarios', async () => {
    const { agent, context } = setup('quota_exhausted');
    expect((await agent.diagnose(context)).scenario).toBe('quota_or_billing_exhausted');
  });

  it('identifies a configured model that no longer exists', async () => {
    const { agent, context } = setup('deprecated_model');
    expect((await agent.diagnose(context)).scenario).toBe('configured_model_unavailable');
  });

  it('is inconclusive, not identified, when everything passes', async () => {
    const { agent, context } = setup('healthy');
    const diagnosis = await agent.diagnose(context);
    expect(diagnosis.status).toBe('inconclusive');
    expect(diagnosis.scenario).toBeNull();
  });

  it('reports quota_billing as not tested, not checked-clean, when there is no key to probe with', async () => {
    const { agent, context } = setup('no_key');
    const diagnosis = await agent.diagnose(context);
    const quota = diagnosis.findings.find((f) => f.checkId === LLM_PROVIDER_CHECK_IDS.quotaBilling)!;
    expect(quota.observation).toContain('not tested');
    expect(quota.observation).not.toContain('No billing or quota error observed');
  });

  it('tags every finding with its checkId — PR 5 keys diagnose-path guidance on nothing else', async () => {
    const { agent, context } = setup('bad_key');
    const diagnosis = await agent.diagnose(context);
    expect(diagnosis.findings.map((f) => f.checkId)).toEqual([
      LLM_PROVIDER_CHECK_IDS.keyPresent,
      LLM_PROVIDER_CHECK_IDS.keyValid,
      LLM_PROVIDER_CHECK_IDS.quotaBilling,
      LLM_PROVIDER_CHECK_IDS.rateLimitHeadroom,
      LLM_PROVIDER_CHECK_IDS.modelDeprecated,
      LLM_PROVIDER_CHECK_IDS.providerStatus,
    ]);
  });

  it('tags the offline finding with a checkId too', async () => {
    const gate: OfflineGate = async () => ({ verdict: 'local', explanation: 'no network interface' });
    const { agent, context } = setup('bad_key', gate);
    const diagnosis = await agent.diagnose(context);
    expect(diagnosis.findings[0]!.checkId).toBe(LLM_PROVIDER_CHECK_IDS.providerStatus);
  });

  it('returns "unable" when the observer is offline', async () => {
    const gate: OfflineGate = async () => ({ verdict: 'local', explanation: 'this machine has no network interface with an address' });
    const { agent, context } = setup('bad_key', gate);
    const diagnosis = await agent.diagnose(context);
    expect(diagnosis.status).toBe('unable');
    expect(diagnosis.scenario).toBeNull();
    expect(diagnosis.findings[0]!.observation).toContain('no network interface');
  });
});
