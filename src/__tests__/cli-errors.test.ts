// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import {
  CrisisModeError,
  connectionRefused,
  noConfig,
  missingEnvVar,
  agentNotFound,
  formatError,
} from '../cli/errors.js';

describe('CrisisModeError', () => {
  it('has message and suggestion', () => {
    const err = new CrisisModeError('something broke', 'try this');
    expect(err.message).toBe('something broke');
    expect(err.suggestion).toBe('try this');
    expect(err.name).toBe('CrisisModeError');
  });
});

describe('error factories', () => {
  it('connectionRefused includes host and port', () => {
    const err = connectionRefused('postgresql', 'localhost', 5432);
    expect(err.message).toContain('localhost:5432');
    expect(err.suggestion).toContain('PostgreSQL');
  });

  it('connectionRefused handles unknown kinds', () => {
    const err = connectionRefused('mysql', 'db.example.com', 3306);
    expect(err.message).toContain('mysql');
    expect(err.suggestion).toContain('mysql');
  });

  it('noConfig suggests init', () => {
    const err = noConfig();
    expect(err.suggestion).toContain('crisismode init');
  });

  it('missingEnvVar includes the variable name', () => {
    const err = missingEnvVar('PG_PASSWORD', 'database authentication');
    expect(err.message).toContain('PG_PASSWORD');
    expect(err.suggestion).toContain('export PG_PASSWORD');
  });

  it('agentNotFound lists supported systems', () => {
    const err = agentNotFound('mysql');
    expect(err.message).toContain('mysql');
    expect(err.suggestion).toContain('postgresql');
    expect(err.suggestion).toContain('redis');
  });
});

describe('formatError', () => {
  it('formats CrisisModeError with suggestion', () => {
    const err = new CrisisModeError('broke', 'fix it');
    const formatted = formatError(err);
    expect(formatted).toContain('broke');
    expect(formatted).toContain('fix it');
    expect(formatted).toContain('Suggestion');
  });

  it('formats regular Error', () => {
    const err = new Error('generic failure');
    expect(formatError(err)).toContain('generic failure');
  });

  it('formats non-Error values', () => {
    expect(formatError('string error')).toContain('string error');
    expect(formatError(42)).toContain('42');
  });
});
