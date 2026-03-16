// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type {
  FlinkBackend,
  FlinkJobStatus,
  FlinkCheckpointInfo,
  FlinkTaskManager,
  FlinkBackpressure,
  FlinkException,
} from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';

export type SimulatorState = 'degraded' | 'recovering' | 'recovered';

export class FlinkSimulator implements FlinkBackend {
  private state: SimulatorState = 'degraded';

  transition(to: string): void {
    this.state = to as SimulatorState;
  }

  async getJobStatus(): Promise<FlinkJobStatus[]> {
    const now = Date.now();
    switch (this.state) {
      case 'degraded':
        return [
          {
            jobId: 'job-abc123',
            name: 'etl-pipeline',
            state: 'FAILING',
            startTime: now - 7_200_000, // 2 hours ago
            duration: 7_200_000,
            parallelism: 8,
            maxParallelism: 16,
          },
        ];
      case 'recovering':
        return [
          {
            jobId: 'job-abc123',
            name: 'etl-pipeline',
            state: 'RESTARTING',
            startTime: now - 7_200_000,
            duration: 7_200_000,
            parallelism: 8,
            maxParallelism: 16,
          },
        ];
      case 'recovered':
        return [
          {
            jobId: 'job-abc123',
            name: 'etl-pipeline',
            state: 'RUNNING',
            startTime: now - 60_000, // restarted 1 min ago
            duration: 60_000,
            parallelism: 8,
            maxParallelism: 16,
          },
        ];
    }
  }

  async getCheckpointHistory(_jobId: string): Promise<FlinkCheckpointInfo[]> {
    const now = Date.now();
    switch (this.state) {
      case 'degraded':
        return [
          {
            id: 105,
            status: 'FAILED',
            triggerTimestamp: now - 30_000,
            duration: 45_000,
            size: 2_147_483_648, // ~2GB
            alignmentBuffered: 536_870_912,
            processedData: 1_073_741_824,
            failureReason: 'java.lang.OutOfMemoryError: Java heap space',
          },
          {
            id: 104,
            status: 'FAILED',
            triggerTimestamp: now - 90_000,
            duration: 60_000,
            size: 2_147_483_648,
            alignmentBuffered: 536_870_912,
            processedData: 1_073_741_824,
            failureReason: 'Checkpoint expired before completing. Timeout: 60000ms',
          },
          {
            id: 103,
            status: 'FAILED',
            triggerTimestamp: now - 150_000,
            duration: 55_000,
            size: 2_147_483_648,
            alignmentBuffered: 268_435_456,
            processedData: 1_073_741_824,
            failureReason: 'java.lang.OutOfMemoryError: Direct buffer memory',
          },
          {
            id: 102,
            status: 'COMPLETED',
            triggerTimestamp: now - 300_000,
            duration: 12_000,
            size: 1_932_735_283,
            alignmentBuffered: 134_217_728,
            processedData: 1_073_741_824,
          },
          {
            id: 101,
            status: 'COMPLETED',
            triggerTimestamp: now - 600_000,
            duration: 11_500,
            size: 1_932_735_283,
            alignmentBuffered: 134_217_728,
            processedData: 1_073_741_824,
          },
        ];
      case 'recovering':
        return [
          {
            id: 106,
            status: 'IN_PROGRESS',
            triggerTimestamp: now - 5_000,
            duration: 5_000,
            size: 0,
            alignmentBuffered: 0,
            processedData: 0,
          },
          {
            id: 105,
            status: 'FAILED',
            triggerTimestamp: now - 30_000,
            duration: 45_000,
            size: 2_147_483_648,
            alignmentBuffered: 536_870_912,
            processedData: 1_073_741_824,
            failureReason: 'java.lang.OutOfMemoryError: Java heap space',
          },
        ];
      case 'recovered':
        return [
          {
            id: 108,
            status: 'COMPLETED',
            triggerTimestamp: now - 10_000,
            duration: 8_000,
            size: 1_932_735_283,
            alignmentBuffered: 67_108_864,
            processedData: 1_073_741_824,
          },
          {
            id: 107,
            status: 'COMPLETED',
            triggerTimestamp: now - 70_000,
            duration: 7_500,
            size: 1_932_735_283,
            alignmentBuffered: 67_108_864,
            processedData: 1_073_741_824,
          },
        ];
    }
  }

  async getTaskManagers(): Promise<FlinkTaskManager[]> {
    switch (this.state) {
      case 'degraded':
        return [
          {
            id: 'tm-001',
            path: '/taskmanagers/tm-001',
            dataPort: 6121,
            freeSlots: 2,
            totalSlots: 4,
            cpuCores: 4,
            physicalMemory: 4_294_967_296, // 4GB
            freeMemory: 52_428_800, // ~50MB — critically low
            managedMemory: 2_147_483_648,
          },
          {
            id: 'tm-002',
            path: '/taskmanagers/tm-002',
            dataPort: 6121,
            freeSlots: 2,
            totalSlots: 4,
            cpuCores: 4,
            physicalMemory: 4_294_967_296,
            freeMemory: 1_073_741_824, // ~1GB
            managedMemory: 2_147_483_648,
          },
          {
            id: 'tm-003',
            path: '/taskmanagers/tm-003',
            dataPort: 6121,
            freeSlots: 2,
            totalSlots: 4,
            cpuCores: 4,
            physicalMemory: 4_294_967_296,
            freeMemory: 858_993_459, // ~820MB
            managedMemory: 2_147_483_648,
          },
        ];
      case 'recovering':
        return [
          {
            id: 'tm-001',
            path: '/taskmanagers/tm-001',
            dataPort: 6121,
            freeSlots: 3,
            totalSlots: 4,
            cpuCores: 4,
            physicalMemory: 4_294_967_296,
            freeMemory: 536_870_912, // ~512MB — improved
            managedMemory: 2_147_483_648,
          },
          {
            id: 'tm-002',
            path: '/taskmanagers/tm-002',
            dataPort: 6121,
            freeSlots: 3,
            totalSlots: 4,
            cpuCores: 4,
            physicalMemory: 4_294_967_296,
            freeMemory: 1_073_741_824,
            managedMemory: 2_147_483_648,
          },
          {
            id: 'tm-003',
            path: '/taskmanagers/tm-003',
            dataPort: 6121,
            freeSlots: 3,
            totalSlots: 4,
            cpuCores: 4,
            physicalMemory: 4_294_967_296,
            freeMemory: 1_073_741_824,
            managedMemory: 2_147_483_648,
          },
        ];
      case 'recovered':
        return [
          {
            id: 'tm-001',
            path: '/taskmanagers/tm-001',
            dataPort: 6121,
            freeSlots: 2,
            totalSlots: 4,
            cpuCores: 4,
            physicalMemory: 4_294_967_296,
            freeMemory: 1_610_612_736, // ~1.5GB — healthy
            managedMemory: 2_147_483_648,
          },
          {
            id: 'tm-002',
            path: '/taskmanagers/tm-002',
            dataPort: 6121,
            freeSlots: 2,
            totalSlots: 4,
            cpuCores: 4,
            physicalMemory: 4_294_967_296,
            freeMemory: 1_610_612_736,
            managedMemory: 2_147_483_648,
          },
          {
            id: 'tm-003',
            path: '/taskmanagers/tm-003',
            dataPort: 6121,
            freeSlots: 2,
            totalSlots: 4,
            cpuCores: 4,
            physicalMemory: 4_294_967_296,
            freeMemory: 1_610_612_736,
            managedMemory: 2_147_483_648,
          },
        ];
    }
  }

  async getBackpressure(_jobId: string): Promise<FlinkBackpressure[]> {
    switch (this.state) {
      case 'degraded':
        return [
          { subtask: 0, backpressureLevel: 'high', ratio: 0.92, idleRatio: 0.02, busyRatio: 0.96 },
          { subtask: 1, backpressureLevel: 'high', ratio: 0.87, idleRatio: 0.04, busyRatio: 0.91 },
          { subtask: 2, backpressureLevel: 'low', ratio: 0.35, idleRatio: 0.30, busyRatio: 0.55 },
          { subtask: 3, backpressureLevel: 'ok', ratio: 0.08, idleRatio: 0.60, busyRatio: 0.20 },
        ];
      case 'recovering':
        return [
          { subtask: 0, backpressureLevel: 'low', ratio: 0.28, idleRatio: 0.35, busyRatio: 0.50 },
          { subtask: 1, backpressureLevel: 'low', ratio: 0.22, idleRatio: 0.40, busyRatio: 0.45 },
          { subtask: 2, backpressureLevel: 'ok', ratio: 0.10, idleRatio: 0.55, busyRatio: 0.25 },
          { subtask: 3, backpressureLevel: 'ok', ratio: 0.05, idleRatio: 0.65, busyRatio: 0.15 },
        ];
      case 'recovered':
        return [
          { subtask: 0, backpressureLevel: 'ok', ratio: 0.03, idleRatio: 0.70, busyRatio: 0.15 },
          { subtask: 1, backpressureLevel: 'ok', ratio: 0.02, idleRatio: 0.72, busyRatio: 0.12 },
          { subtask: 2, backpressureLevel: 'ok', ratio: 0.01, idleRatio: 0.75, busyRatio: 0.10 },
          { subtask: 3, backpressureLevel: 'ok', ratio: 0.01, idleRatio: 0.78, busyRatio: 0.08 },
        ];
    }
  }

  async getExceptions(_jobId: string): Promise<FlinkException[]> {
    const now = Date.now();
    switch (this.state) {
      case 'degraded':
        return [
          {
            timestamp: now - 15_000,
            exception: 'java.lang.OutOfMemoryError: Java heap space',
            taskName: 'Source: KafkaSource -> Map',
            location: 'tm-001:6121',
          },
          {
            timestamp: now - 45_000,
            exception: 'org.apache.flink.runtime.checkpoint.CheckpointException: Checkpoint expired before completing. Timeout: 60000ms',
            taskName: 'Window(TumblingProcessingTimeWindows)',
            location: 'tm-001:6121',
          },
          {
            timestamp: now - 120_000,
            exception: 'java.lang.OutOfMemoryError: Direct buffer memory',
            taskName: 'Sink: KafkaSink',
            location: 'tm-003:6121',
          },
        ];
      case 'recovering':
        return [];
      case 'recovered':
        return [];
    }
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'structured_command') {
      throw new Error(`Unsupported Flink simulator command type: ${command.type}`);
    }

    switch (command.operation) {
      case 'job_status':
        return {
          jobs: await this.getJobStatus(),
          taskManagers: await this.getTaskManagers(),
        };
      case 'savepoint_trigger':
        this.transition('recovering');
        return { savepointTriggered: true, savepointPath: '/savepoints/sp-001' };
      case 'job_restart':
        this.transition('recovered');
        return { jobRestarted: true, jobId: 'job-abc123' };
      case 'checkpoint_configure':
        return { ok: true, operation: 'checkpoint_configure', parameters: command.parameters };
      case 'taskmanager_release':
        return { ok: true, operation: 'taskmanager_release', parameters: command.parameters };
      default:
        return { simulated: true, operation: command.operation, parameters: command.parameters };
    }
  }

  async evaluateCheck(check: CheckExpression): Promise<boolean> {
    const stmt = check.statement ?? '';

    if (stmt === 'job_state') {
      const jobs = await this.getJobStatus();
      const currentState = jobs[0]?.state ?? 'UNKNOWN';
      return this.compare(currentState, check.expect.operator, check.expect.value);
    }

    if (stmt === 'checkpoint_success_rate') {
      const checkpoints = await this.getCheckpointHistory('job-abc123');
      const completed = checkpoints.filter((cp) => cp.status === 'COMPLETED').length;
      const total = checkpoints.length;
      const rate = total > 0 ? completed / total : 0;
      return this.compare(rate, check.expect.operator, check.expect.value);
    }

    if (stmt === 'backpressure_level') {
      const bp = await this.getBackpressure('job-abc123');
      const highCount = bp.filter((b) => b.backpressureLevel === 'high').length;
      return this.compare(highCount, check.expect.operator, check.expect.value);
    }

    if (stmt === 'taskmanager_count') {
      const tms = await this.getTaskManagers();
      return this.compare(tms.length, check.expect.operator, check.expect.value);
    }

    return true;
  }

  listCapabilityProviders(): CapabilityProviderDescriptor[] {
    return [
      {
        id: 'flink-simulator-admin',
        kind: 'capability_provider',
        name: 'Flink Simulator Admin Provider',
        maturity: 'simulator_only',
        capabilities: [
          'stream.job.restart',
          'stream.savepoint.trigger',
          'stream.checkpoint.configure',
          'stream.taskmanager.release',
        ],
        executionContexts: ['flink_admin'],
        targetKinds: ['flink'],
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
