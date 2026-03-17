// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * QueueBackend — interface for querying queue and worker state.
 * Both the simulator and live client implement this.
 */

import type { ExecutionBackend } from '../../framework/backend.js';

export interface QueueStats {
  name: string;
  depth: number;
  processingRate: number;
  errorRate: number;
  oldestMessageAge: number;
  paused: boolean;
}

export interface WorkerStatus {
  id: string;
  status: 'active' | 'idle' | 'stuck' | 'dead';
  currentJob?: string;
  lastHeartbeat: string;
  processedCount: number;
}

export interface DeadLetterStats {
  depth: number;
  oldestAge: number;
  recentErrors: string[];
}

export interface ProcessingRateInfo {
  incomingRate: number;
  processingRate: number;
  backlogGrowthRate: number;
  estimatedClearTime: number;
}

export interface QueueBackend extends ExecutionBackend {
  /** Get per-queue depth, processing rate, error rate */
  getQueueStats(): Promise<QueueStats[]>;

  /** Get worker health, processing count, last heartbeat */
  getWorkerStatus(): Promise<WorkerStatus[]>;

  /** Get DLQ depth, oldest message age, recent errors */
  getDeadLetterStats(): Promise<DeadLetterStats>;

  /** Get messages/sec in vs out, backlog growth rate */
  getProcessingRate(): Promise<ProcessingRateInfo>;

  /** Optional simulator-only state transitions */
  transition?(to: string): void;
}
