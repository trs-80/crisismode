// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect } from 'vitest';
import { explainSource, explainSourceInContext } from '../framework/signal-explanations.js';

describe('explainSourceInContext', () => {
  it('appends serverless attribution to connection-exhaustion sources', () => {
    const plain = explainSource('pg_connection_pool');
    const ctx = explainSourceInContext('pg_connection_pool', { serverless: true });
    expect(ctx?.explanation).toContain(plain?.explanation ?? '');
    expect(ctx?.explanation).toContain('serverless');
    expect(ctx?.explanation).toContain('pooled connection string');
  });

  it('no attribution without serverless context', () => {
    const plain = explainSource('pg_connection_pool');
    const ctx = explainSourceInContext('pg_connection_pool', { serverless: false });
    expect(ctx?.explanation).toBe(plain?.explanation);
  });

  it('non-matching sources pass through unchanged', () => {
    const plain = explainSource('dns_resolution');
    const ctx = explainSourceInContext('dns_resolution', { serverless: true });
    expect(ctx?.explanation).toBe(plain?.explanation);
  });
});
