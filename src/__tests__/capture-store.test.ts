// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CaptureStore, parseDuration } from '../framework/capture-store.js';

let testDir: string;
let store: CaptureStore;

beforeEach(async () => {
  testDir = join(tmpdir(), `crisismode-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  store = new CaptureStore(testDir);
  await store.initialize();
});

afterEach(async () => {
  try {
    await fs.rm(testDir, { recursive: true });
  } catch {
    // cleanup best-effort
  }
});

describe('CaptureStore', () => {
  it('initializes the directory and index file', async () => {
    const indexPath = join(testDir, 'index.json');
    const raw = await fs.readFile(indexPath, 'utf-8');
    const index = JSON.parse(raw);
    expect(index.version).toBe(1);
    expect(index.captures).toEqual([]);
  });

  it('stores and retrieves a capture', async () => {
    const meta = await store.store({
      name: 'pg_settings',
      captureType: 'sql_query',
      data: { rows: [{ setting: 'wal_level', value: 'replica' }], statement: 'SHOW wal_level' },
      planId: 'plan-1',
      stepId: 'step-1',
      agentId: 'pg-replication',
      rollbackCapable: true,
    });

    expect(meta.id).toBeTruthy();
    expect(meta.name).toBe('pg_settings');
    expect(meta.captureType).toBe('sql_query');
    expect(meta.sizeBytes).toBeGreaterThan(0);
    expect(meta.rollbackCapable).toBe(true);

    const retrieved = await store.get(meta.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.metadata.id).toBe(meta.id);
    expect(retrieved!.data).toEqual({
      rows: [{ setting: 'wal_level', value: 'replica' }],
      statement: 'SHOW wal_level',
    });
  });

  it('returns null for non-existent captures', async () => {
    const result = await store.get('non-existent-id');
    expect(result).toBeNull();
  });

  it('lists captures with no filter', async () => {
    await store.store({ name: 'a', captureType: 'sql_query', data: { a: 1 } });
    await store.store({ name: 'b', captureType: 'command_output', data: { b: 2 } });

    const list = await store.list();
    expect(list).toHaveLength(2);
  });

  it('lists captures filtered by captureType', async () => {
    await store.store({ name: 'a', captureType: 'sql_query', data: { a: 1 } });
    await store.store({ name: 'b', captureType: 'command_output', data: { b: 2 } });
    await store.store({ name: 'c', captureType: 'sql_query', data: { c: 3 } });

    const sqlCaptures = await store.list({ captureType: 'sql_query' });
    expect(sqlCaptures).toHaveLength(2);
    expect(sqlCaptures.every((c) => c.captureType === 'sql_query')).toBe(true);
  });

  it('lists captures filtered by planId', async () => {
    await store.store({ name: 'a', captureType: 'sql_query', data: {}, planId: 'plan-1' });
    await store.store({ name: 'b', captureType: 'sql_query', data: {}, planId: 'plan-2' });

    const list = await store.list({ planId: 'plan-1' });
    expect(list).toHaveLength(1);
    expect(list[0].planId).toBe('plan-1');
  });

  it('lists captures filtered by rollbackCapable', async () => {
    await store.store({ name: 'a', captureType: 'sql_query', data: {}, rollbackCapable: true });
    await store.store({ name: 'b', captureType: 'command_output', data: {}, rollbackCapable: false });

    const rollbackable = await store.list({ rollbackCapable: true });
    expect(rollbackable).toHaveLength(1);
    expect(rollbackable[0].name).toBe('a');
  });

  it('lists captures filtered by tag', async () => {
    await store.store({ name: 'a', captureType: 'sql_query', data: {}, tags: ['pg', 'config'] });
    await store.store({ name: 'b', captureType: 'sql_query', data: {}, tags: ['redis'] });

    const pgCaptures = await store.list({ tag: 'pg' });
    expect(pgCaptures).toHaveLength(1);
    expect(pgCaptures[0].name).toBe('a');
  });

  it('returns captures sorted by most recent first', async () => {
    await store.store({ name: 'first', captureType: 'sql_query', data: {} });
    // Tiny delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 10));
    await store.store({ name: 'second', captureType: 'sql_query', data: {} });

    const list = await store.list();
    expect(list[0].name).toBe('second');
    expect(list[1].name).toBe('first');
  });

  it('findLatest returns the most recent matching capture', async () => {
    await store.store({ name: 'old', captureType: 'sql_query', data: { v: 1 }, stepId: 's1' });
    await new Promise((r) => setTimeout(r, 10));
    await store.store({ name: 'new', captureType: 'sql_query', data: { v: 2 }, stepId: 's1' });

    const latest = await store.findLatest({ stepId: 's1' });
    expect(latest).not.toBeNull();
    expect(latest!.metadata.name).toBe('new');
    expect(latest!.data).toEqual({ v: 2 });
  });

  it('findLatest returns null when no captures match', async () => {
    const result = await store.findLatest({ planId: 'nonexistent' });
    expect(result).toBeNull();
  });

  it('deletes a capture', async () => {
    const meta = await store.store({ name: 'doomed', captureType: 'sql_query', data: {} });

    const deleted = await store.delete(meta.id);
    expect(deleted).toBe(true);

    const retrieved = await store.get(meta.id);
    expect(retrieved).toBeNull();

    const list = await store.list();
    expect(list).toHaveLength(0);
  });

  it('delete returns false for non-existent ID', async () => {
    const result = await store.delete('nope');
    expect(result).toBe(false);
  });

  it('cleans up captures older than maxAge', async () => {
    // Store a capture, then immediately clean with 0ms threshold
    await store.store({ name: 'old', captureType: 'sql_query', data: {} });
    await new Promise((r) => setTimeout(r, 50));

    const removed = await store.cleanup('1ms');
    expect(removed).toBe(1);

    const list = await store.list();
    expect(list).toHaveLength(0);
  });

  it('cleanup preserves recent captures', async () => {
    await store.store({ name: 'recent', captureType: 'sql_query', data: {} });

    const removed = await store.cleanup('1h');
    expect(removed).toBe(0);

    const list = await store.list();
    expect(list).toHaveLength(1);
  });

  it('reports total storage size', async () => {
    await store.store({ name: 'a', captureType: 'sql_query', data: { key: 'value' } });
    await store.store({ name: 'b', captureType: 'sql_query', data: { another: 'entry' } });

    const size = await store.totalSize();
    expect(size).toBeGreaterThan(0);
  });

  it('handles re-initialization gracefully', async () => {
    await store.store({ name: 'before', captureType: 'sql_query', data: {} });

    // Create a new store instance pointing to the same directory
    const store2 = new CaptureStore(testDir);
    await store2.initialize();

    const list = await store2.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('before');
  });
});

describe('parseDuration', () => {
  it('parses milliseconds', () => {
    expect(parseDuration('100ms')).toBe(100);
  });

  it('parses seconds', () => {
    expect(parseDuration('30s')).toBe(30_000);
  });

  it('parses minutes', () => {
    expect(parseDuration('5m')).toBe(300_000);
  });

  it('parses hours', () => {
    expect(parseDuration('24h')).toBe(86_400_000);
  });

  it('parses days', () => {
    expect(parseDuration('7d')).toBe(604_800_000);
  });

  it('returns 0 for invalid format', () => {
    expect(parseDuration('invalid')).toBe(0);
    expect(parseDuration('')).toBe(0);
    expect(parseDuration('24')).toBe(0);
  });
});
