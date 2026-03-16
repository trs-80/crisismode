// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { writeFileSync, appendFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ForensicRecord, ExecutionLogEntry } from '../types/forensic-record.js';
import type { AgentContext } from '../types/agent-context.js';
import type { DiagnosisResult } from '../types/diagnosis-result.js';
import type { RecoveryPlan } from '../types/recovery-plan.js';
import type { StepResult } from '../types/execution-state.js';
import type { CaptureResult } from './safety.js';

export class ForensicRecorder {
  private log: ExecutionLogEntry[] = [];
  private captures: ForensicRecord['captures'] = [];
  private stepResults: StepResult[] = [];
  private plans: RecoveryPlan[] = [];
  private context: AgentContext | null = null;
  private diagnosis: DiagnosisResult | null = null;
  private startTime: number = Date.now();
  private catalogMatchUsed = false;
  private replanCount = 0;

  setContext(context: AgentContext): void {
    this.context = context;
  }

  setDiagnosis(diagnosis: DiagnosisResult): void {
    this.diagnosis = diagnosis;
  }

  addPlan(plan: RecoveryPlan): void {
    this.plans.push(plan);
  }

  addLogEntry(entry: Omit<ExecutionLogEntry, 'timestamp'>): void {
    this.log.push({ ...entry, timestamp: new Date().toISOString() });
  }

  addCapture(capture: CaptureResult): void {
    this.captures.push({
      name: capture.name,
      captureType: capture.captureType,
      status: capture.status,
      reason: capture.reason,
      timestamp: capture.timestamp,
      data: capture.data,
    });
  }

  addStepResult(result: StepResult): void {
    this.stepResults.push(result);
  }

  setCatalogMatchUsed(used: boolean): void {
    this.catalogMatchUsed = used;
  }

  incrementReplanCount(): void {
    this.replanCount++;
  }

  buildRecord(): ForensicRecord {
    const completedSteps = this.stepResults.filter((r) => r.status === 'success').length;
    const failedSteps = this.stepResults.filter((r) => r.status === 'failed').length;
    const skippedSteps = this.stepResults.filter((r) => r.status === 'skipped').length;
    const capturesAttempted = this.captures.length;
    const capturesSucceeded = this.captures.filter((c) => c.status === 'captured').length;
    const capturesSkipped = this.captures.filter((c) => c.status === 'skipped').length;

    const allCapturesSuccess = capturesSkipped === 0 && this.captures.every((c) => c.status === 'captured');

    // Determine outcome based on step results
    const wasAborted = this.stepResults.some(
      (r) => r.status === 'failed' && r.error?.includes('aborted'),
    );
    const wasSkippedAtApprovalGate = this.stepResults.some(
      (r) => r.status === 'skipped' && r.step.type === 'human_approval',
    );
    let outcome: ForensicRecord['summary']['outcome'];
    if (wasAborted || wasSkippedAtApprovalGate) {
      outcome = 'aborted';
    } else if (failedSteps > 0 && completedSteps === 0) {
      outcome = 'failed';
    } else if (failedSteps > 0) {
      outcome = 'partial_success';
    } else {
      outcome = 'success';
    }

    return {
      recordId: `fr-${Date.now()}`,
      createdAt: new Date(this.startTime).toISOString(),
      completedAt: new Date().toISOString(),
      completeness: allCapturesSuccess ? 'complete' : capturesSucceeded > 0 ? 'partial' : 'minimal',
      context: this.context!,
      diagnosis: this.diagnosis!,
      plans: this.plans,
      executionLog: this.log,
      stepResults: this.stepResults,
      captures: this.captures,
      summary: {
        totalSteps: this.stepResults.length,
        completedSteps,
        failedSteps,
        skippedSteps,
        totalDurationMs: Date.now() - this.startTime,
        capturesAttempted,
        capturesSucceeded,
        capturesSkipped,
        catalogMatchUsed: this.catalogMatchUsed,
        replanCount: this.replanCount,
        outcome,
      },
    };
  }

  writeToFile(path: string): ForensicRecord {
    const record = this.buildRecord();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(record, null, 2), 'utf-8');
    return record;
  }
}

/**
 * Crash-safe forensic recorder that writes entries to an append-only JSONL file.
 *
 * Each graph node's forensic log entries are flushed to disk immediately,
 * so on crash recovery the log is reconstructable from the local JSONL store
 * combined with the graph checkpoint.
 */
export class StreamingForensicRecorder extends ForensicRecorder {
  private logPath: string;

  constructor(logPath: string) {
    super();
    this.logPath = logPath;
    mkdirSync(dirname(logPath), { recursive: true });
    // Initialize empty file
    writeFileSync(logPath, '', 'utf-8');
  }

  override addLogEntry(entry: Omit<ExecutionLogEntry, 'timestamp'>): void {
    super.addLogEntry(entry);
    const timestamped = { ...entry, timestamp: new Date().toISOString() };
    appendFileSync(this.logPath, JSON.stringify(timestamped) + '\n', 'utf-8');
  }

  override addStepResult(result: StepResult): void {
    super.addStepResult(result);
    const logLine = {
      type: 'step_result' as const,
      stepId: result.stepId,
      status: result.status,
      durationMs: result.durationMs,
      error: result.error,
      timestamp: new Date().toISOString(),
    };
    appendFileSync(this.logPath, JSON.stringify(logLine) + '\n', 'utf-8');
  }

  /**
   * Read all forensic entries from the JSONL file.
   * Used for crash recovery — reconstructs the log from what was persisted.
   */
  readPersistedEntries(): Array<Record<string, unknown>> {
    const content = readFileSync(this.logPath, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').map((line) => JSON.parse(line));
  }

  getLogPath(): string {
    return this.logPath;
  }
}
