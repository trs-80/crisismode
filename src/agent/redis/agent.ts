// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RecoveryAgent, ReplanResult } from '../interface.js';
import type { AgentContext } from '../../types/agent-context.js';
import type { DiagnosisResult } from '../../types/diagnosis-result.js';
import type { ExecutionState } from '../../types/execution-state.js';
import type { RecoveryPlan } from '../../types/recovery-plan.js';
import type { RecoveryStep } from '../../types/step-types.js';
import { redisMemoryManifest } from './manifest.js';
import type { RedisBackend } from './backend.js';
import { RedisSimulator } from './simulator.js';

export class RedisMemoryAgent implements RecoveryAgent {
  manifest = redisMemoryManifest;
  backend: RedisBackend;

  constructor(backend?: RedisBackend) {
    this.backend = backend ?? new RedisSimulator();
  }

  async diagnose(_context: AgentContext): Promise<DiagnosisResult> {
    const info = await this.backend.getInfo();
    const slaves = await this.backend.getSlaves();
    const slowlog = await this.backend.getSlowlog(10);
    const keyCount = await this.backend.getKeyCount();
    const fragRatio = await this.backend.getFragmentationRatio();

    const scenario = info.memoryUsagePercent > 80
      ? 'memory_pressure'
      : info.connectedClients > 500
        ? 'client_exhaustion'
        : 'slow_query_storm';

    const confidence = info.memoryUsagePercent > 80 && info.evictedKeys > 0 ? 0.95 : 0.82;

    return {
      status: 'identified',
      scenario,
      confidence,
      findings: [
        {
          source: 'redis_info_memory',
          observation: `Memory: ${(info.usedMemoryBytes / 1_073_741_824).toFixed(1)}GB / ${(info.maxMemoryBytes / 1_073_741_824).toFixed(1)}GB (${info.memoryUsagePercent.toFixed(1)}%). Fragmentation ratio: ${fragRatio.toFixed(1)}. Keys: ${(keyCount / 1_000_000).toFixed(1)}M.`,
          severity: info.memoryUsagePercent > 80 ? 'critical' : 'warning',
          data: { usedMemory: info.usedMemoryBytes, maxMemory: info.maxMemoryBytes, memoryPercent: info.memoryUsagePercent, fragRatio, keyCount },
        },
        {
          source: 'redis_info_clients',
          observation: `${info.connectedClients} connected clients, ${info.blockedClients} blocked. ${info.evictedKeys.toLocaleString()} keys evicted.`,
          severity: info.blockedClients > 10 ? 'critical' : info.connectedClients > 500 ? 'warning' : 'info',
          data: { clients: info.connectedClients, blocked: info.blockedClients, evicted: info.evictedKeys },
        },
        {
          source: 'redis_slowlog',
          observation: slowlog.length > 0
            ? `${slowlog.length} slow queries detected. Worst: ${slowlog[0]?.command} (${(slowlog[0]?.durationMicros / 1000).toFixed(0)}ms).`
            : 'No slow queries in recent slowlog.',
          severity: slowlog.length > 5 ? 'critical' : slowlog.length > 0 ? 'warning' : 'info',
          data: { slowlog },
        },
        {
          source: 'redis_replication',
          observation: `${slaves.length} replicas. Max lag: ${Math.max(0, ...slaves.map(s => s.lag))}s.`,
          severity: slaves.some(s => s.lag > 30) ? 'warning' : 'info',
          data: { slaves },
        },
      ],
      diagnosticPlanNeeded: false,
    };
  }

  async plan(context: AgentContext, diagnosis: DiagnosisResult): Promise<RecoveryPlan> {
    const now = new Date().toISOString();
    const instance = String(context.trigger.payload.instance || 'redis-primary');

    const steps: RecoveryStep[] = [
      // Step 1: Capture current state
      {
        stepId: 'step-001',
        type: 'diagnosis_action',
        name: 'Capture Redis memory and client state',
        executionContext: 'redis_admin',
        target: instance,
        command: {
          type: 'structured_command',
          operation: 'redis_info',
          parameters: { sections: ['memory', 'clients', 'keyspace', 'replication'] },
        },
        outputCapture: {
          name: 'current_redis_state',
          format: 'structured',
          availableTo: 'subsequent_steps',
        },
        timeout: 'PT30S',
      },
      // Step 2: Notify
      {
        stepId: 'step-002',
        type: 'human_notification',
        name: 'Notify on-call of Redis memory recovery',
        recipients: [{ role: 'on_call_engineer', urgency: 'high' }],
        message: {
          summary: `Redis memory pressure recovery initiated on ${instance}`,
          detail: `Scenario: ${diagnosis.scenario}. ${diagnosis.findings[0]?.observation}`,
          contextReferences: ['current_redis_state'],
          actionRequired: false,
        },
        channel: 'auto',
      },
      // Step 3: Checkpoint
      {
        stepId: 'step-003',
        type: 'checkpoint',
        name: 'Pre-recovery checkpoint',
        description: 'Capture Redis config and memory state before mutations.',
        stateCaptures: [
          {
            name: 'redis_config_snapshot',
            captureType: 'command_output',
            statement: 'CONFIG GET *',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
          {
            name: 'redis_memory_snapshot',
            captureType: 'command_output',
            statement: 'MEMORY STATS',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      },
      // Step 4: Kill blocked and idle clients
      {
        stepId: 'step-004',
        type: 'system_action',
        name: 'Disconnect idle and blocked clients',
        description: 'Terminate client connections idle for >300s and all blocked clients to free resources.',
        executionContext: 'redis_admin',
        target: instance,
        riskLevel: 'elevated',
        command: {
          type: 'structured_command',
          operation: 'client_kill',
          parameters: { filter: 'idle>300', includeBlocked: true },
        },
        preConditions: [
          {
            description: 'Redis is accepting commands',
            check: {
              type: 'structured_command',
              statement: 'PING',
              expect: { operator: 'eq', value: 'PONG' },
            },
          },
        ],
        statePreservation: {
          before: [
            {
              name: 'client_list_before',
              captureType: 'command_output',
              statement: 'CLIENT LIST',
              captureCost: 'negligible',
              capturePolicy: 'required',
              retention: 'P30D',
            },
          ],
          after: [
            {
              name: 'client_list_after',
              captureType: 'command_output',
              statement: 'CLIENT LIST',
              captureCost: 'negligible',
              capturePolicy: 'best_effort',
              retention: 'P30D',
            },
          ],
        },
        successCriteria: {
          description: 'Blocked client count is zero',
          check: {
            type: 'structured_command',
            statement: 'blocked_clients',
            expect: { operator: 'eq', value: 0 },
          },
        },
        rollback: {
          type: 'automatic',
          description: 'Clients will reconnect automatically via connection pooling.',
        },
        blastRadius: {
          directComponents: [instance],
          indirectComponents: ['application-pool'],
          maxImpact: 'idle_clients_disconnected',
          cascadeRisk: 'low',
        },
        timeout: 'PT30S',
        retryPolicy: { maxRetries: 0, retryable: false },
      },
      // Step 5: Expire volatile keys with short TTLs
      {
        stepId: 'step-005',
        type: 'system_action',
        name: 'Trigger active expiry of volatile keys',
        description: 'Run SCAN-based expiry to free memory from keys past their TTL.',
        executionContext: 'redis_admin',
        target: instance,
        riskLevel: 'routine',
        command: {
          type: 'structured_command',
          operation: 'active_expiry',
          parameters: { effort: 'aggressive' },
        },
        statePreservation: { before: [], after: [] },
        successCriteria: {
          description: 'Memory usage decreased',
          check: {
            type: 'structured_command',
            statement: 'used_memory_percent',
            expect: { operator: 'lt', value: 85 },
          },
        },
        rollback: {
          type: 'automatic',
          description: 'No rollback needed — only expired keys are removed.',
        },
        blastRadius: {
          directComponents: [instance],
          indirectComponents: [],
          maxImpact: 'expired_keys_evicted',
          cascadeRisk: 'none',
        },
        timeout: 'PT2M',
        retryPolicy: { maxRetries: 1, retryable: true },
      },
      // Step 6: Replanning checkpoint
      {
        stepId: 'step-006',
        type: 'replanning_checkpoint',
        name: 'Assess memory state after initial cleanup',
        description: 'Check if memory pressure is resolved or if more aggressive action is needed.',
        fastReplan: true,
        replanTimeout: 'PT30S',
        diagnosticCaptures: [
          {
            name: 'post_cleanup_memory',
            captureType: 'command_output',
            statement: 'INFO memory',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      },
      // Step 7: Set memory policy if not already configured
      {
        stepId: 'step-007',
        type: 'system_action',
        name: 'Configure eviction policy to allkeys-lru',
        description: 'Ensure LRU eviction is active to prevent OOM under continued pressure.',
        executionContext: 'redis_admin',
        target: instance,
        riskLevel: 'routine',
        command: {
          type: 'structured_command',
          operation: 'config_set',
          parameters: { key: 'maxmemory-policy', value: 'allkeys-lru' },
        },
        statePreservation: {
          before: [
            {
              name: 'eviction_policy_before',
              captureType: 'command_output',
              statement: 'CONFIG GET maxmemory-policy',
              captureCost: 'negligible',
              capturePolicy: 'required',
              retention: 'P30D',
            },
          ],
          after: [],
        },
        successCriteria: {
          description: 'Eviction policy is set',
          check: {
            type: 'structured_command',
            statement: 'CONFIG GET maxmemory-policy',
            expect: { operator: 'eq', value: 'allkeys-lru' },
          },
        },
        rollback: {
          type: 'manual',
          description: 'Revert to previous maxmemory-policy via CONFIG SET.',
        },
        blastRadius: {
          directComponents: [instance],
          indirectComponents: [],
          maxImpact: 'eviction_policy_changed',
          cascadeRisk: 'low',
        },
        timeout: 'PT10S',
        retryPolicy: { maxRetries: 1, retryable: true },
      },
      // Step 8: Recovery summary
      {
        stepId: 'step-008',
        type: 'human_notification',
        name: 'Send recovery summary',
        recipients: [
          { role: 'on_call_engineer', urgency: 'medium' },
          { role: 'incident_commander', urgency: 'medium' },
        ],
        message: {
          summary: `Redis memory recovery completed on ${instance}`,
          detail: `Idle/blocked clients disconnected, expired keys cleaned, eviction policy verified. Monitor memory usage and hit rate.`,
          contextReferences: ['post_cleanup_memory'],
          actionRequired: false,
        },
        channel: 'auto',
      },
    ];

    return {
      apiVersion: 'v0.2.1',
      kind: 'RecoveryPlan',
      metadata: {
        planId: `rp-${now.replace(/[-:T]/g, '').slice(0, 14)}-redis-mem-001`,
        agentName: 'redis-memory-recovery',
        agentVersion: '1.0.0',
        scenario: diagnosis.scenario ?? 'memory_pressure',
        createdAt: now,
        estimatedDuration: 'PT5M',
        summary: `Recover Redis from memory pressure on ${instance}: disconnect idle clients, trigger expiry, verify eviction policy.`,
        supersedes: null,
      },
      impact: {
        affectedSystems: [
          {
            identifier: instance,
            technology: 'redis',
            role: 'primary',
            impactType: 'brief_client_disconnections',
          },
        ],
        affectedServices: ['cache-layer'],
        estimatedUserImpact: 'Brief increase in cache misses during client reconnection. No data loss.',
        dataLossRisk: 'none',
      },
      steps,
      rollbackStrategy: {
        type: 'stepwise',
        description: 'Each step is independently reversible. Client disconnections recover automatically via connection pooling.',
      },
    };
  }

  async replan(
    _context: AgentContext,
    _diagnosis: DiagnosisResult,
    _executionState: ExecutionState,
  ): Promise<ReplanResult> {
    return { action: 'continue' };
  }
}
