// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, vi } from 'vitest';
import { ServiceStatusAgent } from '../agent/service-status/agent.js';
import { ServiceStatusSimulator } from '../agent/service-status/simulator.js';
import type { ServiceStatusScenario } from '../agent/service-status/simulator.js';
import { serviceStatusManifest } from '../agent/service-status/manifest.js';
import { serviceStatusRegistration } from '../agent/service-status/registration.js';
import { SERVICE_STATUS_CHECK_IDS } from '../agent/service-status/check-ids.js';
import { builtinAgents } from '../config/builtin-agents.js';
import { assembleContext } from '../framework/context.js';
import { validateAgent } from '../framework/agent-test-harness.js';
import { isKnownCapability } from '../framework/capability-registry.js';
import { explainSource } from '../framework/signal-explanations.js';
import type { OfflineGate } from '../framework/offline-gate.js';
import type { AgentContext } from '../types/agent-context.js';

function context(): AgentContext {
  return assembleContext(
    {
      type: 'health_check',
      source: 'cli-scan',
      payload: { alertname: 'service-statusScanCheck', instance: 'stripe', severity: 'info' },
      receivedAt: new Date().toISOString(),
    },
    serviceStatusManifest,
  );
}

/** Default gate returns null — "triage saw nothing", so the checks run. */
function agentWith(scenario: ServiceStatusScenario, gate: OfflineGate = async () => null): ServiceStatusAgent {
  const backend = new ServiceStatusSimulator();
  backend.transition(scenario);
  return new ServiceStatusAgent(backend, gate);
}

describe('serviceStatusManifest', () => {
  it('is a routine, read-only agent', () => {
    expect(serviceStatusManifest.spec.riskProfile.maxRiskLevel).toBe('routine');
    expect(serviceStatusManifest.spec.riskProfile.dataLossPossible).toBe(false);
    expect(serviceStatusManifest.spec.riskProfile.serviceDisruptionPossible).toBe(false);
  });

  it('declares a maturity value (visibility contract)', () => {
    expect(serviceStatusManifest.metadata.plugin.maturity).toBe('simulator_only');
  });

  it('declares exactly one, read-only execution context with no capabilities', () => {
    expect(serviceStatusManifest.spec.executionContexts).toHaveLength(1);
    const [ec] = serviceStatusManifest.spec.executionContexts;
    expect(ec?.name).toBe('service_status_read');
    expect(ec?.privilege).toBe('read');
    expect(ec?.allowedOperations).toEqual(['query_services']);
    expect(ec?.capabilities).toEqual([]);
  });

  it('registers in builtinAgents under kind service-status', () => {
    expect(builtinAgents).toContain(serviceStatusRegistration);
    expect(serviceStatusRegistration.kind).toBe('service-status');
  });
});

describe('signal explanations', () => {
  // explanation-coverage.test.ts enforces this across every built-in agent;
  // asserting it here too means the agent's own test fails first, next to the
  // sources it names, rather than in a file the implementer is not editing.
  it('every emitted signal source resolves to a knowledge-map entry', () => {
    for (const source of ['service_status_page', 'service_reachability']) {
      expect(explainSource(source), `no EXPLANATIONS entry matches '${source}'`).toBeDefined();
    }
  });

  it('uses a capability registered in the global registry — none, by design', () => {
    // service-status declares capabilities: [] — there is nothing new to
    // register, but isKnownCapability must not choke on an empty check.
    for (const ec of serviceStatusManifest.spec.executionContexts) {
      for (const capability of ec.capabilities ?? []) {
        expect(isKnownCapability(capability)).toBe(true);
      }
    }
  });
});

describe('ServiceStatusAgent.assessHealth', () => {
  it('healthy when the status page and reachability both check out', async () => {
    const health = await agentWith('healthy').assessHealth(context());
    expect(health.status).toBe('healthy');
  });

  it('unhealthy on a confirmed incident', async () => {
    const health = await agentWith('incident').assessHealth(context());
    expect(health.status).toBe('unhealthy');
    expect(health.summary).toContain('Stripe');
  });

  it('recovering when the provider reports degraded performance', async () => {
    const health = await agentWith('degraded').assessHealth(context());
    expect(health.status).toBe('recovering');
  });

  it('unhealthy when this machine cannot reach a service the provider says is fine', async () => {
    const health = await agentWith('down_for_you').assessHealth(context());
    expect(health.status).toBe('unhealthy');
  });

  it('unhealthy when neither the status page nor reachability could be confirmed', async () => {
    const health = await agentWith('status_unavailable').assessHealth(context());
    expect(health.status).toBe('unhealthy');
  });

  it('stamps every signal with its checkId', async () => {
    const health = await agentWith('healthy').assessHealth(context());
    expect(health.signals.map((s) => s.checkId)).toEqual([
      SERVICE_STATUS_CHECK_IDS.statusPage,
      SERVICE_STATUS_CHECK_IDS.reachability,
    ]);
  });
});

describe('ServiceStatusAgent.diagnose — honesty split', () => {
  it('emits two findings per service: one for the status page, one for reachability', async () => {
    const diagnosis = await agentWith('healthy').diagnose(context());
    expect(diagnosis.findings).toHaveLength(2);
    expect(diagnosis.findings.map((f) => f.source)).toEqual(['service_status_page', 'service_reachability']);
    expect(diagnosis.findings.map((f) => f.checkId)).toEqual([
      SERVICE_STATUS_CHECK_IDS.statusPage,
      SERVICE_STATUS_CHECK_IDS.reachability,
    ]);
  });

  it('a down_for_you verdict keeps the status-page finding info-severity — the provider itself reported clean', async () => {
    const diagnosis = await agentWith('down_for_you').diagnose(context());
    const statusFinding = diagnosis.findings.find((f) => f.source === 'service_status_page');
    const reachabilityFinding = diagnosis.findings.find((f) => f.source === 'service_reachability');
    expect(statusFinding?.severity).toBe('info');
    expect(reachabilityFinding?.severity).toBe('critical');
  });

  it('scenario is null (not a fabricated failure) when every service is healthy', async () => {
    const diagnosis = await agentWith('healthy').diagnose(context());
    expect(diagnosis.scenario).toBeNull();
    expect(diagnosis.status).toBe('inconclusive');
  });

  it.each([
    ['incident', 'dependency_incident'],
    ['degraded', 'dependency_degraded'],
    ['down_for_you', 'dependency_unreachable'],
    ['status_unavailable', 'dependency_unreachable'],
  ] as const)('scenario for simulator state %s is %s', async (state, scenario) => {
    const diagnosis = await agentWith(state).diagnose(context());
    expect(diagnosis.scenario).toBe(scenario);
    expect(diagnosis.status).toBe('identified');
  });
});

describe('ServiceStatusAgent offline deferral', () => {
  const localVerdict: OfflineGate = async () => ({
    verdict: 'local',
    explanation: 'this machine has no network interface with an address',
  });

  it("reports unknown and repeats triage's explanation rather than blaming the provider", async () => {
    const health = await agentWith('down_for_you', localVerdict).assessHealth(context());
    expect(health.status).toBe('unknown');
    for (const signal of health.signals) {
      expect(signal.status).toBe('unknown');
      expect(signal.detail).toContain('this machine has no network interface with an address');
    }
  });

  it('still carries every checkId when deferring, so guidance still resolves', async () => {
    const health = await agentWith('down_for_you', localVerdict).assessHealth(context());
    expect(health.signals.map((s) => s.checkId)).toEqual([
      SERVICE_STATUS_CHECK_IDS.statusPage,
      SERVICE_STATUS_CHECK_IDS.reachability,
    ]);
  });

  it('does not touch the backend when the gate fires', async () => {
    const backend = new ServiceStatusSimulator();
    const probe = vi.spyOn(backend, 'queryServices');
    await new ServiceStatusAgent(backend, localVerdict).assessHealth(context());
    expect(probe).not.toHaveBeenCalled();
  });

  it('diagnose defers with a null scenario and does not touch the backend either', async () => {
    const backend = new ServiceStatusSimulator();
    const probe = vi.spyOn(backend, 'queryServices');
    const diagnosis = await new ServiceStatusAgent(backend, localVerdict).diagnose(context());
    expect(diagnosis.scenario).toBeNull();
    expect(diagnosis.status).toBe('unable');
    expect(probe).not.toHaveBeenCalled();
  });

  it('a null verdict from the gate is not evidence of being offline — the checks run', async () => {
    const health = await agentWith('healthy', async () => null).assessHealth(context());
    expect(health.status).toBe('healthy');
  });
});

describe('ServiceStatusAgent contract harness', () => {
  it('passes the generic RecoveryAgent contract for a non-healthy scenario', async () => {
    const result = await validateAgent(agentWith('incident'), context());
    const failures = result.checks.filter((c) => !c.passed);
    expect(failures).toEqual([]);
    expect(result.passed).toBe(true);
  });
});
