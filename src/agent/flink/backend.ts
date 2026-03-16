// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * FlinkBackend — interface for querying Flink stream processing state.
 * Both the simulator and live client implement this.
 */

import type { ExecutionBackend } from '../../framework/backend.js';

export interface FlinkJobStatus {
  jobId: string;
  name: string;
  state: 'RUNNING' | 'FAILING' | 'FAILED' | 'CANCELLING' | 'CANCELED' | 'RESTARTING' | 'CREATED';
  startTime: number;
  duration: number;
  parallelism: number;
  maxParallelism: number;
}

export interface FlinkCheckpointInfo {
  id: number;
  status: 'COMPLETED' | 'FAILED' | 'IN_PROGRESS';
  triggerTimestamp: number;
  duration: number;
  size: number;
  alignmentBuffered: number;
  processedData: number;
  failureReason?: string;
}

export interface FlinkTaskManager {
  id: string;
  path: string;
  dataPort: number;
  freeSlots: number;
  totalSlots: number;
  cpuCores: number;
  physicalMemory: number;
  freeMemory: number;
  managedMemory: number;
}

export interface FlinkBackpressure {
  subtask: number;
  backpressureLevel: 'ok' | 'low' | 'high';
  ratio: number;
  idleRatio: number;
  busyRatio: number;
}

export interface FlinkException {
  timestamp: number;
  exception: string;
  taskName: string;
  location: string;
}

export interface FlinkBackend extends ExecutionBackend {
  /** Get status of all Flink jobs */
  getJobStatus(): Promise<FlinkJobStatus[]>;

  /** Get checkpoint history for a job */
  getCheckpointHistory(jobId: string): Promise<FlinkCheckpointInfo[]>;

  /** Get all registered TaskManagers */
  getTaskManagers(): Promise<FlinkTaskManager[]>;

  /** Get backpressure metrics for a job */
  getBackpressure(jobId: string): Promise<FlinkBackpressure[]>;

  /** Get recent exceptions for a job */
  getExceptions(jobId: string): Promise<FlinkException[]>;

  /** Optional simulator-only state transitions */
  transition?(to: string): void;
}
