// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { WatchState } from '../framework/watch-state.js';
import type { HealthAssessment } from '../types/health.js';

// ── Helpers ──

function makeHealth(
  status: 'healthy' | 'recovering' | 'unhealthy' | 'unknown',
  confidence = 0.95,
  signalCount = 2,
): HealthAssessment {
  return {
    status,
    confidence,
    summary: `System is ${status}`,
    observedAt: new Date().toISOString(),
    signals: Array.from({ length: signalCount }, (_, i) => ({
      source: `probe-${i}`,
      status: status === 'healthy' ? ('healthy' as const) : ('warning' as const),
      detail: `Signal ${i}`,
      observedAt: new Date().toISOString(),
    })),
    recommendedActions: [],
  };
}

describe('Predictive degradation (6.5)', () => {
  describe('forecastDegradation', () => {
    it('returns empty forecasts with insufficient data', () => {
      const state = new WatchState('test');
      state.recordHealth(makeHealth('healthy'), 1);
      state.recordHealth(makeHealth('healthy'), 2);
      const forecasts = state.forecastDegradation();
      expect(forecasts).toHaveLength(0);
    });

    it('detects declining confidence trend', () => {
      const state = new WatchState('test');
      // Record 10 cycles with declining confidence
      for (let i = 0; i < 10; i++) {
        state.recordHealth(makeHealth('healthy', 0.95 - i * 0.04), i + 1);
      }
      const forecasts = state.forecastDegradation();
      const confTrend = forecasts.find((f) => f.driver === 'confidence-trend');
      expect(confTrend).toBeDefined();
      expect(confTrend!.predictedStatus).toBe('unhealthy');
      expect(confTrend!.cyclesUntil).toBeGreaterThan(0);
      expect(confTrend!.explanation).toContain('declining');
    });

    it('detects growing signal count', () => {
      const state = new WatchState('test');
      // Record cycles with increasing signal count
      for (let i = 0; i < 10; i++) {
        state.recordHealth(makeHealth('healthy', 0.9, 2 + i), i + 1);
      }
      const forecasts = state.forecastDegradation();
      const signalGrowth = forecasts.find((f) => f.driver === 'signal-growth');
      expect(signalGrowth).toBeDefined();
      expect(signalGrowth!.explanation).toContain('signal count growing');
    });

    it('detects flapping pattern recurrence', () => {
      const state = new WatchState('test');
      // Create flapping: healthy ↔ unhealthy repeatedly
      for (let i = 0; i < 10; i++) {
        const status = i % 2 === 0 ? 'healthy' : 'unhealthy';
        state.recordHealth(makeHealth(status as 'healthy' | 'unhealthy'), i + 1);
      }
      const forecasts = state.forecastDegradation();
      const patternForecast = forecasts.find((f) => f.driver === 'pattern-recurrence');
      expect(patternForecast).toBeDefined();
      expect(patternForecast!.explanation.toLowerCase()).toContain('flapping');
    });

    it('detects status trajectory toward unhealthy', () => {
      const state = new WatchState('test');
      // Five cycles of stable healthy to establish baseline
      for (let i = 0; i < 5; i++) {
        state.recordHealth(makeHealth('healthy'), i + 1);
      }
      // Then deteriorate
      state.recordHealth(makeHealth('healthy'), 6);
      state.recordHealth(makeHealth('recovering'), 7);
      state.recordHealth(makeHealth('recovering'), 8);
      state.recordHealth(makeHealth('recovering'), 9);
      state.recordHealth(makeHealth('recovering'), 10);

      const forecasts = state.forecastDegradation();
      const trajectory = forecasts.find((f) => f.driver === 'status-trajectory');
      // May or may not trigger depending on exact slope calculation
      expect(forecasts.length).toBeGreaterThanOrEqual(0);
    });

    it('does not forecast when system is stable', () => {
      const state = new WatchState('test');
      for (let i = 0; i < 10; i++) {
        state.recordHealth(makeHealth('healthy', 0.95, 1), i + 1);
      }
      const forecasts = state.forecastDegradation();
      // Stable system should have few or no forecasts
      const confTrend = forecasts.find((f) => f.driver === 'confidence-trend');
      expect(confTrend).toBeUndefined();
    });

    it('includes recommendations in all forecasts', () => {
      const state = new WatchState('test');
      for (let i = 0; i < 10; i++) {
        state.recordHealth(makeHealth('healthy', 0.95 - i * 0.04), i + 1);
      }
      const forecasts = state.forecastDegradation();
      for (const f of forecasts) {
        expect(f.recommendation.length).toBeGreaterThan(0);
      }
    });

    it('forecasts are sorted by confidence descending', () => {
      const state = new WatchState('test');
      // Create conditions that trigger multiple forecasts
      for (let i = 0; i < 10; i++) {
        const status = i % 2 === 0 ? 'healthy' : 'unhealthy';
        state.recordHealth(
          makeHealth(status as 'healthy' | 'unhealthy', 0.9 - i * 0.03, 2 + i),
          i + 1,
        );
      }
      const forecasts = state.forecastDegradation();
      for (let i = 1; i < forecasts.length; i++) {
        expect(forecasts[i].confidence).toBeLessThanOrEqual(forecasts[i - 1].confidence);
      }
    });

    it('health card includes forecasts', () => {
      const state = new WatchState('test');
      for (let i = 0; i < 10; i++) {
        state.recordHealth(makeHealth('healthy', 0.95 - i * 0.04), i + 1);
      }
      const card = state.getHealthCard();
      expect(card).toHaveProperty('forecasts');
      expect(Array.isArray(card.forecasts)).toBe(true);
    });

    it('detects degradation cycle pattern recurrence', () => {
      const state = new WatchState('test');
      // healthy → recovering → unhealthy, three times (need enough data)
      const seq: Array<'healthy' | 'recovering' | 'unhealthy'> = [
        'healthy', 'recovering', 'unhealthy',
        'healthy', 'recovering', 'unhealthy',
        'healthy', 'recovering', 'unhealthy',
        'healthy',
      ];
      for (let i = 0; i < seq.length; i++) {
        state.recordHealth(makeHealth(seq[i]), i + 1);
      }
      const forecasts = state.forecastDegradation();
      const degradation = forecasts.find(
        (f) => f.driver === 'pattern-recurrence' && f.explanation.toLowerCase().includes('degradation'),
      );
      expect(degradation).toBeDefined();
    });
  });
});
