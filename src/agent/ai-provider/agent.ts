// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RecoveryAgent, ReplanResult } from '../interface.js';
import type { AgentContext } from '../../types/agent-context.js';
import type { DiagnosisResult } from '../../types/diagnosis-result.js';
import type { ExecutionState } from '../../types/execution-state.js';
import type { HealthAssessment, HealthSignal, HealthStatus } from '../../types/health.js';
import type { RecoveryPlan } from '../../types/recovery-plan.js';
import type { RecoveryStep } from '../../types/step-types.js';
import { signalStatus, buildHealthAssessment } from '../../framework/health-helpers.js';
import { createPlanEnvelope } from '../../framework/plan-helpers.js';
import { aiProviderManifest } from './manifest.js';
import type { AiProviderBackend } from './backend.js';
import { AiProviderSimulator } from './simulator.js';

export class AiProviderFailoverAgent implements RecoveryAgent {
  manifest = aiProviderManifest;
  backend: AiProviderBackend;

  constructor(backend?: AiProviderBackend) {
    this.backend = backend ?? new AiProviderSimulator();
  }

  async assessHealth(_context: AgentContext): Promise<HealthAssessment> {
    const observedAt = new Date().toISOString();
    const providers = await this.backend.getProviderStatus();
    const metrics = await this.backend.getRequestMetrics();
    const circuitBreakers = await this.backend.getCircuitBreakerState();

    const primaryDown = providers.some((p) => p.status === 'down');
    const primaryDegraded = providers.some((p) => p.status === 'degraded');
    const latencyCritical = metrics.p95LatencyMs > 10_000;
    const latencyWarning = metrics.p95LatencyMs > 3_000;
    const errorCritical = metrics.successRate < 0.80;
    const errorWarning = metrics.successRate < 0.95;
    const timeoutCritical = metrics.timeoutRate > 0.15;
    const timeoutWarning = metrics.timeoutRate > 0.05;
    const circuitOpen = circuitBreakers.some((cb) => cb.state === 'open');
    const circuitHalfOpen = circuitBreakers.some((cb) => cb.state === 'half_open');

    const status = primaryDown || latencyCritical || errorCritical || timeoutCritical
      ? 'unhealthy'
      : primaryDegraded || latencyWarning || errorWarning || timeoutWarning || circuitOpen || circuitHalfOpen
        ? 'recovering'
        : 'healthy';

    const signals: HealthSignal[] = [
      {
        source: 'provider_health_status',
        status: signalStatus(primaryDown, primaryDegraded),
        detail: providers.map((p) => `${p.name}: ${p.status} (${p.latencyMs}ms, ${(p.errorRate * 100).toFixed(1)}% errors)`).join('; '),
        observedAt,
      },
      {
        source: 'request_metrics',
        status: signalStatus(latencyCritical || errorCritical, latencyWarning || errorWarning),
        detail: `p95 latency: ${metrics.p95LatencyMs}ms, success rate: ${(metrics.successRate * 100).toFixed(1)}%, timeout rate: ${(metrics.timeoutRate * 100).toFixed(1)}%.`,
        observedAt,
      },
      {
        source: 'circuit_breaker_state',
        status: signalStatus(circuitOpen, circuitHalfOpen),
        detail: circuitBreakers.map((cb) => `${cb.provider}: ${cb.state} (${cb.failureCount} failures)`).join('; '),
        observedAt,
      },
    ];

    return buildHealthAssessment({
      status,
      signals,
      confidence: 0.94,
      summary: {
        healthy: 'AI provider health is healthy. All providers are responding within normal latency and error thresholds.',
        recovering: 'AI provider health is recovering. At least one provider shows elevated latency, errors, or circuit breaker activity.',
        unhealthy: 'AI provider health is unhealthy. Primary provider is down or experiencing critical latency/error rates requiring failover.',
      },
      actions: {
        healthy: ['No action required. Continue monitoring provider latency and error rates.'],
        recovering: ['Continue monitoring. Consider preemptive failover if degradation persists beyond SLA thresholds.'],
        unhealthy: ['Run the AI provider failover recovery workflow to shift traffic to healthy providers.'],
      },
    });
  }

  async diagnose(_context: AgentContext): Promise<DiagnosisResult> {
    const providers = await this.backend.getProviderStatus();
    const metrics = await this.backend.getRequestMetrics();
    const circuitBreakers = await this.backend.getCircuitBreakerState();
    const fallbackConfig = await this.backend.getFallbackConfig();

    const degradedProviders = providers.filter((p) => p.status === 'degraded' || p.status === 'down');
    const healthyProviders = providers.filter((p) => p.status === 'healthy');

    const scenario = degradedProviders.some((p) => p.status === 'down')
      ? 'provider_complete_outage'
      : metrics.timeoutRate > 0.15
        ? 'provider_timeout_storm'
        : degradedProviders.some((p) => p.errorRate > 0.20)
          ? 'rate_limit_exceeded'
          : 'provider_degraded_latency';

    const confidence = degradedProviders.length > 0 && metrics.successRate < 0.80 ? 0.95 : 0.85;

    return {
      status: 'identified',
      scenario,
      confidence,
      findings: [
        {
          source: 'provider_health_status',
          observation: `${degradedProviders.length} provider(s) degraded/down: ${degradedProviders.map((p) => `${p.name} (${p.status}, ${p.latencyMs}ms, ${(p.errorRate * 100).toFixed(1)}% errors)`).join(', ')}. ${healthyProviders.length} healthy provider(s) available.`,
          severity: degradedProviders.some((p) => p.status === 'down') ? 'critical' : 'warning',
          data: { degradedProviders, healthyProviders },
        },
        {
          source: 'request_metrics',
          observation: `Total requests: ${metrics.totalRequests.toLocaleString()}. Success rate: ${(metrics.successRate * 100).toFixed(1)}%. p50: ${metrics.p50LatencyMs}ms, p95: ${metrics.p95LatencyMs}ms, p99: ${metrics.p99LatencyMs}ms. Timeout rate: ${(metrics.timeoutRate * 100).toFixed(1)}%.`,
          severity: metrics.successRate < 0.80 ? 'critical' : metrics.successRate < 0.95 ? 'warning' : 'info',
          data: { metrics },
        },
        {
          source: 'circuit_breaker_state',
          observation: circuitBreakers.map((cb) => `${cb.provider}: ${cb.state} (${cb.failureCount} failures)`).join('. '),
          severity: circuitBreakers.some((cb) => cb.state === 'open') ? 'critical' : circuitBreakers.some((cb) => cb.state === 'half_open') ? 'warning' : 'info',
          data: { circuitBreakers },
        },
        {
          source: 'fallback_config',
          observation: `Fallback chain: ${fallbackConfig.chain.map((c) => `${c.provider} (priority ${c.priority}, ${c.enabled ? 'enabled' : 'disabled'})`).join(' -> ')}.`,
          severity: 'info',
          data: { fallbackConfig },
        },
      ],
      diagnosticPlanNeeded: false,
    };
  }

  async plan(context: AgentContext, diagnosis: DiagnosisResult): Promise<RecoveryPlan> {
    const target = String(context.trigger.payload.instance || 'ai-provider-gateway');

    const steps: RecoveryStep[] = [
      // Step 1: Read all provider health metrics
      {
        stepId: 'step-001',
        type: 'diagnosis_action',
        name: 'Capture AI provider health metrics',
        executionContext: 'provider_read',
        target,
        command: {
          type: 'api_call',
          operation: 'provider_health_check',
          parameters: { includeMetrics: true, includeCircuitBreakers: true },
        },
        outputCapture: {
          name: 'current_provider_state',
          format: 'structured',
          availableTo: 'subsequent_steps',
        },
        timeout: 'PT30S',
      },
      // Step 2: Alert about AI provider degradation
      {
        stepId: 'step-002',
        type: 'human_notification',
        name: 'Notify on-call of AI provider degradation',
        recipients: [{ role: 'on_call_engineer', urgency: 'high' }],
        message: {
          summary: `AI provider degradation detected — failover recovery initiated on ${target}`,
          detail: `Scenario: ${diagnosis.scenario}. ${diagnosis.findings[0]?.observation}`,
          contextReferences: ['current_provider_state'],
          actionRequired: false,
        },
        channel: 'auto',
      },
      // Step 3: Capture current provider config and traffic routing
      {
        stepId: 'step-003',
        type: 'checkpoint',
        name: 'Pre-failover checkpoint',
        description: 'Capture current provider configuration and traffic routing state before mutations.',
        stateCaptures: [
          {
            name: 'provider_config_snapshot',
            captureType: 'command_output',
            statement: 'GET /provider/config',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
          {
            name: 'traffic_routing_snapshot',
            captureType: 'command_output',
            statement: 'GET /routing/state',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      },
      // Step 4: Trip circuit breaker on degraded provider
      {
        stepId: 'step-004',
        type: 'system_action',
        name: 'Trip circuit breaker on degraded provider',
        description: 'Force-open the circuit breaker on the degraded provider to stop sending traffic to it.',
        executionContext: 'provider_write',
        target,
        riskLevel: 'elevated',
        requiredCapabilities: ['provider.circuit_breaker.trip'],
        command: {
          type: 'api_call',
          operation: 'trip_circuit_breaker',
          parameters: { provider: 'openai', reason: 'automated_failover' },
        },
        preConditions: [
          {
            description: 'Provider gateway is accepting commands',
            check: {
              type: 'api_call',
              statement: 'provider_ping',
              expect: { operator: 'eq', value: 'ok' },
            },
          },
        ],
        statePreservation: {
          before: [
            {
              name: 'circuit_breaker_state_before',
              captureType: 'command_output',
              statement: 'GET /circuit-breaker/state',
              captureCost: 'negligible',
              capturePolicy: 'required',
              retention: 'P30D',
            },
          ],
          after: [
            {
              name: 'circuit_breaker_state_after',
              captureType: 'command_output',
              statement: 'GET /circuit-breaker/state',
              captureCost: 'negligible',
              capturePolicy: 'best_effort',
              retention: 'P30D',
            },
          ],
        },
        successCriteria: {
          description: 'Circuit breaker is open for degraded provider',
          check: {
            type: 'api_call',
            statement: 'circuit_breaker_open',
            expect: { operator: 'gte', value: 1 },
          },
        },
        rollback: {
          type: 'manual',
          description: 'Close the circuit breaker manually via the provider gateway API to resume traffic to the provider.',
        },
        blastRadius: {
          directComponents: [target],
          indirectComponents: ['request-router'],
          maxImpact: 'traffic_shifted_from_primary',
          cascadeRisk: 'low',
        },
        timeout: 'PT30S',
        retryPolicy: { maxRetries: 1, retryable: true },
      },
      // Step 5: Activate fallback provider chain
      {
        stepId: 'step-005',
        type: 'system_action',
        name: 'Activate fallback provider chain',
        description: 'Enable the fallback chain to route requests through healthy providers.',
        executionContext: 'provider_write',
        target,
        riskLevel: 'routine',
        requiredCapabilities: ['provider.fallback.activate'],
        command: {
          type: 'api_call',
          operation: 'activate_fallback_chain',
          parameters: { skipProviders: ['openai'] },
        },
        statePreservation: { before: [], after: [] },
        successCriteria: {
          description: 'Fallback chain is active with healthy providers',
          check: {
            type: 'api_call',
            statement: 'fallback_active',
            expect: { operator: 'eq', value: true },
          },
        },
        rollback: {
          type: 'automatic',
          description: 'Deactivate fallback chain and restore original routing configuration.',
        },
        blastRadius: {
          directComponents: [target],
          indirectComponents: ['fallback-chain'],
          maxImpact: 'requests_routed_to_secondary_providers',
          cascadeRisk: 'low',
        },
        timeout: 'PT30S',
        retryPolicy: { maxRetries: 1, retryable: true },
      },
      // Step 6: Verify requests routing to healthy provider
      {
        stepId: 'step-006',
        type: 'diagnosis_action',
        name: 'Verify request routing to healthy providers',
        executionContext: 'provider_read',
        target,
        command: {
          type: 'api_call',
          operation: 'verify_routing',
          parameters: { checkLatency: true, checkErrorRate: true },
        },
        outputCapture: {
          name: 'post_failover_routing',
          format: 'structured',
          availableTo: 'subsequent_steps',
        },
        timeout: 'PT30S',
      },
      // Step 7: Replanning checkpoint — check if primary is recovering
      {
        stepId: 'step-007',
        type: 'replanning_checkpoint',
        name: 'Assess primary provider recovery status',
        description: 'Check if the primary provider is recovering and whether gradual traffic restoration should begin.',
        fastReplan: true,
        replanTimeout: 'PT30S',
        diagnosticCaptures: [
          {
            name: 'post_failover_provider_state',
            captureType: 'command_output',
            statement: 'GET /provider/status',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      },
      // Step 8: Recovery summary notification
      {
        stepId: 'step-008',
        type: 'human_notification',
        name: 'Send recovery summary with provider status',
        recipients: [
          { role: 'on_call_engineer', urgency: 'medium' },
          { role: 'incident_commander', urgency: 'medium' },
        ],
        message: {
          summary: `AI provider failover recovery completed on ${target}`,
          detail: `Circuit breaker tripped on degraded provider. Traffic routed to fallback providers. Monitor primary provider for recovery before restoring traffic.`,
          contextReferences: ['post_failover_routing', 'post_failover_provider_state'],
          actionRequired: false,
        },
        channel: 'auto',
      },
    ];

    return {
      ...createPlanEnvelope({
        planIdSuffix: 'ai-provider',
        agentName: 'ai-provider-failover-recovery',
        agentVersion: '1.0.0',
        scenario: diagnosis.scenario ?? 'provider_degraded_latency',
        estimatedDuration: 'PT5M',
        summary: `Recover from AI provider degradation on ${target}: trip circuit breaker on degraded provider, activate fallback chain, verify routing to healthy providers.`,
      }),
      impact: {
        affectedSystems: [
          {
            identifier: target,
            technology: 'ai-provider',
            role: 'gateway',
            impactType: 'traffic_shifted_to_fallback_providers',
          },
        ],
        affectedServices: ['ai-inference-layer'],
        estimatedUserImpact: 'Brief increase in latency during failover transition. No data loss. Requests routed to healthy fallback providers.',
        dataLossRisk: 'none',
      },
      steps,
      rollbackStrategy: {
        type: 'stepwise',
        description: 'Circuit breaker can be manually closed to restore primary provider traffic. Fallback chain deactivation restores original routing.',
      },
    };
  }

  async replan(
    _context: AgentContext,
    _diagnosis: DiagnosisResult,
    executionState: ExecutionState,
  ): Promise<ReplanResult> {
    // Check if primary provider is recovering — if so, propose gradual traffic restoration
    const completedSteps = executionState.completedSteps ?? [];
    const lastDiag = completedSteps.find((s) => s.stepId === 'step-006');
    const output = lastDiag?.output as Record<string, unknown> | undefined;

    if (output?.activeProvider === 'anthropic') {
      // Primary is still down — continue with fallback
      return { action: 'continue' };
    }

    // Primary appears to be recovering — continue current plan
    // (A full revised_plan could be returned here when gradual traffic restoration is implemented)
    return { action: 'continue' };
  }
}
