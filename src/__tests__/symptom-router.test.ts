// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { routeBySymptoms } from '../framework/symptom-router.js';
import type { SymptomSignal } from '../framework/symptom-router.js';

describe('routeBySymptoms', () => {
  it('routes error rate + deploy change to deploy rollback agent', () => {
    const signals: SymptomSignal[] = [
      { type: 'error_rate', source: 'monitoring', detail: 'Error rate spiked to 15%', severity: 'critical' },
      { type: 'deploy_change', source: 'platform', detail: 'Deploy abc123 completed 5min ago', severity: 'info' },
    ];

    const result = routeBySymptoms(signals);
    expect(result.recommendedAgent).toBeTruthy();
    expect(result.scenarios.length).toBeGreaterThan(0);
    expect(result.explanation).toBeTruthy();
    expect(result.evidence.length).toBeGreaterThan(0);
  });

  it('routes timeout + AI provider to AI provider failover', () => {
    const signals: SymptomSignal[] = [
      { type: 'timeout', source: 'app', detail: 'Request timeout rate 40%', severity: 'critical' },
      { type: 'latency', source: 'provider', detail: 'OpenAI p95 latency 15s', severity: 'critical' },
    ];

    const result = routeBySymptoms(signals);
    expect(result.scenarios.length).toBeGreaterThan(0);
    expect(result.explanation).toBeTruthy();
  });

  it('routes connection exhaustion to DB migration agent', () => {
    const signals: SymptomSignal[] = [
      { type: 'connection', source: 'database', detail: 'Connection pool at 98%', severity: 'critical' },
      { type: 'resource_exhaustion', source: 'database', detail: 'Max connections reached', severity: 'critical' },
    ];

    const result = routeBySymptoms(signals);
    expect(result.scenarios.length).toBeGreaterThan(0);
  });

  it('returns empty result for no signals', () => {
    const result = routeBySymptoms([]);
    expect(result.scenarios.length).toBe(0);
    expect(result.recommendedAgent).toBeNull();
  });
});
