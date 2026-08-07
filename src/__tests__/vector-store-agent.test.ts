// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect, vi } from 'vitest';
import { VectorStoreAgent } from '../agent/vector-store/agent.js';
import { VectorStoreSimulator, SIMULATOR_FIXTURE_KEY } from '../agent/vector-store/simulator.js';
import { vectorStoreManifest } from '../agent/vector-store/manifest.js';
import { vectorStoreRegistration } from '../agent/vector-store/registration.js';
import { builtinAgents } from '../config/builtin-agents.js';
import { assembleContext } from '../framework/context.js';
import { validateAgent } from '../framework/agent-test-harness.js';
import { isKnownCapability } from '../framework/capability-registry.js';
import { explainSource } from '../framework/signal-explanations.js';
import { VECTOR_STORE_CHECK_IDS } from '../agent/vector-store/check-ids.js';
import type { OfflineGate } from '../agent/llm-provider/offline-gate.js';
import type { AgentContext } from '../types/agent-context.js';

function context(): AgentContext {
  return assembleContext(
    {
      type: 'health_check',
      source: 'cli-scan',
      payload: { alertname: 'vector-storeScanCheck', instance: 'derived-vector-store', severity: 'info' },
      receivedAt: new Date().toISOString(),
    },
    vectorStoreManifest,
  );
}

/** Default gate returns null — "triage saw nothing", so the checks run. */
function agentWith(scenario: string, gate: OfflineGate = async () => null): VectorStoreAgent {
  const backend = new VectorStoreSimulator();
  backend.transition(scenario);
  return new VectorStoreAgent(backend, gate);
}

describe('vectorStoreManifest', () => {
  it('is a routine, read-only agent', () => {
    expect(vectorStoreManifest.spec.riskProfile.maxRiskLevel).toBe('routine');
    expect(vectorStoreManifest.spec.riskProfile.dataLossPossible).toBe(false);
    expect(vectorStoreManifest.spec.riskProfile.serviceDisruptionPossible).toBe(false);
  });

  it('declares a maturity value (PR 1 visibility contract)', () => {
    expect(vectorStoreManifest.metadata.plugin.maturity).toBe('simulator_only');
  });

  it('declares only read execution contexts', () => {
    for (const ec of vectorStoreManifest.spec.executionContexts) {
      expect(ec.privilege).toBe('read');
    }
  });

  it('uses a capability registered in the global registry', () => {
    expect(isKnownCapability('vectorstore.index.read')).toBe(true);
  });
});

describe('signal explanations', () => {
  // explanation-coverage.test.ts enforces this across every built-in agent;
  // asserting it here too means the agent's own test fails first, next to the
  // sources it names, rather than in a file the implementer is not editing.
  it('every emitted signal source resolves to a knowledge-map entry', () => {
    for (const source of ['vector_store_reachable', 'vector_store_auth', 'vector_store_index']) {
      expect(explainSource(source), `no EXPLANATIONS entry matches '${source}'`).toBeDefined();
    }
  });
});

describe('VectorStoreAgent.assessHealth', () => {
  it('healthy when every check passes', async () => {
    const health = await agentWith('healthy').assessHealth(context());
    expect(health.status).toBe('healthy');
  });

  it('unhealthy when the key is rejected', async () => {
    const health = await agentWith('bad_key').assessHealth(context());
    expect(health.status).toBe('unhealthy');
    expect(health.summary).toContain('pinecone');
  });

  it('unhealthy when the store is unreachable', async () => {
    const health = await agentWith('unreachable').assessHealth(context());
    expect(health.status).toBe('unhealthy');
  });

  it('recovering when an index exists but is not ready', async () => {
    const health = await agentWith('index_not_ready').assessHealth(context());
    expect(health.status).toBe('recovering');
  });

  it('stamps every signal with its checkId', async () => {
    const health = await agentWith('healthy').assessHealth(context());
    expect(health.signals.map((s) => s.checkId)).toEqual([
      VECTOR_STORE_CHECK_IDS.reachable,
      VECTOR_STORE_CHECK_IDS.authValid,
      VECTOR_STORE_CHECK_IDS.indexStatus,
    ]);
  });

  it('never leaks key material into health output', async () => {
    const health = await agentWith('bad_key').assessHealth(context());
    expect(JSON.stringify(health)).not.toContain(SIMULATOR_FIXTURE_KEY);
  });
});

describe('VectorStoreAgent offline deferral', () => {
  const localVerdict: OfflineGate = async () => ({
    verdict: 'local',
    explanation: 'this machine has no network interface with an address',
  });

  it("reports unknown and repeats triage's explanation rather than 'the store is down'", async () => {
    const health = await agentWith('unreachable', localVerdict).assessHealth(context());
    expect(health.status).toBe('unknown');
    for (const signal of health.signals) {
      expect(signal.status).toBe('unknown');
      expect(signal.detail).toContain('this machine has no network interface with an address');
    }
    expect(health.summary).not.toContain('unavailable');
  });

  it('still carries every checkId when deferring, so guidance still resolves', async () => {
    const health = await agentWith('unreachable', localVerdict).assessHealth(context());
    expect(health.signals.map((s) => s.checkId)).toEqual([
      VECTOR_STORE_CHECK_IDS.reachable,
      VECTOR_STORE_CHECK_IDS.authValid,
      VECTOR_STORE_CHECK_IDS.indexStatus,
    ]);
  });

  it('does not touch the backend when the gate fires', async () => {
    const backend = new VectorStoreSimulator();
    const probe = vi.spyOn(backend, 'queryVectorStores');
    await new VectorStoreAgent(backend, localVerdict).assessHealth(context());
    expect(probe).not.toHaveBeenCalled();
  });

  it('a null verdict is not evidence of being offline — the checks run', async () => {
    const health = await agentWith('healthy', async () => null).assessHealth(context());
    expect(health.status).toBe('healthy');
  });
});

describe('VectorStoreAgent.diagnose', () => {
  it('identifies a rejected key with a critical finding', async () => {
    const diagnosis = await agentWith('bad_key').diagnose(context());
    expect(diagnosis.status).toBe('identified');
    expect(diagnosis.scenario).toBe('auth_rejected');
    expect(diagnosis.findings.some((f) => f.severity === 'critical')).toBe(true);
  });

  it('is inconclusive when everything is healthy', async () => {
    const diagnosis = await agentWith('healthy').diagnose(context());
    expect(diagnosis.status).toBe('inconclusive');
  });
});

describe('VectorStoreAgent.plan', () => {
  it('produces a read-only plan with a rollback strategy and no mutations', async () => {
    const agent = agentWith('bad_key');
    const ctx = context();
    const plan = await agent.plan(ctx, await agent.diagnose(ctx));
    expect(plan.rollbackStrategy).toBeDefined();
    expect(plan.steps.some((s) => s.type === 'system_action')).toBe(false);
    expect(new Set(plan.steps.map((s) => s.stepId)).size).toBe(plan.steps.length);
  });
});

describe('agent test harness', () => {
  it('passes contract validation', async () => {
    const result = await validateAgent(agentWith('bad_key'), context());
    expect(result.passed).toBe(true);
  });
});

describe('registration', () => {
  it('is registered as a built-in agent', () => {
    expect(builtinAgents.map((r) => r.kind)).toContain('vector-store');
  });

  it("name matches the manifest's metadata name", () => {
    expect(vectorStoreRegistration.name).toBe(vectorStoreManifest.metadata.name);
  });

  it('a simulator target gets the simulator backend', async () => {
    const instance = await vectorStoreRegistration.createAgent({
      name: 'sim', kind: 'vector-store', primary: { host: 'simulator', port: 0 },
    } as never);
    expect(instance.backend).toBeInstanceOf(VectorStoreSimulator);
    await instance.backend.close();
  });
});
