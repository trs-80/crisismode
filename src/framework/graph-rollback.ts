// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { StateGraph, Annotation, START, END, MemorySaver } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import type { StepResult } from '../types/execution-state.js';
import type { SystemActionStep } from '../types/step-types.js';
import type { Command } from '../types/common.js';
import type { ExecutionBackend } from './backend.js';
import type { ForensicLogEntry } from './graph-types.js';
import type { CaptureStore, StoredCapture } from './capture-store.js';
import { dynamicOps, makeTimestamp } from './graph-helpers.js';

/**
 * A rollback command derived from a stored capture.
 */
export interface CaptureRollbackCommand {
  /** Step ID this rollback targets */
  stepId: string;
  /** Human-readable description of what the rollback does */
  description: string;
  /** The command to execute for rollback */
  command: Command;
  /** The capture this was derived from */
  captureId: string;
  /** Type of restoration */
  restorationType: 'sql_restore' | 'config_restore' | 'api_restore' | 'file_restore';
}

/**
 * State schema for the rollback subgraph.
 */
const RollbackGraphState = Annotation.Root({
  /** Steps to roll back (in reverse order) */
  stepsToRollback: Annotation<StepResult[]>({
    reducer: (_existing, update) => update,
    default: () => [],
  }),

  /** Results of rollback executions — append */
  rollbackResults: Annotation<StepResult[]>({
    reducer: (existing, updates) => [...existing, ...updates],
    default: () => [],
  }),

  /** Forensic log for the rollback — append */
  forensicLog: Annotation<ForensicLogEntry[]>({
    reducer: (existing, updates) => [...existing, ...updates],
    default: () => [],
  }),

  /** Overall rollback outcome */
  rollbackOutcome: Annotation<'success' | 'partial' | 'failed' | 'pending'>({
    reducer: (_existing, update) => update,
    default: () => 'pending' as const,
  }),
});

type RollbackState = typeof RollbackGraphState.State;

/**
 * Extract steps that have rollback directives from completed steps.
 * Returns them in reverse order (most recent first) for stepwise rollback.
 */
export function extractRollbackSteps(completedSteps: StepResult[]): StepResult[] {
  return completedSteps
    .filter((result) => {
      if (result.step.type !== 'system_action') return false;
      const step = result.step as SystemActionStep;
      return step.rollback !== undefined && result.status === 'success';
    })
    .reverse();
}

/**
 * Generate rollback commands from stored captures for a given step.
 *
 * Examines the step's before-captures to find matching stored capture data,
 * then generates the appropriate restoration command.
 */
export async function generateCaptureRollbackCommands(
  stepResult: StepResult,
  store: CaptureStore,
): Promise<CaptureRollbackCommand[]> {
  if (stepResult.step.type !== 'system_action') return [];

  const step = stepResult.step as SystemActionStep;
  const commands: CaptureRollbackCommand[] = [];

  // Look for captures associated with this step
  const captures = await store.list({
    stepId: step.stepId,
    rollbackCapable: true,
  });

  for (const captureMeta of captures) {
    const stored = await store.get(captureMeta.id);
    if (!stored) continue;

    const rollbackCmd = deriveRollbackCommand(step, stored);
    if (rollbackCmd) {
      commands.push(rollbackCmd);
    }
  }

  return commands;
}

/**
 * Derive a rollback command from a stored capture's data.
 */
function deriveRollbackCommand(
  step: SystemActionStep,
  stored: StoredCapture,
): CaptureRollbackCommand | null {
  const data = stored.data as Record<string, unknown> | null;
  if (!data) return null;

  switch (stored.metadata.captureType) {
    case 'sql_query': {
      const statement = data.statement as string | undefined;
      const rows = data.rows;
      if (!statement || rows === undefined) return null;

      return {
        stepId: step.stepId,
        description: `Restore SQL state captured before: ${step.name}`,
        command: {
          type: 'sql',
          statement: generateSqlRestore(statement, rows),
        },
        captureId: stored.metadata.id,
        restorationType: 'sql_restore',
      };
    }

    case 'api_snapshot': {
      const endpoint = data.endpoint as string | undefined;
      const response = data.response;
      if (!endpoint || response === undefined) return null;

      return {
        stepId: step.stepId,
        description: `Restore API state captured before: ${step.name}`,
        command: {
          type: 'api_call',
          operation: 'restore',
          parameters: {
            endpoint,
            previousState: response,
          },
        },
        captureId: stored.metadata.id,
        restorationType: 'api_restore',
      };
    }

    case 'file_snapshot':
    case 'filesystem_snapshot': {
      const snapshots = data.snapshots as Record<string, unknown> | undefined;
      if (!snapshots) return null;

      return {
        stepId: step.stepId,
        description: `Restore file state captured before: ${step.name}`,
        command: {
          type: 'structured_command',
          operation: 'restore_files',
          parameters: { snapshots },
        },
        captureId: stored.metadata.id,
        restorationType: 'file_restore',
      };
    }

    default:
      return null;
  }
}

/**
 * Generate a SQL restore statement from a captured query and its results.
 *
 * For SELECT queries, generates a comment noting the captured state.
 * For configuration queries (SHOW, current_setting), generates SET commands.
 */
function generateSqlRestore(originalStatement: string, capturedRows: unknown): string {
  const upper = originalStatement.trim().toUpperCase();

  // SHOW or current_setting captures → generate SET
  if (upper.startsWith('SHOW ')) {
    const param = originalStatement.trim().slice(5).replace(/;$/, '').trim();
    const value = extractScalarValue(capturedRows);
    if (value !== null) {
      return `SET ${param} = '${String(value).replace(/'/g, "''")}'`;
    }
  }

  if (upper.includes('CURRENT_SETTING')) {
    const match = originalStatement.match(/current_setting\(\s*'([^']+)'/i);
    if (match) {
      const param = match[1];
      const value = extractScalarValue(capturedRows);
      if (value !== null) {
        return `SET ${param} = '${String(value).replace(/'/g, "''")}'`;
      }
    }
  }

  // For SELECT queries, return a restoration comment with the captured data
  return `-- Restore point: captured state from "${originalStatement}"\n-- Captured data: ${JSON.stringify(capturedRows)}`;
}

/**
 * Extract a scalar value from query results (handles common row formats).
 */
function extractScalarValue(rows: unknown): string | number | null {
  if (rows === null || rows === undefined) return null;

  // Direct scalar
  if (typeof rows === 'string' || typeof rows === 'number') return rows;

  // Array of row objects: [{ setting: 'value' }]
  if (Array.isArray(rows) && rows.length > 0) {
    const first = rows[0];
    if (typeof first === 'object' && first !== null) {
      const values = Object.values(first as Record<string, unknown>);
      if (values.length > 0) {
        const v = values[0];
        if (typeof v === 'string' || typeof v === 'number') return v;
      }
    }
    if (typeof first === 'string' || typeof first === 'number') return first;
  }

  return null;
}

/**
 * Build a rollback subgraph that executes rollback directives in reverse order.
 *
 * When a CaptureStore is provided, steps without explicit rollback commands
 * are checked for capture-derived rollback commands as a fallback.
 */
export function buildRollbackGraph(
  stepsToRollback: StepResult[],
  backend: ExecutionBackend,
  checkpointer?: BaseCheckpointSaver,
  captureStore?: CaptureStore,
) {
  const builder = new StateGraph(RollbackGraphState);
  const nodeCount = stepsToRollback.length;

  if (nodeCount === 0) {
    builder.addNode('noop', () => ({
      rollbackOutcome: 'success' as const,
      forensicLog: [{
        timestamp: makeTimestamp(),
        type: 'info' as const,
        message: 'No rollback steps to execute',
      }],
    }));
    const g = dynamicOps(builder);
    g.addEdge(START, 'noop');
    g.addEdge('noop', END);
    return g.compile({ checkpointer: checkpointer ?? new MemorySaver() });
  }

  for (let i = 0; i < nodeCount; i++) {
    const stepResult = stepsToRollback[i];
    const step = stepResult.step as SystemActionStep;
    const rollback = step.rollback!;
    const nodeName = `rollback_${i}`;

    builder.addNode(nodeName, async (_state: RollbackState) => {
      const startTime = Date.now();
      const startedAt = makeTimestamp();
      const logs: ForensicLogEntry[] = [{
        timestamp: makeTimestamp(),
        type: 'step_start',
        stepId: step.stepId,
        message: `Rolling back: ${step.name} — ${rollback.description}`,
      }];

      if (rollback.type === 'command' && rollback.command) {
        try {
          await backend.executeCommand(rollback.command);
          logs.push({
            timestamp: makeTimestamp(),
            type: 'step_complete',
            stepId: step.stepId,
            message: `Rollback command executed: ${rollback.description}`,
          });

          return {
            rollbackResults: [{
              stepId: `rollback-${step.stepId}`,
              step: stepResult.step,
              status: 'rolled_back' as const,
              startedAt,
              completedAt: makeTimestamp(),
              durationMs: Date.now() - startTime,
            }],
            forensicLog: logs,
          };
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logs.push({
            timestamp: makeTimestamp(),
            type: 'step_failed',
            stepId: step.stepId,
            message: `Rollback command failed: ${errMsg}`,
          });

          return {
            rollbackResults: [{
              stepId: `rollback-${step.stepId}`,
              step: stepResult.step,
              status: 'failed' as const,
              startedAt,
              completedAt: makeTimestamp(),
              durationMs: Date.now() - startTime,
              error: `Rollback failed: ${errMsg}`,
            }],
            forensicLog: logs,
            rollbackOutcome: 'partial' as const,
          };
        }
      }

      // Try capture-based rollback if no explicit command and store is available
      if (rollback.type === 'automatic' && captureStore) {
        const captureCommands = await generateCaptureRollbackCommands(stepResult, captureStore);

        if (captureCommands.length > 0) {
          const errors: string[] = [];

          for (const cmd of captureCommands) {
            try {
              await backend.executeCommand(cmd.command);
              logs.push({
                timestamp: makeTimestamp(),
                type: 'step_complete',
                stepId: step.stepId,
                message: `Capture-based rollback executed: ${cmd.description} (capture: ${cmd.captureId})`,
              });
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              errors.push(errMsg);
              logs.push({
                timestamp: makeTimestamp(),
                type: 'step_failed',
                stepId: step.stepId,
                message: `Capture-based rollback failed: ${errMsg}`,
              });
            }
          }

          if (errors.length === 0) {
            return {
              rollbackResults: [{
                stepId: `rollback-${step.stepId}`,
                step: stepResult.step,
                status: 'rolled_back' as const,
                startedAt,
                completedAt: makeTimestamp(),
                durationMs: Date.now() - startTime,
              }],
              forensicLog: logs,
            };
          }

          return {
            rollbackResults: [{
              stepId: `rollback-${step.stepId}`,
              step: stepResult.step,
              status: 'failed' as const,
              startedAt,
              completedAt: makeTimestamp(),
              durationMs: Date.now() - startTime,
              error: `Capture-based rollback partially failed: ${errors.join('; ')}`,
            }],
            forensicLog: logs,
            rollbackOutcome: 'partial' as const,
          };
        }
      }

      // Manual or automatic rollback without captures — log but don't execute
      logs.push({
        timestamp: makeTimestamp(),
        type: 'info',
        stepId: step.stepId,
        message: `Rollback type '${rollback.type}': ${rollback.description} (requires ${rollback.type === 'manual' ? 'manual intervention' : 'automatic handling'})`,
      });

      return {
        rollbackResults: [{
          stepId: `rollback-${step.stepId}`,
          step: stepResult.step,
          status: 'rolled_back' as const,
          startedAt,
          completedAt: makeTimestamp(),
          durationMs: Date.now() - startTime,
        }],
        forensicLog: logs,
      };
    });
  }

  // Wire edges sequentially
  const g = dynamicOps(builder);

  g.addEdge(START, 'rollback_0');
  for (let i = 0; i < nodeCount - 1; i++) {
    g.addEdge(`rollback_${i}`, `rollback_${i + 1}`);
  }
  g.addEdge(`rollback_${nodeCount - 1}`, END);

  return g.compile({ checkpointer: checkpointer ?? new MemorySaver() });
}

/**
 * Execute rollback for a failed recovery plan.
 *
 * Walks backward through completed steps, finds those with rollback directives,
 * and executes them as a subgraph with its own checkpoint thread.
 *
 * When a CaptureStore is provided, steps with 'automatic' rollback type
 * will attempt to derive rollback commands from stored captures.
 */
export async function executeRollback(
  completedSteps: StepResult[],
  backend: ExecutionBackend,
  checkpointer?: BaseCheckpointSaver,
  captureStore?: CaptureStore,
): Promise<{ results: StepResult[]; logs: ForensicLogEntry[] }> {
  const stepsToRollback = extractRollbackSteps(completedSteps);

  if (stepsToRollback.length === 0) {
    return {
      results: [],
      logs: [{
        timestamp: makeTimestamp(),
        type: 'info',
        message: 'No steps with rollback directives found',
      }],
    };
  }

  const graph = buildRollbackGraph(stepsToRollback, backend, checkpointer, captureStore);
  const config = { configurable: { thread_id: `rollback-${Date.now()}` } };

  let finalState: RollbackState | undefined;

  for await (const event of await graph.stream(
    { stepsToRollback },
    { ...config, streamMode: 'values' as const },
  )) {
    const candidate = event as RollbackState;
    if (candidate.rollbackResults !== undefined) {
      finalState = candidate;
    }
  }

  return {
    results: finalState?.rollbackResults ?? [],
    logs: finalState?.forensicLog ?? [],
  };
}
