// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeCapture, executeCaptureAsync } from '../framework/safety.js';
import { CaptureStore } from '../framework/capture-store.js';
import type { ExecutionBackend } from '../framework/backend.js';
import type { CaptureDirective } from '../types/common.js';

function makeBackend(results: Record<string, unknown> = {}): ExecutionBackend {
  return {
    executeCommand: async (cmd) => {
      const key = cmd.statement ?? cmd.operation ?? cmd.type;
      if (key && key in results) return results[key];
      return { executed: true, command: cmd };
    },
    evaluateCheck: async () => true,
    close: async () => {},
  };
}

function makeFailingBackend(error: string): ExecutionBackend {
  return {
    executeCommand: async () => { throw new Error(error); },
    evaluateCheck: async () => true,
    close: async () => {},
  };
}

const sqlCapture: CaptureDirective = {
  name: 'pg_repl_state',
  captureType: 'sql_query',
  statement: "SELECT * FROM pg_stat_replication",
  captureCost: 'negligible',
  capturePolicy: 'required',
};

const apiCapture: CaptureDirective = {
  name: 'api_health',
  captureType: 'api_snapshot',
  statement: '/api/health',
  captureCost: 'negligible',
  capturePolicy: 'required',
};

const fileCapture: CaptureDirective = {
  name: 'config_files',
  captureType: 'file_snapshot',
  targets: ['/etc/app/config.yaml', '/etc/app/secrets.yaml'],
  captureCost: 'moderate',
  capturePolicy: 'best_effort',
};

const commandCapture: CaptureDirective = {
  name: 'process_list',
  captureType: 'command_output',
  statement: 'ps aux',
  captureCost: 'negligible',
  capturePolicy: 'required',
};

describe('executeCapture (sync, backwards compatible)', () => {
  it('returns simulated data for sql_query', () => {
    const result = executeCapture(sqlCapture);
    expect(result.status).toBe('captured');
    expect(result.data).toEqual({
      rows: '[simulated query result]',
      statement: "SELECT * FROM pg_stat_replication",
    });
  });

  it('skips deferred captures', () => {
    const result = executeCapture({
      ...sqlCapture,
      capturePolicy: 'deferred',
    });
    expect(result.status).toBe('skipped');
    expect(result.reason).toContain('Deferred');
  });

  it('skips expensive best_effort captures', () => {
    const result = executeCapture({
      ...sqlCapture,
      captureCost: 'expensive',
      capturePolicy: 'best_effort',
    });
    expect(result.status).toBe('skipped');
  });
});

describe('executeCaptureAsync', () => {
  it('falls back to simulated data without a backend', async () => {
    const result = await executeCaptureAsync(sqlCapture);
    expect(result.status).toBe('captured');
    expect(result.data).toEqual({
      rows: '[simulated query result]',
      statement: "SELECT * FROM pg_stat_replication",
    });
  });

  it('skips deferred captures', async () => {
    const result = await executeCaptureAsync({
      ...sqlCapture,
      capturePolicy: 'deferred',
    });
    expect(result.status).toBe('skipped');
  });

  it('skips expensive best_effort captures', async () => {
    const result = await executeCaptureAsync({
      ...sqlCapture,
      captureCost: 'expensive',
      capturePolicy: 'best_effort',
    });
    expect(result.status).toBe('skipped');
  });

  describe('with live backend', () => {
    it('executes sql_query capture against backend', async () => {
      const rows = [{ pid: 1, state: 'streaming' }];
      const backend = makeBackend({ "SELECT * FROM pg_stat_replication": rows });

      const result = await executeCaptureAsync(sqlCapture, { backend });
      expect(result.status).toBe('captured');
      const data = result.data as { rows: unknown; statement: string };
      expect(data.rows).toEqual(rows);
      expect(data.statement).toBe("SELECT * FROM pg_stat_replication");
    });

    it('executes api_snapshot capture against backend', async () => {
      const response = { status: 'healthy', uptime: 3600 };
      const backend = makeBackend({ '/api/health': response });

      const result = await executeCaptureAsync(apiCapture, { backend });
      expect(result.status).toBe('captured');
      const data = result.data as { endpoint: string; response: unknown };
      expect(data.endpoint).toBe('/api/health');
    });

    it('executes command_output capture against backend', async () => {
      const output = 'node  12345  0.5  2.1';
      const backend = makeBackend({ 'ps aux': output });

      const result = await executeCaptureAsync(commandCapture, { backend });
      expect(result.status).toBe('captured');
    });

    it('executes file_snapshot capture against backend', async () => {
      const backend = makeBackend({ read_file: 'file-contents' });

      const result = await executeCaptureAsync(fileCapture, { backend });
      expect(result.status).toBe('captured');
      const data = result.data as { files: string[]; snapshots: Record<string, unknown> };
      expect(data.files).toEqual(['/etc/app/config.yaml', '/etc/app/secrets.yaml']);
      expect(Object.keys(data.snapshots)).toHaveLength(2);
    });

    it('fails required capture when backend throws', async () => {
      const backend = makeFailingBackend('connection refused');

      const result = await executeCaptureAsync(sqlCapture, { backend });
      expect(result.status).toBe('failed');
      expect(result.reason).toContain('connection refused');
    });

    it('falls back to simulated data for best_effort capture when backend throws', async () => {
      const backend = makeFailingBackend('timeout');

      const result = await executeCaptureAsync({
        ...sqlCapture,
        capturePolicy: 'best_effort',
      }, { backend });
      expect(result.status).toBe('captured');
      // Falls back to simulated data
      const data = result.data as { rows: string };
      expect(data.rows).toBe('[simulated query result]');
    });

    it('fails for sql_query without a statement', async () => {
      const backend = makeBackend();
      const result = await executeCaptureAsync({
        ...sqlCapture,
        statement: undefined,
      }, { backend });
      expect(result.status).toBe('failed');
      expect(result.reason).toContain('requires a statement');
    });
  });

  describe('with capture store', () => {
    let testDir: string;
    let captureStore: CaptureStore;

    beforeEach(async () => {
      testDir = join(tmpdir(), `crisismode-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      captureStore = new CaptureStore(testDir);
      await captureStore.initialize();
    });

    afterEach(async () => {
      try { await fs.rm(testDir, { recursive: true }); } catch { /* */ }
    });

    it('persists captured data to store', async () => {
      const backend = makeBackend({
        "SELECT * FROM pg_stat_replication": [{ pid: 1 }],
      });

      const result = await executeCaptureAsync(sqlCapture, {
        backend,
        store: captureStore,
        planId: 'plan-1',
        stepId: 'step-1',
        agentId: 'pg-replication',
      });

      expect(result.status).toBe('captured');
      expect(result.captureId).toBeTruthy();

      const stored = await captureStore.get(result.captureId!);
      expect(stored).not.toBeNull();
      expect(stored!.metadata.planId).toBe('plan-1');
      expect(stored!.metadata.stepId).toBe('step-1');
      expect(stored!.metadata.rollbackCapable).toBe(true);
    });

    it('marks sql_query captures as rollback-capable', async () => {
      const result = await executeCaptureAsync(sqlCapture, {
        store: captureStore,
      });

      expect(result.captureId).toBeTruthy();
      const stored = await captureStore.get(result.captureId!);
      expect(stored!.metadata.rollbackCapable).toBe(true);
    });

    it('marks command_output captures as not rollback-capable', async () => {
      const result = await executeCaptureAsync(commandCapture, {
        store: captureStore,
      });

      expect(result.captureId).toBeTruthy();
      const stored = await captureStore.get(result.captureId!);
      expect(stored!.metadata.rollbackCapable).toBe(false);
    });

    it('does not fail capture when store write fails', async () => {
      // Use a store with an invalid path
      const badStore = new CaptureStore('/nonexistent/path/captures');

      const result = await executeCaptureAsync(sqlCapture, {
        store: badStore,
      });

      // Capture itself succeeds, just no captureId
      expect(result.status).toBe('captured');
      expect(result.captureId).toBeUndefined();
    });
  });
});
