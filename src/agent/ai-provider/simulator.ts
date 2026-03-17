// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type {
  AiProviderBackend,
  ProviderStatus,
  RequestMetrics,
  CircuitBreakerState,
  FallbackConfig,
} from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';

export type SimulatorState = 'provider_degraded' | 'failover_active' | 'stabilized';

export class AiProviderSimulator implements AiProviderBackend {
  private state: SimulatorState = 'provider_degraded';

  transition(to: string): void {
    this.state = to as SimulatorState;
  }

  async getProviderStatus(): Promise<ProviderStatus[]> {
    const now = new Date().toISOString();

    switch (this.state) {
      case 'provider_degraded':
        return [
          {
            name: 'openai',
            endpoint: 'https://api.openai.com/v1',
            status: 'degraded',
            latencyMs: 12_500,
            errorRate: 0.35,
            lastChecked: now,
          },
          {
            name: 'anthropic',
            endpoint: 'https://api.anthropic.com/v1',
            status: 'healthy',
            latencyMs: 280,
            errorRate: 0.01,
            lastChecked: now,
          },
          {
            name: 'google',
            endpoint: 'https://generativelanguage.googleapis.com/v1',
            status: 'healthy',
            latencyMs: 350,
            errorRate: 0.02,
            lastChecked: now,
          },
        ];
      case 'failover_active':
        return [
          {
            name: 'openai',
            endpoint: 'https://api.openai.com/v1',
            status: 'down',
            latencyMs: 30_000,
            errorRate: 0.95,
            lastChecked: now,
          },
          {
            name: 'anthropic',
            endpoint: 'https://api.anthropic.com/v1',
            status: 'healthy',
            latencyMs: 310,
            errorRate: 0.02,
            lastChecked: now,
          },
          {
            name: 'google',
            endpoint: 'https://generativelanguage.googleapis.com/v1',
            status: 'healthy',
            latencyMs: 380,
            errorRate: 0.03,
            lastChecked: now,
          },
        ];
      case 'stabilized':
        return [
          {
            name: 'openai',
            endpoint: 'https://api.openai.com/v1',
            status: 'healthy',
            latencyMs: 450,
            errorRate: 0.03,
            lastChecked: now,
          },
          {
            name: 'anthropic',
            endpoint: 'https://api.anthropic.com/v1',
            status: 'healthy',
            latencyMs: 290,
            errorRate: 0.01,
            lastChecked: now,
          },
          {
            name: 'google',
            endpoint: 'https://generativelanguage.googleapis.com/v1',
            status: 'healthy',
            latencyMs: 340,
            errorRate: 0.02,
            lastChecked: now,
          },
        ];
    }
  }

  async getRequestMetrics(): Promise<RequestMetrics> {
    switch (this.state) {
      case 'provider_degraded':
        return {
          totalRequests: 45_200,
          successRate: 0.65,
          avgLatencyMs: 8_400,
          p50LatencyMs: 6_200,
          p95LatencyMs: 18_500,
          p99LatencyMs: 28_000,
          timeoutRate: 0.22,
        };
      case 'failover_active':
        return {
          totalRequests: 42_800,
          successRate: 0.88,
          avgLatencyMs: 1_200,
          p50LatencyMs: 340,
          p95LatencyMs: 2_800,
          p99LatencyMs: 4_500,
          timeoutRate: 0.04,
        };
      case 'stabilized':
        return {
          totalRequests: 48_100,
          successRate: 0.97,
          avgLatencyMs: 380,
          p50LatencyMs: 310,
          p95LatencyMs: 680,
          p99LatencyMs: 1_200,
          timeoutRate: 0.01,
        };
    }
  }

  async getCircuitBreakerState(): Promise<CircuitBreakerState[]> {
    switch (this.state) {
      case 'provider_degraded':
        return [
          { provider: 'openai', state: 'half_open', failureCount: 47, lastFailure: new Date().toISOString() },
          { provider: 'anthropic', state: 'closed', failureCount: 0, lastFailure: null },
          { provider: 'google', state: 'closed', failureCount: 0, lastFailure: null },
        ];
      case 'failover_active':
        return [
          { provider: 'openai', state: 'open', failureCount: 128, lastFailure: new Date().toISOString() },
          { provider: 'anthropic', state: 'closed', failureCount: 0, lastFailure: null },
          { provider: 'google', state: 'closed', failureCount: 0, lastFailure: null },
        ];
      case 'stabilized':
        return [
          { provider: 'openai', state: 'closed', failureCount: 0, lastFailure: null },
          { provider: 'anthropic', state: 'closed', failureCount: 0, lastFailure: null },
          { provider: 'google', state: 'closed', failureCount: 0, lastFailure: null },
        ];
    }
  }

  async getFallbackConfig(): Promise<FallbackConfig> {
    switch (this.state) {
      case 'provider_degraded':
        return {
          chain: [
            { provider: 'openai', priority: 1, enabled: true },
            { provider: 'anthropic', priority: 2, enabled: true },
            { provider: 'google', priority: 3, enabled: true },
          ],
        };
      case 'failover_active':
        return {
          chain: [
            { provider: 'openai', priority: 1, enabled: false },
            { provider: 'anthropic', priority: 2, enabled: true },
            { provider: 'google', priority: 3, enabled: true },
          ],
        };
      case 'stabilized':
        return {
          chain: [
            { provider: 'openai', priority: 1, enabled: true },
            { provider: 'anthropic', priority: 2, enabled: true },
            { provider: 'google', priority: 3, enabled: true },
          ],
        };
    }
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'api_call') {
      throw new Error(`Unsupported AI provider simulator command type: ${command.type}`);
    }

    switch (command.operation) {
      case 'provider_health_check':
        return {
          providers: await this.getProviderStatus(),
          metrics: await this.getRequestMetrics(),
          circuitBreakers: await this.getCircuitBreakerState(),
          fallbackConfig: await this.getFallbackConfig(),
        };
      case 'trip_circuit_breaker':
        this.transition('failover_active');
        return { tripped: true, provider: command.parameters?.provider };
      case 'activate_fallback_chain':
        this.transition('failover_active');
        return { activated: true, activeProviders: ['anthropic', 'google'] };
      case 'verify_routing':
        return {
          activeProvider: this.state === 'provider_degraded' ? 'openai' : 'anthropic',
          requestsRouted: true,
          metrics: await this.getRequestMetrics(),
        };
      case 'restore_primary':
        this.transition('stabilized');
        return { restored: true, provider: 'openai' };
      default:
        return { simulated: true, operation: command.operation, parameters: command.parameters };
    }
  }

  async evaluateCheck(check: CheckExpression): Promise<boolean> {
    const stmt = check.statement ?? '';

    if (stmt === 'provider_ping') {
      return this.compare('ok', check.expect.operator, check.expect.value);
    }

    if (stmt.includes('p95_latency')) {
      const metrics = await this.getRequestMetrics();
      return this.compare(metrics.p95LatencyMs, check.expect.operator, check.expect.value);
    }

    if (stmt.includes('error_rate')) {
      const metrics = await this.getRequestMetrics();
      return this.compare(metrics.successRate, check.expect.operator, check.expect.value);
    }

    if (stmt.includes('timeout_rate')) {
      const metrics = await this.getRequestMetrics();
      return this.compare(metrics.timeoutRate, check.expect.operator, check.expect.value);
    }

    if (stmt.includes('circuit_breaker_open')) {
      const states = await this.getCircuitBreakerState();
      const openCount = states.filter((s) => s.state === 'open').length;
      return this.compare(openCount, check.expect.operator, check.expect.value);
    }

    if (stmt.includes('fallback_active')) {
      const config = await this.getFallbackConfig();
      const primaryEnabled = config.chain.find((c) => c.priority === 1)?.enabled ?? true;
      return this.compare(!primaryEnabled, check.expect.operator, check.expect.value);
    }

    return true;
  }

  listCapabilityProviders(): CapabilityProviderDescriptor[] {
    return [
      {
        id: 'ai-provider-simulator-read',
        kind: 'capability_provider',
        name: 'AI Provider Simulator Read Provider',
        maturity: 'simulator_only',
        capabilities: ['provider.status.read', 'provider.metrics.read'],
        executionContexts: ['provider_read'],
        targetKinds: ['ai-provider'],
        commandTypes: ['api_call'],
        supportsDryRun: true,
        supportsExecute: true,
      },
      {
        id: 'ai-provider-simulator-write',
        kind: 'capability_provider',
        name: 'AI Provider Simulator Write Provider',
        maturity: 'simulator_only',
        capabilities: ['provider.circuit_breaker.trip', 'provider.fallback.activate', 'provider.traffic.shift'],
        executionContexts: ['provider_write'],
        targetKinds: ['ai-provider'],
        commandTypes: ['api_call'],
        supportsDryRun: true,
        supportsExecute: true,
      },
    ];
  }

  async close(): Promise<void> {}

  private compare(actual: unknown, operator: string, expected: unknown): boolean {
    const a = Number(actual);
    const e = Number(expected);

    if (Number.isNaN(a) || Number.isNaN(e)) {
      const sa = String(actual);
      const se = String(expected);
      switch (operator) {
        case 'eq': return sa === se;
        case 'neq': return sa !== se;
        default: return false;
      }
    }

    switch (operator) {
      case 'eq': return a === e;
      case 'neq': return a !== e;
      case 'gt': return a > e;
      case 'gte': return a >= e;
      case 'lt': return a < e;
      case 'lte': return a <= e;
      default: return false;
    }
  }
}
