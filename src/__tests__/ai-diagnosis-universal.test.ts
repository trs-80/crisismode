// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { universalAiDiagnosis } from '../framework/ai-diagnosis-universal.js';

describe('universalAiDiagnosis', () => {
  const originalEnv = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (originalEnv) {
      process.env.ANTHROPIC_API_KEY = originalEnv;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('returns fallback when no API key is set', async () => {
    const result = await universalAiDiagnosis({ question: 'why is postgres slow?' });
    expect(result.source).toBe('fallback');
    expect(result.response).toContain('ANTHROPIC_API_KEY');
  });

  it('includes health info in fallback', async () => {
    const result = await universalAiDiagnosis({
      health: {
        status: 'unhealthy',
        confidence: 0.9,
        summary: 'Replication lag critical',
        observedAt: new Date().toISOString(),
        signals: [],
        recommendedActions: ['Check network connectivity'],
      },
    });
    expect(result.source).toBe('fallback');
    expect(result.response).toContain('unhealthy');
    expect(result.response).toContain('Check network connectivity');
  });

  it('includes diagnosis info in fallback', async () => {
    const result = await universalAiDiagnosis({
      diagnosis: {
        status: 'identified',
        scenario: 'replication_lag_cascade',
        confidence: 0.85,
        findings: [
          { source: 'repl_check', observation: 'lag at 45s', severity: 'critical' },
        ],
        diagnosticPlanNeeded: false,
      },
    });
    expect(result.source).toBe('fallback');
    expect(result.response).toContain('replication_lag_cascade');
  });

  it('returns generic fallback when no inputs given', async () => {
    const result = await universalAiDiagnosis({});
    expect(result.source).toBe('fallback');
    expect(result.response).toContain('ANTHROPIC_API_KEY');
  });
});
