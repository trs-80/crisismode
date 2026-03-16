// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';
import { MemorySaver } from '@langchain/langgraph';

vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }));

import { extractRollbackSteps, executeRollback } from '../framework/graph-rollback.js';
import type { StepResult } from '../types/execution-state.js';
import type { SystemActionStep } from '../types/step-types.js';
import type { ExecutionBackend } from '../framework/backend.js';
import { StreamingForensicRecorder } from '../framework/forensics.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync, existsSync } from 'node:fs';

function makeSystemActionResult(
  stepId: string,
  name: string,
  status: 'success' | 'failed',
  rollback?: SystemActionStep['rollback'],
): StepResult {
  const step: SystemActionStep = {
    stepId,
    type: 'system_action',
    name,
    executionContext: 'psql_cli',
    target: 'pg-primary',
    riskLevel: 'elevated',
    requiredCapabilities: [],
    command: { type: 'sql', statement: `-- ${name}` },
    statePreservation: { before: [], after: [] },
    successCriteria: {
      description: 'OK',
      check: { type: 'sql', statement: 'SELECT 1', expect: { operator: 'eq', value: 1 } },
    },
    blastRadius: {
      directComponents: ['pg-primary'],
      indirectComponents: [],
      maxImpact: 'test',
      cascadeRisk: 'low',
    },
    timeout: 'PT30S',
    rollback,
  };

  return {
    stepId,
    step,
    status,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 10,
  };
}

describe('Rollback', () => {
  describe('extractRollbackSteps', () => {
    it('returns successful steps with rollback directives in reverse order', () => {
      const steps: StepResult[] = [
        makeSystemActionResult('step-1', 'Disconnect replica', 'success', {
          type: 'command',
          description: 'Reconnect replica',
          command: { type: 'sql', statement: 'SELECT pg_wal_replay_resume()' },
        }),
        makeSystemActionResult('step-2', 'Flush WAL', 'success', {
          type: 'command',
          description: 'Undo WAL flush',
          command: { type: 'sql', statement: 'SELECT pg_wal_replay_pause()' },
        }),
        makeSystemActionResult('step-3', 'Verify health', 'success'), // No rollback
        makeSystemActionResult('step-4', 'Promote replica', 'failed', {
          type: 'manual',
          description: 'Demote replica manually',
        }),
      ];

      const rollbackSteps = extractRollbackSteps(steps);
      // Only step-1 and step-2 qualify (successful + have rollback)
      // Returned in reverse: step-2 first, then step-1
      expect(rollbackSteps).toHaveLength(2);
      expect(rollbackSteps[0].stepId).toBe('step-2');
      expect(rollbackSteps[1].stepId).toBe('step-1');
    });

    it('returns empty array when no steps have rollback directives', () => {
      const steps: StepResult[] = [
        makeSystemActionResult('step-1', 'Health check', 'success'),
      ];
      expect(extractRollbackSteps(steps)).toHaveLength(0);
    });
  });

  describe('executeRollback', () => {
    it('executes rollback commands in reverse order', async () => {
      const executedCommands: string[] = [];
      const backend: ExecutionBackend = {
        executeCommand: async (cmd) => {
          executedCommands.push(cmd.statement ?? cmd.operation ?? 'unknown');
          return { ok: true };
        },
        evaluateCheck: async () => true,
        close: async () => {},
      };

      const completedSteps: StepResult[] = [
        makeSystemActionResult('step-1', 'Disconnect replica', 'success', {
          type: 'command',
          description: 'Reconnect replica',
          command: { type: 'sql', statement: 'RECONNECT_REPLICA' },
        }),
        makeSystemActionResult('step-2', 'Flush WAL', 'success', {
          type: 'command',
          description: 'Undo WAL flush',
          command: { type: 'sql', statement: 'UNDO_WAL_FLUSH' },
        }),
      ];

      const { results, logs } = await executeRollback(completedSteps, backend, new MemorySaver());

      expect(results).toHaveLength(2);
      expect(results[0].stepId).toBe('rollback-step-2');
      expect(results[0].status).toBe('rolled_back');
      expect(results[1].stepId).toBe('rollback-step-1');
      expect(results[1].status).toBe('rolled_back');

      // Commands should execute in reverse order
      expect(executedCommands).toEqual(['UNDO_WAL_FLUSH', 'RECONNECT_REPLICA']);
      expect(logs.length).toBeGreaterThan(0);
    });

    it('handles rollback command failure gracefully', async () => {
      let callCount = 0;
      const backend: ExecutionBackend = {
        executeCommand: async () => {
          callCount++;
          if (callCount === 1) throw new Error('Connection refused');
          return { ok: true };
        },
        evaluateCheck: async () => true,
        close: async () => {},
      };

      const completedSteps: StepResult[] = [
        makeSystemActionResult('step-1', 'Step A', 'success', {
          type: 'command',
          description: 'Undo A',
          command: { type: 'sql', statement: 'UNDO_A' },
        }),
        makeSystemActionResult('step-2', 'Step B', 'success', {
          type: 'command',
          description: 'Undo B',
          command: { type: 'sql', statement: 'UNDO_B' },
        }),
      ];

      const { results } = await executeRollback(completedSteps, backend, new MemorySaver());

      // First rollback (step-2) fails, second (step-1) succeeds
      expect(results).toHaveLength(2);
      expect(results[0].status).toBe('failed');
      expect(results[0].error).toContain('Connection refused');
      expect(results[1].status).toBe('rolled_back');
    });

    it('returns empty results when no rollback directives exist', async () => {
      const backend: ExecutionBackend = {
        executeCommand: async () => ({ ok: true }),
        evaluateCheck: async () => true,
        close: async () => {},
      };

      const completedSteps: StepResult[] = [
        makeSystemActionResult('step-1', 'Health check', 'success'),
      ];

      const { results, logs } = await executeRollback(completedSteps, backend);
      expect(results).toHaveLength(0);
      expect(logs[0].message).toContain('No steps with rollback');
    });

    it('handles manual rollback directives', async () => {
      const backend: ExecutionBackend = {
        executeCommand: vi.fn(async () => ({ ok: true })),
        evaluateCheck: async () => true,
        close: async () => {},
      };

      const completedSteps: StepResult[] = [
        makeSystemActionResult('step-1', 'Manual action', 'success', {
          type: 'manual',
          description: 'Requires manual intervention to undo',
        }),
      ];

      const { results, logs } = await executeRollback(completedSteps, backend, new MemorySaver());
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('rolled_back');
      // Should not have called executeCommand for manual rollback
      expect(backend.executeCommand).not.toHaveBeenCalled();

      const manualLog = logs.find((l) => l.message?.includes('manual intervention'));
      expect(manualLog).toBeDefined();
    });
  });

  describe('StreamingForensicRecorder', () => {
    it('persists forensic entries to JSONL file', () => {
      const logPath = join(tmpdir(), `crisismode-test-${Date.now()}.jsonl`);
      const recorder = new StreamingForensicRecorder(logPath);

      recorder.addLogEntry({ type: 'step_start', stepId: 'step-1', message: 'Starting step 1' });
      recorder.addLogEntry({ type: 'step_complete', stepId: 'step-1', message: 'Step 1 complete' });

      expect(existsSync(logPath)).toBe(true);

      const entries = recorder.readPersistedEntries();
      expect(entries).toHaveLength(2);
      expect(entries[0].type).toBe('step_start');
      expect(entries[0].stepId).toBe('step-1');
      expect(entries[1].type).toBe('step_complete');
    });

    it('persists step results to JSONL file', () => {
      const logPath = join(tmpdir(), `crisismode-test-${Date.now()}.jsonl`);
      const recorder = new StreamingForensicRecorder(logPath);

      recorder.addStepResult({
        stepId: 'step-1',
        step: { stepId: 'step-1', type: 'human_notification', name: 'test' } as any,
        status: 'success',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 5,
      });

      const entries = recorder.readPersistedEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('step_result');
      expect(entries[0].status).toBe('success');
    });
  });
});
