// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { StateGraph, Annotation, START, END, MemorySaver } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import type { StepResult } from '../types/execution-state.js';
import type { SystemActionStep } from '../types/step-types.js';
import type { ExecutionBackend } from './backend.js';
import type { ForensicLogEntry } from './graph-types.js';

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

function makeTimestamp(): string {
  return new Date().toISOString();
}

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
 * Build a rollback subgraph that executes rollback directives in reverse order.
 *
 * Each rollback step becomes a node. The subgraph has its own checkpoint thread
 * for auditability — the rollback execution is tracked independently of the
 * forward execution.
 */
export function buildRollbackGraph(
  stepsToRollback: StepResult[],
  backend: ExecutionBackend,
  checkpointer?: BaseCheckpointSaver,
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
    const g = builder as unknown as {
      addEdge(from: string, to: string): unknown;
      compile(opts: { checkpointer: BaseCheckpointSaver }): ReturnType<typeof builder.compile>;
    };
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

      // Manual or automatic rollback — log but don't execute
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
  const g = builder as unknown as {
    addEdge(from: string, to: string): unknown;
    compile(opts: { checkpointer: BaseCheckpointSaver }): ReturnType<typeof builder.compile>;
  };

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
 */
export async function executeRollback(
  completedSteps: StepResult[],
  backend: ExecutionBackend,
  checkpointer?: BaseCheckpointSaver,
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

  const graph = buildRollbackGraph(stepsToRollback, backend, checkpointer);
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
