// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type {
  QueueBackend,
  QueueStats,
  WorkerStatus,
  DeadLetterStats,
  ProcessingRateInfo,
} from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';

export type SimulatorState = 'backlog_growing' | 'draining' | 'cleared';

export class QueueSimulator implements QueueBackend {
  private state: SimulatorState = 'backlog_growing';

  transition(to: string): void {
    this.state = to as SimulatorState;
  }

  async getQueueStats(): Promise<QueueStats[]> {
    switch (this.state) {
      case 'backlog_growing':
        return [
          { name: 'orders', depth: 84_500, processingRate: 12, errorRate: 8.2, oldestMessageAge: 7200, paused: false },
          { name: 'notifications', depth: 23_100, processingRate: 45, errorRate: 1.1, oldestMessageAge: 3600, paused: false },
          { name: 'analytics', depth: 156_000, processingRate: 3, errorRate: 15.4, oldestMessageAge: 14400, paused: false },
        ];
      case 'draining':
        return [
          { name: 'orders', depth: 32_000, processingRate: 85, errorRate: 0.5, oldestMessageAge: 1800, paused: true },
          { name: 'notifications', depth: 8_200, processingRate: 120, errorRate: 0.2, oldestMessageAge: 900, paused: true },
          { name: 'analytics', depth: 45_000, processingRate: 60, errorRate: 1.0, oldestMessageAge: 3600, paused: true },
        ];
      case 'cleared':
        return [
          { name: 'orders', depth: 120, processingRate: 95, errorRate: 0.1, oldestMessageAge: 5, paused: false },
          { name: 'notifications', depth: 45, processingRate: 130, errorRate: 0.0, oldestMessageAge: 2, paused: false },
          { name: 'analytics', depth: 300, processingRate: 70, errorRate: 0.3, oldestMessageAge: 15, paused: false },
        ];
    }
  }

  async getWorkerStatus(): Promise<WorkerStatus[]> {
    const now = new Date().toISOString();
    const staleHeartbeat = new Date(Date.now() - 600_000).toISOString();
    const deadHeartbeat = new Date(Date.now() - 1_800_000).toISOString();

    switch (this.state) {
      case 'backlog_growing':
        return [
          { id: 'worker-001', status: 'active', currentJob: 'order-proc-28491', lastHeartbeat: now, processedCount: 1_240 },
          { id: 'worker-002', status: 'stuck', currentJob: 'order-proc-27003', lastHeartbeat: staleHeartbeat, processedCount: 890 },
          { id: 'worker-003', status: 'stuck', currentJob: 'analytics-batch-4401', lastHeartbeat: staleHeartbeat, processedCount: 312 },
          { id: 'worker-004', status: 'dead', lastHeartbeat: deadHeartbeat, processedCount: 2_100 },
          { id: 'worker-005', status: 'idle', lastHeartbeat: now, processedCount: 0 },
        ];
      case 'draining':
        return [
          { id: 'worker-001', status: 'active', currentJob: 'order-proc-28650', lastHeartbeat: now, processedCount: 2_480 },
          { id: 'worker-002', status: 'active', currentJob: 'order-proc-28651', lastHeartbeat: now, processedCount: 1_560 },
          { id: 'worker-003', status: 'active', currentJob: 'analytics-batch-4520', lastHeartbeat: now, processedCount: 980 },
          { id: 'worker-004', status: 'active', currentJob: 'notif-send-9102', lastHeartbeat: now, processedCount: 750 },
          { id: 'worker-005', status: 'active', currentJob: 'order-proc-28652', lastHeartbeat: now, processedCount: 420 },
        ];
      case 'cleared':
        return [
          { id: 'worker-001', status: 'active', currentJob: 'order-proc-29001', lastHeartbeat: now, processedCount: 4_200 },
          { id: 'worker-002', status: 'idle', lastHeartbeat: now, processedCount: 3_100 },
          { id: 'worker-003', status: 'active', currentJob: 'analytics-batch-4600', lastHeartbeat: now, processedCount: 2_400 },
          { id: 'worker-004', status: 'idle', lastHeartbeat: now, processedCount: 1_800 },
          { id: 'worker-005', status: 'idle', lastHeartbeat: now, processedCount: 1_050 },
        ];
    }
  }

  async getDeadLetterStats(): Promise<DeadLetterStats> {
    switch (this.state) {
      case 'backlog_growing':
        return {
          depth: 4_230,
          oldestAge: 86_400,
          recentErrors: [
            'TimeoutError: Processing exceeded 30s limit',
            'ConnectionRefusedError: downstream service unavailable',
            'ValidationError: malformed payload in order-proc-27003',
          ],
        };
      case 'draining':
        return {
          depth: 4_230,
          oldestAge: 86_400,
          recentErrors: [
            'TimeoutError: Processing exceeded 30s limit',
          ],
        };
      case 'cleared':
        return {
          depth: 150,
          oldestAge: 3_600,
          recentErrors: [],
        };
    }
  }

  async getProcessingRate(): Promise<ProcessingRateInfo> {
    switch (this.state) {
      case 'backlog_growing':
        return {
          incomingRate: 320,
          processingRate: 60,
          backlogGrowthRate: 260,
          estimatedClearTime: Infinity,
        };
      case 'draining':
        return {
          incomingRate: 0,
          processingRate: 265,
          backlogGrowthRate: -265,
          estimatedClearTime: 320,
        };
      case 'cleared':
        return {
          incomingRate: 95,
          processingRate: 295,
          backlogGrowthRate: -200,
          estimatedClearTime: 0,
        };
    }
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'structured_command') {
      throw new Error(`Unsupported queue simulator command type: ${command.type}`);
    }

    switch (command.operation) {
      case 'queue_stats':
        return {
          queues: await this.getQueueStats(),
          workers: await this.getWorkerStatus(),
          dlq: await this.getDeadLetterStats(),
          rates: await this.getProcessingRate(),
        };
      case 'pause_intake':
        this.transition('draining');
        return { paused: true };
      case 'restart_workers':
        this.transition('draining');
        return { restartedWorkers: true };
      case 'resume_intake':
        this.transition('cleared');
        return { resumed: true };
      case 'scale_workers':
        return { scaled: true, targetCount: command.parameters?.count ?? 10 };
      case 'dlq_retry':
        return { retriedCount: command.parameters?.count ?? 100 };
      default:
        return { simulated: true, operation: command.operation, parameters: command.parameters };
    }
  }

  async evaluateCheck(check: CheckExpression): Promise<boolean> {
    const stmt = check.statement ?? '';

    if (stmt === 'queue_service_health') {
      return this.compare('ok', check.expect.operator, check.expect.value);
    }

    if (stmt.includes('total_queue_depth')) {
      const queues = await this.getQueueStats();
      const totalDepth = queues.reduce((sum, q) => sum + q.depth, 0);
      return this.compare(totalDepth, check.expect.operator, check.expect.value);
    }

    if (stmt.includes('stuck_worker_count')) {
      const workers = await this.getWorkerStatus();
      const stuckCount = workers.filter((w) => w.status === 'stuck' || w.status === 'dead').length;
      return this.compare(stuckCount, check.expect.operator, check.expect.value);
    }

    if (stmt.includes('backlog_growth_rate')) {
      const rates = await this.getProcessingRate();
      return this.compare(rates.backlogGrowthRate, check.expect.operator, check.expect.value);
    }

    if (stmt.includes('dlq_depth')) {
      const dlq = await this.getDeadLetterStats();
      return this.compare(dlq.depth, check.expect.operator, check.expect.value);
    }

    return true;
  }

  listCapabilityProviders(): CapabilityProviderDescriptor[] {
    return [
      {
        id: 'queue-simulator-read',
        kind: 'capability_provider',
        name: 'Queue Simulator Read Provider',
        maturity: 'simulator_only',
        capabilities: ['queue.stats.read', 'queue.workers.read'],
        executionContexts: ['queue_read'],
        targetKinds: ['message-queue'],
        commandTypes: ['structured_command'],
        supportsDryRun: true,
        supportsExecute: true,
      },
      {
        id: 'queue-simulator-write',
        kind: 'capability_provider',
        name: 'Queue Simulator Write Provider',
        maturity: 'simulator_only',
        capabilities: ['queue.pause', 'queue.workers.restart', 'queue.dlq.retry', 'queue.workers.scale'],
        executionContexts: ['queue_write'],
        targetKinds: ['message-queue'],
        commandTypes: ['structured_command'],
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
