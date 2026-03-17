// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * AiProviderLiveClient — probes real AI provider status/health endpoints
 * to assess availability, latency, and error rates.
 *
 * Sends lightweight requests (model list or small completion) to each
 * configured provider to determine live health.
 */

import type {
  AiProviderBackend,
  ProviderStatus,
  RequestMetrics,
  CircuitBreakerState,
  FallbackConfig,
} from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';

export interface ProviderEndpointConfig {
  name: string;
  /** The base API URL to probe */
  endpoint: string;
  /** Health-check path appended to endpoint (e.g. '/models' for OpenAI) */
  healthPath: string;
  /** API key for authentication */
  apiKey: string;
  /** Header name for the API key (default: 'Authorization') */
  authHeader?: string;
  /** Auth prefix (default: 'Bearer') */
  authPrefix?: string;
  /** Priority in fallback chain (lower = higher priority) */
  priority: number;
  /** Whether this provider is enabled in the fallback chain */
  enabled: boolean;
}

export interface AiProviderLiveConfig {
  providers: ProviderEndpointConfig[];
  /** Request timeout in milliseconds (default: 10000) */
  timeoutMs?: number;
  /** Number of recent requests to track for metrics (default: 100) */
  metricsWindowSize?: number;
}

interface ProbeResult {
  latencyMs: number;
  success: boolean;
  statusCode: number;
}

export class AiProviderLiveClient implements AiProviderBackend {
  private readonly config: AiProviderLiveConfig;
  private readonly timeoutMs: number;

  // Simple in-memory circuit breaker state
  private circuitBreakers: Map<string, { state: CircuitBreakerState['state']; failureCount: number; lastFailure: string | null }>;
  // Request history for metrics
  private requestHistory: Array<{ provider: string; latencyMs: number; success: boolean; timestamp: number }>;
  private readonly metricsWindowSize: number;

  constructor(config: AiProviderLiveConfig) {
    this.config = config;
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.metricsWindowSize = config.metricsWindowSize ?? 100;
    this.circuitBreakers = new Map();
    this.requestHistory = [];

    for (const p of config.providers) {
      this.circuitBreakers.set(p.name, { state: 'closed', failureCount: 0, lastFailure: null });
    }
  }

  private async probeProvider(provider: ProviderEndpointConfig): Promise<ProbeResult> {
    const url = `${provider.endpoint}${provider.healthPath}`;
    const headerName = provider.authHeader ?? 'Authorization';
    const prefix = provider.authPrefix ?? 'Bearer';

    const start = Date.now();
    try {
      const response = await fetch(url, {
        headers: { [headerName]: `${prefix} ${provider.apiKey}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const latencyMs = Date.now() - start;
      return { latencyMs, success: response.ok, statusCode: response.status };
    } catch {
      return { latencyMs: Date.now() - start, success: false, statusCode: 0 };
    }
  }

  private updateCircuitBreaker(name: string, success: boolean): void {
    const cb = this.circuitBreakers.get(name);
    if (!cb) return;

    if (success) {
      if (cb.state === 'half_open') {
        cb.state = 'closed';
        cb.failureCount = 0;
      } else if (cb.state === 'closed') {
        cb.failureCount = Math.max(0, cb.failureCount - 1);
      }
    } else {
      cb.failureCount++;
      cb.lastFailure = new Date().toISOString();
      if (cb.failureCount >= 5 && cb.state === 'closed') {
        cb.state = 'half_open';
      }
      if (cb.failureCount >= 10) {
        cb.state = 'open';
      }
    }
  }

  private recordRequest(provider: string, latencyMs: number, success: boolean): void {
    this.requestHistory.push({ provider, latencyMs, success, timestamp: Date.now() });
    if (this.requestHistory.length > this.metricsWindowSize * 3) {
      this.requestHistory = this.requestHistory.slice(-this.metricsWindowSize);
    }
  }

  async getProviderStatus(): Promise<ProviderStatus[]> {
    const results = await Promise.allSettled(
      this.config.providers.map(async (provider): Promise<ProviderStatus> => {
        const probe = await this.probeProvider(provider);
        this.updateCircuitBreaker(provider.name, probe.success);
        this.recordRequest(provider.name, probe.latencyMs, probe.success);

        let status: ProviderStatus['status'] = 'healthy';
        if (!probe.success) {
          status = 'down';
        } else if (probe.latencyMs > 5_000) {
          status = 'degraded';
        }

        const recentRequests = this.requestHistory.filter((r) => r.provider === provider.name);
        const errorRate = recentRequests.length > 0
          ? recentRequests.filter((r) => !r.success).length / recentRequests.length
          : 0;

        return {
          name: provider.name,
          endpoint: provider.endpoint,
          status,
          latencyMs: probe.latencyMs,
          errorRate,
          lastChecked: new Date().toISOString(),
        };
      }),
    );

    return results.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : {
            name: this.config.providers[i].name,
            endpoint: this.config.providers[i].endpoint,
            status: 'down' as const,
            latencyMs: 0,
            errorRate: 1,
            lastChecked: new Date().toISOString(),
          },
    );
  }

  async getRequestMetrics(): Promise<RequestMetrics> {
    const recent = this.requestHistory.slice(-this.metricsWindowSize);
    if (recent.length === 0) {
      return {
        totalRequests: 0,
        successRate: 1,
        avgLatencyMs: 0,
        p50LatencyMs: 0,
        p95LatencyMs: 0,
        p99LatencyMs: 0,
        timeoutRate: 0,
      };
    }

    const latencies = recent.map((r) => r.latencyMs).sort((a, b) => a - b);
    const successCount = recent.filter((r) => r.success).length;
    const timeoutCount = recent.filter((r) => r.latencyMs >= this.timeoutMs).length;

    const percentile = (sorted: number[], p: number): number => {
      const idx = Math.ceil((p / 100) * sorted.length) - 1;
      return sorted[Math.max(0, idx)];
    };

    return {
      totalRequests: recent.length,
      successRate: successCount / recent.length,
      avgLatencyMs: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
      p50LatencyMs: percentile(latencies, 50),
      p95LatencyMs: percentile(latencies, 95),
      p99LatencyMs: percentile(latencies, 99),
      timeoutRate: timeoutCount / recent.length,
    };
  }

  async getCircuitBreakerState(): Promise<CircuitBreakerState[]> {
    return this.config.providers.map((p) => {
      const cb = this.circuitBreakers.get(p.name)!;
      return {
        provider: p.name,
        state: cb.state,
        failureCount: cb.failureCount,
        lastFailure: cb.lastFailure,
      };
    });
  }

  async getFallbackConfig(): Promise<FallbackConfig> {
    return {
      chain: this.config.providers
        .map((p) => ({
          provider: p.name,
          priority: p.priority,
          enabled: p.enabled,
        }))
        .sort((a, b) => a.priority - b.priority),
    };
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'api_call') {
      throw new Error(`Unsupported AI provider live client command type: ${command.type}`);
    }

    switch (command.operation) {
      case 'provider_health_check':
        return {
          providers: await this.getProviderStatus(),
          metrics: await this.getRequestMetrics(),
          circuitBreakers: await this.getCircuitBreakerState(),
          fallbackConfig: await this.getFallbackConfig(),
        };
      case 'trip_circuit_breaker': {
        const provider = String(command.parameters?.provider ?? '');
        const cb = this.circuitBreakers.get(provider);
        if (cb) {
          cb.state = 'open';
          cb.failureCount = 100;
          cb.lastFailure = new Date().toISOString();
        }
        return { tripped: true, provider };
      }
      case 'activate_fallback_chain': {
        // Disable degraded/down providers and enable healthy ones
        const statuses = await this.getProviderStatus();
        const disabled: string[] = [];
        for (const s of statuses) {
          const p = this.config.providers.find((cp) => cp.name === s.name);
          if (p && s.status === 'down') {
            p.enabled = false;
            disabled.push(p.name);
          }
        }
        const active = this.config.providers.filter((p) => p.enabled).map((p) => p.name);
        return { activated: true, disabled, activeProviders: active };
      }
      case 'restore_primary': {
        // Re-enable all providers
        for (const p of this.config.providers) {
          p.enabled = true;
        }
        for (const [, cb] of this.circuitBreakers) {
          cb.state = 'closed';
          cb.failureCount = 0;
        }
        return { restored: true };
      }
      default:
        throw new Error(`Unknown AI provider operation: ${command.operation}`);
    }
  }

  async evaluateCheck(check: CheckExpression): Promise<boolean> {
    const stmt = check.statement ?? '';

    if (stmt === 'provider_ping') {
      const statuses = await this.getProviderStatus();
      const anyHealthy = statuses.some((s) => s.status === 'healthy');
      return this.compare(anyHealthy ? 'ok' : 'fail', check.expect.operator, check.expect.value);
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
        id: 'ai-provider-live-read',
        kind: 'capability_provider',
        name: 'AI Provider Live Read Provider',
        maturity: 'live_validated',
        capabilities: ['provider.status.read', 'provider.metrics.read'],
        executionContexts: ['provider_read'],
        targetKinds: ['ai-provider'],
        commandTypes: ['api_call'],
        supportsDryRun: true,
        supportsExecute: true,
      },
      {
        id: 'ai-provider-live-write',
        kind: 'capability_provider',
        name: 'AI Provider Live Write Provider',
        maturity: 'live_validated',
        capabilities: ['provider.circuit_breaker.trip', 'provider.fallback.activate', 'provider.traffic.shift'],
        executionContexts: ['provider_write'],
        targetKinds: ['ai-provider'],
        commandTypes: ['api_call'],
        supportsDryRun: true,
        supportsExecute: true,
      },
    ];
  }

  transition(_to: string): void {
    // No-op for live client.
  }

  async close(): Promise<void> {
    // No persistent connections to clean up.
  }

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
