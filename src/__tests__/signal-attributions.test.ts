// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect } from 'vitest';
import { explainSource, explainSourceInContext, enrichDiagnosis } from '../framework/signal-explanations.js';
import type { DiagnosisResult } from '../types/index.js';

function makeDiagnosis(scenario: string, source: string): DiagnosisResult {
  return {
    status: 'identified',
    scenario,
    confidence: 0.9,
    findings: [
      { source, observation: 'test observation', severity: 'info' },
    ],
    diagnosticPlanNeeded: false,
  };
}

describe('explainSourceInContext', () => {
  it('appends serverless attribution to connection sources', () => {
    const plain = explainSource('pg_connection');
    const ctx = explainSourceInContext('pg_connection', { serverless: true });
    expect(ctx?.explanation).toContain(plain?.explanation ?? '');
    expect(ctx?.explanation).toContain('serverless');
    expect(ctx?.explanation).toContain('pooled connection string');
  });

  it('no attribution without serverless context', () => {
    const plain = explainSource('pg_connection');
    const ctx = explainSourceInContext('pg_connection', { serverless: false });
    expect(ctx?.explanation).toBe(plain?.explanation);
  });

  it('non-matching sources pass through unchanged', () => {
    const plain = explainSource('dns_resolution');
    const ctx = explainSourceInContext('dns_resolution', { serverless: true });
    expect(ctx?.explanation).toBe(plain?.explanation);
  });
});

describe('enrichDiagnosis scenario-keyed attribution', () => {
  it('appends serverless pooling attribution for connection_pool_exhaustion findings', () => {
    const diagnosis = makeDiagnosis('connection_pool_exhaustion', 'pg_stat_activity');
    const enriched = enrichDiagnosis(diagnosis, { serverless: true });
    expect(enriched.findings[0]!.explanation).toContain('serverless');
    expect(enriched.findings[0]!.explanation).toContain('pooled connection string');
  });

  it('does not append pooling attribution without serverless context', () => {
    const diagnosis = makeDiagnosis('connection_pool_exhaustion', 'pg_stat_activity');
    const enriched = enrichDiagnosis(diagnosis, { serverless: false });
    expect(enriched.findings[0]!.explanation).not.toContain('pooled connection string');
  });

  it('does not misattribute pooling advice to a non-pool scenario sharing the same source', () => {
    const diagnosis = makeDiagnosis('wal_replay_paused', 'pg_stat_activity');
    const enriched = enrichDiagnosis(diagnosis, { serverless: true });
    expect(enriched.findings[0]!.explanation).not.toContain('pooled connection string');
  });
});
