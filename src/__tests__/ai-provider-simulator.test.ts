// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { AiProviderSimulator } from '../agent/ai-provider/simulator.js';

describe('AiProviderSimulator', () => {
  // ---------------------------------------------------------------------------
  // getProviderStatus()
  // ---------------------------------------------------------------------------
  describe('getProviderStatus()', () => {
    it('returns 3 providers in every state', async () => {
      const sim = new AiProviderSimulator();
      for (const state of ['provider_degraded', 'failover_active', 'stabilized'] as const) {
        sim.transition(state);
        const providers = await sim.getProviderStatus();
        expect(providers).toHaveLength(3);
      }
    });

    it('marks openai as degraded in provider_degraded state', async () => {
      const sim = new AiProviderSimulator();
      const providers = await sim.getProviderStatus();
      expect(providers[0].name).toBe('openai');
      expect(providers[0].status).toBe('degraded');
      expect(providers[1].status).toBe('healthy');
      expect(providers[2].status).toBe('healthy');
    });

    it('marks openai as down in failover_active state', async () => {
      const sim = new AiProviderSimulator();
      sim.transition('failover_active');
      const providers = await sim.getProviderStatus();
      expect(providers[0].status).toBe('down');
      expect(providers[0].errorRate).toBe(0.95);
    });

    it('marks all providers healthy in stabilized state', async () => {
      const sim = new AiProviderSimulator();
      sim.transition('stabilized');
      const providers = await sim.getProviderStatus();
      expect(providers.every((p) => p.status === 'healthy')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // getRequestMetrics()
  // ---------------------------------------------------------------------------
  describe('getRequestMetrics()', () => {
    it('returns low success rate in provider_degraded', async () => {
      const sim = new AiProviderSimulator();
      const metrics = await sim.getRequestMetrics();
      expect(metrics.successRate).toBe(0.65);
      expect(metrics.timeoutRate).toBe(0.22);
    });

    it('returns improved metrics in failover_active', async () => {
      const sim = new AiProviderSimulator();
      sim.transition('failover_active');
      const metrics = await sim.getRequestMetrics();
      expect(metrics.successRate).toBe(0.88);
      expect(metrics.timeoutRate).toBe(0.04);
    });

    it('returns near-perfect metrics in stabilized', async () => {
      const sim = new AiProviderSimulator();
      sim.transition('stabilized');
      const metrics = await sim.getRequestMetrics();
      expect(metrics.successRate).toBe(0.97);
      expect(metrics.timeoutRate).toBe(0.01);
    });
  });

  // ---------------------------------------------------------------------------
  // getCircuitBreakerState()
  // ---------------------------------------------------------------------------
  describe('getCircuitBreakerState()', () => {
    it('reports half_open for openai in provider_degraded', async () => {
      const sim = new AiProviderSimulator();
      const states = await sim.getCircuitBreakerState();
      expect(states[0].state).toBe('half_open');
      expect(states[1].state).toBe('closed');
    });

    it('reports open for openai in failover_active', async () => {
      const sim = new AiProviderSimulator();
      sim.transition('failover_active');
      const states = await sim.getCircuitBreakerState();
      expect(states[0].state).toBe('open');
      expect(states[0].failureCount).toBe(128);
    });

    it('reports all closed in stabilized', async () => {
      const sim = new AiProviderSimulator();
      sim.transition('stabilized');
      const states = await sim.getCircuitBreakerState();
      expect(states.every((s) => s.state === 'closed')).toBe(true);
      expect(states.every((s) => s.failureCount === 0)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // getFallbackConfig()
  // ---------------------------------------------------------------------------
  describe('getFallbackConfig()', () => {
    it('has all providers enabled in provider_degraded', async () => {
      const sim = new AiProviderSimulator();
      const config = await sim.getFallbackConfig();
      expect(config.chain.every((c) => c.enabled)).toBe(true);
    });

    it('disables openai in failover_active', async () => {
      const sim = new AiProviderSimulator();
      sim.transition('failover_active');
      const config = await sim.getFallbackConfig();
      expect(config.chain[0].enabled).toBe(false);
      expect(config.chain[1].enabled).toBe(true);
    });

    it('re-enables all in stabilized', async () => {
      const sim = new AiProviderSimulator();
      sim.transition('stabilized');
      const config = await sim.getFallbackConfig();
      expect(config.chain.every((c) => c.enabled)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // executeCommand()
  // ---------------------------------------------------------------------------
  describe('executeCommand()', () => {
    it('provider_health_check returns full status', async () => {
      const sim = new AiProviderSimulator();
      const result = await sim.executeCommand({ type: 'api_call', operation: 'provider_health_check' }) as Record<string, unknown>;
      expect(result).toHaveProperty('providers');
      expect(result).toHaveProperty('metrics');
      expect(result).toHaveProperty('circuitBreakers');
      expect(result).toHaveProperty('fallbackConfig');
    });

    it('trip_circuit_breaker transitions to failover_active', async () => {
      const sim = new AiProviderSimulator();
      const result = await sim.executeCommand({
        type: 'api_call',
        operation: 'trip_circuit_breaker',
        parameters: { provider: 'openai' },
      }) as Record<string, unknown>;
      expect(result.tripped).toBe(true);
      // Verify state changed
      const providers = await sim.getProviderStatus();
      expect(providers[0].status).toBe('down');
    });

    it('activate_fallback_chain transitions to failover_active', async () => {
      const sim = new AiProviderSimulator();
      const result = await sim.executeCommand({ type: 'api_call', operation: 'activate_fallback_chain' }) as Record<string, unknown>;
      expect(result.activated).toBe(true);
      expect(result.activeProviders).toEqual(['anthropic', 'google']);
    });

    it('verify_routing returns openai as active in provider_degraded', async () => {
      const sim = new AiProviderSimulator();
      const result = await sim.executeCommand({ type: 'api_call', operation: 'verify_routing' }) as Record<string, unknown>;
      expect(result.activeProvider).toBe('openai');
    });

    it('verify_routing returns anthropic as active in failover_active', async () => {
      const sim = new AiProviderSimulator();
      sim.transition('failover_active');
      const result = await sim.executeCommand({ type: 'api_call', operation: 'verify_routing' }) as Record<string, unknown>;
      expect(result.activeProvider).toBe('anthropic');
    });

    it('restore_primary transitions to stabilized', async () => {
      const sim = new AiProviderSimulator();
      sim.transition('failover_active');
      const result = await sim.executeCommand({ type: 'api_call', operation: 'restore_primary' }) as Record<string, unknown>;
      expect(result.restored).toBe(true);
      const providers = await sim.getProviderStatus();
      expect(providers[0].status).toBe('healthy');
    });

    it('unknown operation returns simulated: true', async () => {
      const sim = new AiProviderSimulator();
      const result = await sim.executeCommand({ type: 'api_call', operation: 'unknown_op' }) as Record<string, unknown>;
      expect(result.simulated).toBe(true);
      expect(result.operation).toBe('unknown_op');
    });

    it('throws on non-api_call command type', async () => {
      const sim = new AiProviderSimulator();
      await expect(sim.executeCommand({ type: 'sql', operation: 'test' }))
        .rejects.toThrow('Unsupported AI provider simulator command type: sql');
    });
  });

  // ---------------------------------------------------------------------------
  // evaluateCheck()
  // ---------------------------------------------------------------------------
  describe('evaluateCheck()', () => {
    it('evaluates provider_ping check', async () => {
      const sim = new AiProviderSimulator();
      const result = await sim.evaluateCheck({
        type: 'check',
        statement: 'provider_ping',
        expect: { operator: 'eq', value: 'ok' },
      });
      expect(result).toBe(true);
    });

    it('evaluates p95_latency check', async () => {
      const sim = new AiProviderSimulator();
      // provider_degraded: p95 = 18500
      const result = await sim.evaluateCheck({
        type: 'check',
        statement: 'p95_latency',
        expect: { operator: 'lt', value: 20000 },
      });
      expect(result).toBe(true);
    });

    it('evaluates error_rate check (uses successRate)', async () => {
      const sim = new AiProviderSimulator();
      // provider_degraded: successRate = 0.65
      const result = await sim.evaluateCheck({
        type: 'check',
        statement: 'error_rate',
        expect: { operator: 'gte', value: 0.5 },
      });
      expect(result).toBe(true);
    });

    it('evaluates timeout_rate check', async () => {
      const sim = new AiProviderSimulator();
      // provider_degraded: timeoutRate = 0.22
      const result = await sim.evaluateCheck({
        type: 'check',
        statement: 'timeout_rate',
        expect: { operator: 'gt', value: 0.1 },
      });
      expect(result).toBe(true);
    });

    it('evaluates circuit_breaker_open check', async () => {
      const sim = new AiProviderSimulator();
      sim.transition('failover_active');
      // failover_active: 1 open circuit breaker
      const result = await sim.evaluateCheck({
        type: 'check',
        statement: 'circuit_breaker_open',
        expect: { operator: 'eq', value: 1 },
      });
      expect(result).toBe(true);
    });

    it('evaluates fallback_active check', async () => {
      const sim = new AiProviderSimulator();
      sim.transition('failover_active');
      // failover_active: primary disabled, so !primaryEnabled = true
      const result = await sim.evaluateCheck({
        type: 'check',
        statement: 'fallback_active',
        expect: { operator: 'eq', value: 'true' },
      });
      expect(result).toBe(true);
    });

    it('returns true for unknown statement', async () => {
      const sim = new AiProviderSimulator();
      const result = await sim.evaluateCheck({
        type: 'check',
        statement: 'unknown_check',
        expect: { operator: 'eq', value: 'anything' },
      });
      expect(result).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // listCapabilityProviders() & close()
  // ---------------------------------------------------------------------------
  describe('listCapabilityProviders()', () => {
    it('returns 2 providers', () => {
      const sim = new AiProviderSimulator();
      const providers = sim.listCapabilityProviders();
      expect(providers).toHaveLength(2);
      expect(providers[0].id).toBe('ai-provider-simulator-read');
      expect(providers[1].id).toBe('ai-provider-simulator-write');
    });
  });

  describe('close()', () => {
    it('resolves without error', async () => {
      const sim = new AiProviderSimulator();
      await expect(sim.close()).resolves.toBeUndefined();
    });
  });
});
