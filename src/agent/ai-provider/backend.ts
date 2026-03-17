// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * AiProviderBackend — interface for querying AI provider health and failover state.
 * Both the simulator and live client implement this.
 */

import type { ExecutionBackend } from '../../framework/backend.js';

export interface ProviderStatus {
  name: string;
  endpoint: string;
  status: 'healthy' | 'degraded' | 'down';
  latencyMs: number;
  errorRate: number;
  lastChecked: string;
}

export interface RequestMetrics {
  totalRequests: number;
  successRate: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  timeoutRate: number;
}

export interface CircuitBreakerState {
  provider: string;
  state: 'closed' | 'half_open' | 'open';
  failureCount: number;
  lastFailure: string | null;
}

export interface FallbackConfig {
  chain: Array<{ provider: string; priority: number; enabled: boolean }>;
}

export interface AiProviderBackend extends ExecutionBackend {
  /** Get health status of each configured AI provider */
  getProviderStatus(): Promise<ProviderStatus[]>;

  /** Get aggregate request metrics (latency percentiles, error/timeout rates) */
  getRequestMetrics(): Promise<RequestMetrics>;

  /** Get circuit breaker state per provider */
  getCircuitBreakerState(): Promise<CircuitBreakerState[]>;

  /** Get the configured fallback provider chain */
  getFallbackConfig(): Promise<FallbackConfig>;

  /** Optional simulator-only state transitions */
  transition?(to: string): void;
}
