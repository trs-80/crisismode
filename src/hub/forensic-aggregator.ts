// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { ForensicRecord } from '../types/forensic-record.js';

/**
 * Interface for persisting aggregated forensic records from spokes.
 */
export interface ForensicStore {
  store(record: ForensicRecord): Promise<string>;
  retrieve(recordId: string): Promise<ForensicRecord | null>;
  listByAgent(agentName: string, limit?: number): Promise<ForensicRecord[]>;
  listByScenario(scenario: string, limit?: number): Promise<ForensicRecord[]>;
}

/**
 * In-memory forensic store for testing and development.
 */
export class InMemoryForensicStore implements ForensicStore {
  private records = new Map<string, ForensicRecord>();

  async store(record: ForensicRecord): Promise<string> {
    this.records.set(record.recordId, record);
    return record.recordId;
  }

  async retrieve(recordId: string): Promise<ForensicRecord | null> {
    return this.records.get(recordId) ?? null;
  }

  async listByAgent(agentName: string, limit = 50): Promise<ForensicRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.plans.some((p) => p.metadata.agentName === agentName))
      .slice(0, limit);
  }

  async listByScenario(scenario: string, limit = 50): Promise<ForensicRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.plans.some((p) => p.metadata.scenario === scenario))
      .slice(0, limit);
  }

  getAll(): ForensicRecord[] {
    return [...this.records.values()];
  }
}

/**
 * ForensicAggregator collects forensic records from spokes and computes
 * aggregate metrics for the trust scoring system.
 */
export class ForensicAggregator {
  constructor(private store: ForensicStore) {}

  async ingestRecord(record: ForensicRecord): Promise<string> {
    return this.store.store(record);
  }

  async computeAgentStats(agentName: string): Promise<{
    totalExecutions: number;
    successRate: number;
    avgDurationMs: number;
    replanRate: number;
  }> {
    const records = await this.store.listByAgent(agentName);

    if (records.length === 0) {
      return { totalExecutions: 0, successRate: 0, avgDurationMs: 0, replanRate: 0 };
    }

    const successes = records.filter((r) => r.summary.outcome === 'success').length;
    const totalDuration = records.reduce((sum, r) => sum + r.summary.totalDurationMs, 0);
    const replans = records.filter((r) => r.summary.replanCount > 0).length;

    return {
      totalExecutions: records.length,
      successRate: successes / records.length,
      avgDurationMs: totalDuration / records.length,
      replanRate: replans / records.length,
    };
  }
}
