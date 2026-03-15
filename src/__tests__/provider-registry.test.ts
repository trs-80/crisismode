// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { resolveStepProviders } from '../framework/provider-registry.js';
import { pgReplicationManifest } from '../agent/pg-replication/manifest.js';
import { redisMemoryManifest } from '../agent/redis/manifest.js';
import { PgSimulator } from '../agent/pg-replication/simulator.js';
import { PgLiveClient } from '../agent/pg-replication/live-client.js';
import { RedisSimulator } from '../agent/redis/simulator.js';
import type { ExecutionBackend } from '../framework/backend.js';
import type { SystemActionStep } from '../types/step-types.js';
import type { CapabilityProviderDescriptor } from '../types/plugin.js';

describe('resolveStepProviders', () => {
  it('resolves PostgreSQL SQL capabilities through the simulator provider', () => {
    const step: SystemActionStep = {
      stepId: 'step-001',
      type: 'system_action',
      name: 'Disconnect lagging replica',
      executionContext: 'postgresql_write',
      target: 'pg-primary',
      riskLevel: 'routine',
      requiredCapabilities: ['db.replica.disconnect'],
      command: {
        type: 'sql',
        statement: "SELECT pg_terminate_backend(pid) FROM pg_stat_replication WHERE client_addr = '10.0.1.52';",
      },
      statePreservation: { before: [], after: [] },
      successCriteria: {
        description: 'Replica is disconnected',
        check: { type: 'sql', expect: { operator: 'eq', value: 1 } },
      },
      blastRadius: {
        directComponents: ['pg-primary'],
        indirectComponents: [],
        maxImpact: 'low',
        cascadeRisk: 'low',
      },
      timeout: 'PT30S',
    };

    const resolution = resolveStepProviders(step, pgReplicationManifest, new PgSimulator(), 'execute');
    expect(resolution.resolved).toBe(true);
    expect(resolution.providers).toEqual(['postgresql-simulator-sql']);
    expect(resolution.capabilities).toEqual([
      {
        capability: 'db.replica.disconnect',
        resolved: true,
        providerId: 'postgresql-simulator-sql',
      },
    ]);
  });

  it('resolves traffic capabilities through the simulator load-balancer provider', () => {
    const step: SystemActionStep = {
      stepId: 'step-002',
      type: 'system_action',
      name: 'Detach replica from read traffic',
      executionContext: 'linux_process',
      target: 'load-balancer',
      riskLevel: 'routine',
      requiredCapabilities: ['traffic.backend.detach'],
      command: {
        type: 'structured_command',
        operation: 'config_reload',
        parameters: { service: 'load-balancer' },
      },
      statePreservation: { before: [], after: [] },
      successCriteria: {
        description: 'Backend no longer serves traffic',
        check: { type: 'structured_command', expect: { operator: 'eq', value: 'running' } },
      },
      blastRadius: {
        directComponents: ['load-balancer'],
        indirectComponents: [],
        maxImpact: 'low',
        cascadeRisk: 'low',
      },
      timeout: 'PT30S',
    };

    const resolution = resolveStepProviders(step, pgReplicationManifest, new PgSimulator(), 'execute');
    expect(resolution.resolved).toBe(true);
    expect(resolution.providers).toEqual(['simulated-load-balancer']);
    expect(resolution.capabilities[0]).toEqual({
      capability: 'traffic.backend.detach',
      resolved: true,
      providerId: 'simulated-load-balancer',
    });
  });

  it('reports unresolved capabilities when the live PostgreSQL backend has no matching provider', async () => {
    const step: SystemActionStep = {
      stepId: 'step-003',
      type: 'system_action',
      name: 'Detach replica from read traffic',
      executionContext: 'linux_process',
      target: 'load-balancer',
      riskLevel: 'routine',
      requiredCapabilities: ['traffic.backend.detach'],
      command: {
        type: 'structured_command',
        operation: 'config_reload',
        parameters: { service: 'load-balancer' },
      },
      statePreservation: { before: [], after: [] },
      successCriteria: {
        description: 'Backend no longer serves traffic',
        check: { type: 'structured_command', expect: { operator: 'eq', value: 'running' } },
      },
      blastRadius: {
        directComponents: ['load-balancer'],
        indirectComponents: [],
        maxImpact: 'low',
        cascadeRisk: 'low',
      },
      timeout: 'PT30S',
    };

    const backend = new PgLiveClient({
      host: '127.0.0.1',
      port: 5432,
      user: 'postgres',
      password: 'postgres',
      database: 'crisismode',
    });

    try {
      const resolution = resolveStepProviders(step, pgReplicationManifest, backend, 'execute');
      expect(resolution.resolved).toBe(false);
      expect(resolution.providers).toEqual([]);
      expect(resolution.capabilities[0]).toEqual({
        capability: 'traffic.backend.detach',
        resolved: false,
        reason: "no provider is registered for capability 'traffic.backend.detach'",
      });
    } finally {
      await backend.close();
    }
  });

  it('resolves Redis admin capabilities through the simulator provider', () => {
    const step: SystemActionStep = {
      stepId: 'step-004',
      type: 'system_action',
      name: 'Disconnect hot clients',
      executionContext: 'redis_admin',
      target: 'redis-primary',
      riskLevel: 'routine',
      requiredCapabilities: ['cache.client.disconnect'],
      command: {
        type: 'structured_command',
        operation: 'client_kill',
        parameters: { selector: 'normal' },
      },
      statePreservation: { before: [], after: [] },
      successCriteria: {
        description: 'Client pressure is reduced',
        check: { type: 'structured_command', expect: { operator: 'eq', value: 'running' } },
      },
      blastRadius: {
        directComponents: ['redis-primary'],
        indirectComponents: [],
        maxImpact: 'low',
        cascadeRisk: 'low',
      },
      timeout: 'PT30S',
    };

    const resolution = resolveStepProviders(step, redisMemoryManifest, new RedisSimulator(), 'execute');
    expect(resolution.resolved).toBe(true);
    expect(resolution.providers).toEqual(['redis-simulator-admin']);
    expect(resolution.capabilities[0]).toEqual({
      capability: 'cache.client.disconnect',
      resolved: true,
      providerId: 'redis-simulator-admin',
    });
  });

  it('reports unresolved capabilities when the only provider lacks execute-mode support', () => {
    const step: SystemActionStep = {
      stepId: 'step-005',
      type: 'system_action',
      name: 'Detach replica from read traffic',
      executionContext: 'linux_process',
      target: 'load-balancer',
      riskLevel: 'routine',
      requiredCapabilities: ['traffic.backend.detach'],
      command: {
        type: 'structured_command',
        operation: 'config_reload',
        parameters: { service: 'load-balancer' },
      },
      statePreservation: { before: [], after: [] },
      successCriteria: {
        description: 'Backend no longer serves traffic',
        check: { type: 'structured_command', expect: { operator: 'eq', value: 'running' } },
      },
      blastRadius: {
        directComponents: ['load-balancer'],
        indirectComponents: [],
        maxImpact: 'low',
        cascadeRisk: 'low',
      },
      timeout: 'PT30S',
    };

    const backend: ExecutionBackend = {
      executeCommand: async () => ({}),
      evaluateCheck: async () => true,
      close: async () => {},
      listCapabilityProviders: (): CapabilityProviderDescriptor[] => [
        {
          id: 'dry-run-only-balancer',
          kind: 'capability_provider' as const,
          name: 'Dry-run-only Balancer Provider',
          maturity: 'dry_run_only' as const,
          capabilities: ['traffic.backend.detach'],
          executionContexts: ['linux_process'],
          targetKinds: ['linux'],
          commandTypes: ['structured_command'],
          supportsDryRun: true,
          supportsExecute: false,
        },
      ],
    };

    const resolution = resolveStepProviders(step, pgReplicationManifest, backend, 'execute');
    expect(resolution.resolved).toBe(false);
    expect(resolution.capabilities[0]).toEqual({
      capability: 'traffic.backend.detach',
      resolved: false,
      reason: "registered providers for 'traffic.backend.detach' do not support execute mode",
    });
  });

  it('reports unresolved capabilities when the provider supports the wrong command type', () => {
    const step: SystemActionStep = {
      stepId: 'step-006',
      type: 'system_action',
      name: 'Detach replica from read traffic',
      executionContext: 'linux_process',
      target: 'load-balancer',
      riskLevel: 'routine',
      requiredCapabilities: ['traffic.backend.detach'],
      command: {
        type: 'structured_command',
        operation: 'config_reload',
        parameters: { service: 'load-balancer' },
      },
      statePreservation: { before: [], after: [] },
      successCriteria: {
        description: 'Backend no longer serves traffic',
        check: { type: 'structured_command', expect: { operator: 'eq', value: 'running' } },
      },
      blastRadius: {
        directComponents: ['load-balancer'],
        indirectComponents: [],
        maxImpact: 'low',
        cascadeRisk: 'low',
      },
      timeout: 'PT30S',
    };

    const backend: ExecutionBackend = {
      executeCommand: async () => ({}),
      evaluateCheck: async () => true,
      close: async () => {},
      listCapabilityProviders: (): CapabilityProviderDescriptor[] => [
        {
          id: 'sql-only-balancer',
          kind: 'capability_provider' as const,
          name: 'SQL-only Balancer Provider',
          maturity: 'live_validated' as const,
          capabilities: ['traffic.backend.detach'],
          executionContexts: ['linux_process'],
          targetKinds: ['linux'],
          commandTypes: ['sql'],
          supportsDryRun: true,
          supportsExecute: true,
        },
      ],
    };

    const resolution = resolveStepProviders(step, pgReplicationManifest, backend, 'execute');
    expect(resolution.resolved).toBe(false);
    expect(resolution.capabilities[0]).toEqual({
      capability: 'traffic.backend.detach',
      resolved: false,
      reason: "no execute provider for 'traffic.backend.detach' supports command type 'structured_command'",
    });
  });
});
