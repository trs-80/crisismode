// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateCaptureRollbackCommands } from '../framework/graph-rollback.js';
import { CaptureStore } from '../framework/capture-store.js';
import type { StepResult } from '../types/execution-state.js';
import type { SystemActionStep } from '../types/step-types.js';

let testDir: string;
let store: CaptureStore;

function makeSystemAction(overrides: Partial<SystemActionStep> = {}): SystemActionStep {
  return {
    stepId: 'step-1',
    type: 'system_action',
    name: 'Test Action',
    executionContext: 'pg-primary',
    target: 'pg-primary-us-east-1',
    riskLevel: 'elevated',
    requiredCapabilities: ['db.query.write'],
    command: { type: 'sql', statement: 'ALTER SYSTEM SET wal_level = logical' },
    statePreservation: { before: [], after: [] },
    successCriteria: {
      description: 'Setting applied',
      check: { type: 'sql', statement: 'SHOW wal_level', expect: { operator: 'eq', value: 'logical' } },
    },
    blastRadius: {
      directComponents: ['pg-primary'],
      indirectComponents: ['pg-replicas'],
      maxImpact: 'database configuration change',
      cascadeRisk: 'low',
    },
    timeout: '30s',
    ...overrides,
  };
}

function makeStepResult(step: SystemActionStep): StepResult {
  return {
    stepId: step.stepId,
    step,
    status: 'success',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 100,
  };
}

beforeEach(async () => {
  testDir = join(tmpdir(), `crisismode-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  store = new CaptureStore(testDir);
  await store.initialize();
});

afterEach(async () => {
  try { await fs.rm(testDir, { recursive: true }); } catch { /* */ }
});

describe('generateCaptureRollbackCommands', () => {
  it('generates SQL restore from SHOW query capture', async () => {
    const step = makeSystemAction();
    const stepResult = makeStepResult(step);

    await store.store({
      name: 'wal_level_before',
      captureType: 'sql_query',
      data: {
        statement: 'SHOW wal_level',
        rows: [{ wal_level: 'replica' }],
        capturedAt: new Date().toISOString(),
      },
      stepId: step.stepId,
      rollbackCapable: true,
    });

    const commands = await generateCaptureRollbackCommands(stepResult, store);
    expect(commands).toHaveLength(1);
    expect(commands[0].restorationType).toBe('sql_restore');
    expect(commands[0].command.type).toBe('sql');
    expect(commands[0].command.statement).toContain("SET wal_level = 'replica'");
    expect(commands[0].captureId).toBeTruthy();
  });

  it('generates SQL restore from current_setting capture', async () => {
    const step = makeSystemAction();
    const stepResult = makeStepResult(step);

    await store.store({
      name: 'max_connections_before',
      captureType: 'sql_query',
      data: {
        statement: "SELECT current_setting('max_connections')",
        rows: [{ current_setting: '100' }],
        capturedAt: new Date().toISOString(),
      },
      stepId: step.stepId,
      rollbackCapable: true,
    });

    const commands = await generateCaptureRollbackCommands(stepResult, store);
    expect(commands).toHaveLength(1);
    expect(commands[0].command.statement).toContain("SET max_connections = '100'");
  });

  it('generates comment-based restore for SELECT queries', async () => {
    const step = makeSystemAction();
    const stepResult = makeStepResult(step);

    await store.store({
      name: 'repl_state',
      captureType: 'sql_query',
      data: {
        statement: 'SELECT * FROM pg_stat_replication',
        rows: [{ pid: 123, state: 'streaming' }],
        capturedAt: new Date().toISOString(),
      },
      stepId: step.stepId,
      rollbackCapable: true,
    });

    const commands = await generateCaptureRollbackCommands(stepResult, store);
    expect(commands).toHaveLength(1);
    expect(commands[0].command.statement).toContain('-- Restore point');
  });

  it('generates API restore command from api_snapshot', async () => {
    const step = makeSystemAction();
    const stepResult = makeStepResult(step);

    await store.store({
      name: 'api_state',
      captureType: 'api_snapshot',
      data: {
        endpoint: '/api/config',
        response: { feature_flags: { dark_mode: true } },
        capturedAt: new Date().toISOString(),
      },
      stepId: step.stepId,
      rollbackCapable: true,
    });

    const commands = await generateCaptureRollbackCommands(stepResult, store);
    expect(commands).toHaveLength(1);
    expect(commands[0].restorationType).toBe('api_restore');
    expect(commands[0].command.type).toBe('api_call');
    expect(commands[0].command.operation).toBe('restore');
    expect(commands[0].command.parameters!.endpoint).toBe('/api/config');
  });

  it('generates file restore command from file_snapshot', async () => {
    const step = makeSystemAction();
    const stepResult = makeStepResult(step);

    await store.store({
      name: 'config_snapshot',
      captureType: 'file_snapshot',
      data: {
        files: ['/etc/app/config.yaml'],
        snapshots: { '/etc/app/config.yaml': 'key: value\n' },
        snapshotId: 'snap-123',
        capturedAt: new Date().toISOString(),
      },
      stepId: step.stepId,
      rollbackCapable: true,
    });

    const commands = await generateCaptureRollbackCommands(stepResult, store);
    expect(commands).toHaveLength(1);
    expect(commands[0].restorationType).toBe('file_restore');
    expect(commands[0].command.type).toBe('structured_command');
    expect(commands[0].command.operation).toBe('restore_files');
    expect(commands[0].command.parameters!.snapshots).toEqual({
      '/etc/app/config.yaml': 'key: value\n',
    });
  });

  it('returns empty array for non-system-action steps', async () => {
    const stepResult: StepResult = {
      stepId: 'diag-1',
      step: {
        stepId: 'diag-1',
        type: 'diagnosis_action',
        name: 'Check health',
        executionContext: 'pg-primary',
        target: 'pg-primary',
        command: { type: 'sql', statement: 'SELECT 1' },
        timeout: '10s',
      },
      status: 'success',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 50,
    };

    const commands = await generateCaptureRollbackCommands(stepResult, store);
    expect(commands).toHaveLength(0);
  });

  it('returns empty array when no captures exist for step', async () => {
    const step = makeSystemAction({ stepId: 'orphan-step' });
    const stepResult = makeStepResult(step);

    const commands = await generateCaptureRollbackCommands(stepResult, store);
    expect(commands).toHaveLength(0);
  });

  it('skips non-rollback-capable captures', async () => {
    const step = makeSystemAction();
    const stepResult = makeStepResult(step);

    await store.store({
      name: 'log_output',
      captureType: 'command_output',
      data: { output: 'some log data' },
      stepId: step.stepId,
      rollbackCapable: false,
    });

    const commands = await generateCaptureRollbackCommands(stepResult, store);
    expect(commands).toHaveLength(0);
  });

  it('handles multiple captures for same step', async () => {
    const step = makeSystemAction();
    const stepResult = makeStepResult(step);

    await store.store({
      name: 'wal_level',
      captureType: 'sql_query',
      data: {
        statement: 'SHOW wal_level',
        rows: [{ wal_level: 'replica' }],
        capturedAt: new Date().toISOString(),
      },
      stepId: step.stepId,
      rollbackCapable: true,
    });

    await store.store({
      name: 'config_files',
      captureType: 'file_snapshot',
      data: {
        files: ['/etc/pg/conf.d/custom.conf'],
        snapshots: { '/etc/pg/conf.d/custom.conf': 'wal_level = replica' },
        capturedAt: new Date().toISOString(),
      },
      stepId: step.stepId,
      rollbackCapable: true,
    });

    const commands = await generateCaptureRollbackCommands(stepResult, store);
    expect(commands).toHaveLength(2);
    const types = commands.map((c) => c.restorationType).sort();
    expect(types).toEqual(['file_restore', 'sql_restore']);
  });

  it('escapes single quotes in SQL restore values', async () => {
    const step = makeSystemAction();
    const stepResult = makeStepResult(step);

    await store.store({
      name: 'search_path',
      captureType: 'sql_query',
      data: {
        statement: 'SHOW search_path',
        rows: [{ search_path: "\"$user\", public, 'custom'" }],
        capturedAt: new Date().toISOString(),
      },
      stepId: step.stepId,
      rollbackCapable: true,
    });

    const commands = await generateCaptureRollbackCommands(stepResult, store);
    expect(commands).toHaveLength(1);
    // Should escape single quotes
    expect(commands[0].command.statement).toContain("''custom''");
  });
});
