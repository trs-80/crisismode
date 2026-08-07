// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect } from 'vitest';
import { VectorStoreSimulator, SIMULATOR_FIXTURE_KEY } from '../agent/vector-store/simulator.js';
import { VECTOR_STORE_CHECK_IDS } from '../agent/vector-store/check-ids.js';
import type { VectorStoreCheckStatus, VectorStoreReport } from '../agent/vector-store/backend.js';

const statusOf = (report: VectorStoreReport, checkId: string): VectorStoreCheckStatus | undefined =>
  report.checks.find((c) => c.checkId === checkId)?.status;

describe('VectorStoreSimulator', () => {
  it('healthy: all three checks pass and an index is reported ready', async () => {
    const [report] = await new VectorStoreSimulator().queryVectorStores();
    expect(report).toBeDefined();
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.reachable)).toBe('pass');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.authValid)).toBe('pass');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.indexStatus)).toBe('pass');
    expect(report!.indexes[0]?.ready).toBe(true);
    expect(report!.indexes[0]?.dimension).toBe(1536);
  });

  it('unreachable: reachability fails and the dependent checks are unknown', async () => {
    const sim = new VectorStoreSimulator();
    sim.transition('unreachable');
    const [report] = await sim.queryVectorStores();
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.reachable)).toBe('fail');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.authValid)).toBe('unknown');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.indexStatus)).toBe('unknown');
  });

  it('bad_key: reachable but auth fails', async () => {
    const sim = new VectorStoreSimulator();
    sim.transition('bad_key');
    const [report] = await sim.queryVectorStores();
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.reachable)).toBe('pass');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.authValid)).toBe('fail');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.indexStatus)).toBe('unknown');
  });

  it('index_not_ready: index status fails while auth passes', async () => {
    const sim = new VectorStoreSimulator();
    sim.transition('index_not_ready');
    const [report] = await sim.queryVectorStores();
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.authValid)).toBe('pass');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.indexStatus)).toBe('fail');
    expect(report!.indexes[0]?.ready).toBe(false);
  });

  it('no_indexes: auth passes and index status is a failure with no indexes listed', async () => {
    const sim = new VectorStoreSimulator();
    sim.transition('no_indexes');
    const [report] = await sim.queryVectorStores();
    expect(report!.indexes).toEqual([]);
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.indexStatus)).toBe('fail');
  });

  it('never exposes key material — only a PR 3-shaped fingerprint', async () => {
    const [report] = await new VectorStoreSimulator().queryVectorStores();
    expect(report!.keyFingerprint).toBe('…0000');
    expect(JSON.stringify(report)).not.toContain(SIMULATOR_FIXTURE_KEY);
  });

  it('rejects an unknown scenario rather than silently doing nothing', () => {
    expect(() => new VectorStoreSimulator().transition('nonsense')).toThrow();
  });

  it('has no offline scenario — offline deferral belongs to the agent gate', () => {
    expect(() => new VectorStoreSimulator().transition('offline')).toThrow();
  });
});

describe('VectorStoreSimulator — evaluateCheck', () => {
  // The unmatched-statement fallback is `false` here, matching the live
  // client — a check on a statement neither backend recognizes must not
  // silently pass. A statement merely *containing* 'auth_valid' (or
  // 'ready_index_count') as a substring is exactly such an unmatched
  // statement: it must fall through to that fail-closed default instead of
  // evaluating (and reporting) the actual scenario status.
  it('matches auth_valid by exact statement, not by substring', async () => {
    // Healthy scenario so the exact-match branch evaluates to `true`,
    // distinguishing it from the substring falling through to the
    // fail-closed default of `false`.
    const sim = new VectorStoreSimulator();
    expect(await sim.evaluateCheck({ type: 'structured_command', statement: 'auth_valid', expect: { operator: 'eq', value: 'pass' } })).toBe(true);
    expect(await sim.evaluateCheck({ type: 'structured_command', statement: 'vector-store.auth_valid', expect: { operator: 'eq', value: 'pass' } })).toBe(false);
  });

  it('matches ready_index_count by exact statement, not by substring', async () => {
    // Healthy scenario has one ready index, so the exact-match branch
    // evaluates to `true`, distinguishing it from the substring falling
    // through to the fail-closed default of `false`.
    const sim = new VectorStoreSimulator();
    expect(await sim.evaluateCheck({ type: 'structured_command', statement: 'ready_index_count', expect: { operator: 'eq', value: 1 } })).toBe(true);
    expect(await sim.evaluateCheck({ type: 'structured_command', statement: 'not_ready_index_count', expect: { operator: 'eq', value: 1 } })).toBe(false);
  });

  it('fails closed on an unrecognized statement, even when the underlying report is healthy', async () => {
    const sim = new VectorStoreSimulator();
    expect(await sim.evaluateCheck({ type: 'structured_command', statement: 'nonsense_statement', expect: { operator: 'eq', value: 'pass' } })).toBe(false);
  });
});
