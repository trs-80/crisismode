// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { WatchState } from '../framework/watch-state.js';
import type { HealthAssessment } from '../types/health.js';
import type { DiagnosisResult } from '../types/diagnosis-result.js';
import type { RecoveryPlan } from '../types/recovery-plan.js';

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
      status: status === 'healthy' ? 'healthy' as const : 'warning' as const,
      detail: `Signal ${i}`,
      observedAt: new Date().toISOString(),
    })),
    recommendedActions: [],
  };
}

function makeDiagnosis(scenario = 'replication-lag'): DiagnosisResult {
  return {
    status: 'identified',
    scenario,
    confidence: 0.9,
    findings: [
      { source: 'pg', observation: 'Replication lag detected', severity: 'critical' },
    ],
    diagnosticPlanNeeded: false,
  };
}

function makePlan(planId = 'plan-1', stepCount = 3): RecoveryPlan {
  return {
    apiVersion: 'crisismode/v1',
    kind: 'RecoveryPlan',
    metadata: {
      planId,
      agentName: 'test-agent',
      agentVersion: '1.0.0',
      scenario: 'replication-lag',
      createdAt: new Date().toISOString(),
      estimatedDuration: 'PT5M',
      summary: 'Recovery plan',
      supersedes: null,
    },
    impact: {
      affectedSystems: [],
      affectedServices: [],
      estimatedUserImpact: 'minimal',
      dataLossRisk: 'none',
    },
    steps: Array.from({ length: stepCount }, (_, i) => ({
      stepId: `step-${i}`,
      type: 'diagnosis_action' as const,
      name: `Step ${i}`,
      executionContext: 'primary',
      target: 'test',
      command: { type: 'sql' as const, statement: 'SELECT 1' },
      timeout: 'PT30S',
    })),
    rollbackStrategy: { type: 'none' as const, description: 'N/A' },
  };
}

// ── Tests ──

describe('WatchState', () => {
  describe('construction', () => {
    it('initialises with target and start time', () => {
      const state = new WatchState('test-pg');
      expect(state.target).toBe('test-pg');
      expect(state.startedAt).toBeDefined();
      expect(state.getLastStatus()).toBeNull();
    });

    it('accepts custom start time', () => {
      const t = '2026-01-01T00:00:00.000Z';
      const state = new WatchState('test-pg', t);
      expect(state.startedAt).toBe(t);
    });
  });

  describe('recordHealth', () => {
    it('records a health snapshot', () => {
      const state = new WatchState('test-pg');
      const health = makeHealth('healthy');
      const transition = state.recordHealth(health, 1);

      expect(transition).toBeNull();
      expect(state.getLastStatus()).toBe('healthy');
      expect(state.getLastSnapshot()).toBeDefined();
      expect(state.getLastSnapshot()!.cycle).toBe(1);
      expect(state.getLastSnapshot()!.status).toBe('healthy');
    });

    it('detects transition from healthy to unhealthy', () => {
      const state = new WatchState('test-pg');
      state.recordHealth(makeHealth('healthy'), 1);
      const transition = state.recordHealth(makeHealth('unhealthy'), 2);

      expect(transition).not.toBeNull();
      expect(transition!.from).toBe('healthy');
      expect(transition!.to).toBe('unhealthy');
      expect(transition!.cycle).toBe(2);
    });

    it('returns null when status does not change', () => {
      const state = new WatchState('test-pg');
      state.recordHealth(makeHealth('healthy'), 1);
      const transition = state.recordHealth(makeHealth('healthy'), 2);
      expect(transition).toBeNull();
    });

    it('trims snapshots when exceeding max limit', () => {
      const state = new WatchState('test-pg');
      // Record 1010 snapshots
      for (let i = 1; i <= 1010; i++) {
        state.recordHealth(makeHealth('healthy'), i);
      }
      const summary = state.getSummary();
      expect(summary.healthSnapshots.length).toBe(1000);
      expect(summary.healthSnapshots[0].cycle).toBe(11); // oldest trimmed
    });
  });

  describe('recordProposal', () => {
    it('records a recovery proposal', () => {
      const state = new WatchState('test-pg');
      const proposal = state.recordProposal(makeDiagnosis(), makePlan(), 5);

      expect(proposal.id).toBe('plan-1');
      expect(proposal.cycle).toBe(5);
      expect(proposal.scenario).toBe('replication-lag');
      expect(proposal.stepCount).toBe(3);
    });
  });

  describe('getHealthCard', () => {
    it('returns card with correct uptime percentage', () => {
      const state = new WatchState('test-pg');
      state.recordHealth(makeHealth('healthy'), 1);
      state.recordHealth(makeHealth('healthy'), 2);
      state.recordHealth(makeHealth('unhealthy'), 3);
      state.recordHealth(makeHealth('healthy'), 4);

      const card = state.getHealthCard();
      expect(card.target).toBe('test-pg');
      expect(card.uptimePercent).toBe(75);
      expect(card.totalCycles).toBe(4);
      expect(card.transitionCount).toBe(2);
      expect(card.currentStatus).toBe('healthy');
    });

    it('returns 100% uptime when all healthy', () => {
      const state = new WatchState('test-pg');
      state.recordHealth(makeHealth('healthy'), 1);
      state.recordHealth(makeHealth('healthy'), 2);
      const card = state.getHealthCard();
      expect(card.uptimePercent).toBe(100);
    });

    it('returns 0% uptime when all unhealthy', () => {
      const state = new WatchState('test-pg');
      state.recordHealth(makeHealth('unhealthy'), 1);
      state.recordHealth(makeHealth('unhealthy'), 2);
      const card = state.getHealthCard();
      expect(card.uptimePercent).toBe(0);
    });

    it('handles no cycles gracefully', () => {
      const state = new WatchState('test-pg');
      const card = state.getHealthCard();
      expect(card.currentStatus).toBe('unknown');
      expect(card.uptimePercent).toBe(100);
      expect(card.totalCycles).toBe(0);
    });

    it('calculates average confidence', () => {
      const state = new WatchState('test-pg');
      state.recordHealth(makeHealth('healthy', 0.8), 1);
      state.recordHealth(makeHealth('healthy', 1.0), 2);
      const card = state.getHealthCard();
      expect(card.avgConfidence).toBe(0.9);
    });

    it('includes proposal count', () => {
      const state = new WatchState('test-pg');
      state.recordHealth(makeHealth('healthy'), 1);
      state.recordProposal(makeDiagnosis(), makePlan(), 1);
      state.recordProposal(makeDiagnosis(), makePlan('plan-2'), 2);
      const card = state.getHealthCard();
      expect(card.proposalCount).toBe(2);
    });
  });

  describe('detectPatterns', () => {
    it('detects flapping pattern', () => {
      const state = new WatchState('test-pg');
      // Create a flapping sequence
      const statuses: Array<'healthy' | 'unhealthy'> = [
        'healthy', 'unhealthy', 'healthy', 'unhealthy', 'healthy', 'unhealthy',
      ];
      for (let i = 0; i < statuses.length; i++) {
        state.recordHealth(makeHealth(statuses[i]), i + 1);
      }

      const patterns = state.detectPatterns();
      const flapping = patterns.find((p) => p.pattern === 'flapping');
      expect(flapping).toBeDefined();
      expect(flapping!.occurrences).toBeGreaterThanOrEqual(3);
    });

    it('detects degradation cycle', () => {
      const state = new WatchState('test-pg');
      // Two full degradation cycles
      const statuses: Array<'healthy' | 'recovering' | 'unhealthy'> = [
        'healthy', 'recovering', 'unhealthy',
        'healthy', 'recovering', 'unhealthy',
      ];
      for (let i = 0; i < statuses.length; i++) {
        state.recordHealth(makeHealth(statuses[i]), i + 1);
      }

      const patterns = state.detectPatterns();
      const degradation = patterns.find((p) => p.pattern === 'degradation-cycle');
      expect(degradation).toBeDefined();
      expect(degradation!.occurrences).toBe(2);
    });

    it('detects confidence drift', () => {
      const state = new WatchState('test-pg');
      // First half: high confidence, second half: low confidence
      for (let i = 1; i <= 10; i++) {
        const confidence = i <= 5 ? 0.95 : 0.8;
        state.recordHealth(makeHealth('healthy', confidence), i);
      }

      const patterns = state.detectPatterns();
      const drift = patterns.find((p) => p.pattern === 'confidence-drift');
      expect(drift).toBeDefined();
      expect(drift!.description).toContain('down');
    });

    it('does not detect confidence drift when stable', () => {
      const state = new WatchState('test-pg');
      for (let i = 1; i <= 10; i++) {
        state.recordHealth(makeHealth('healthy', 0.95), i);
      }

      const patterns = state.detectPatterns();
      const drift = patterns.find((p) => p.pattern === 'confidence-drift');
      expect(drift).toBeUndefined();
    });

    it('detects persistent unhealthy', () => {
      const state = new WatchState('test-pg');
      for (let i = 1; i <= 6; i++) {
        state.recordHealth(makeHealth('unhealthy'), i);
      }

      const patterns = state.detectPatterns();
      const persistent = patterns.find((p) => p.pattern === 'persistent-unhealthy');
      expect(persistent).toBeDefined();
      expect(persistent!.occurrences).toBe(6);
    });

    it('does not detect persistent unhealthy below threshold', () => {
      const state = new WatchState('test-pg');
      for (let i = 1; i <= 3; i++) {
        state.recordHealth(makeHealth('unhealthy'), i);
      }

      const patterns = state.detectPatterns();
      const persistent = patterns.find((p) => p.pattern === 'persistent-unhealthy');
      expect(persistent).toBeUndefined();
    });

    it('returns empty array with too few snapshots', () => {
      const state = new WatchState('test-pg');
      state.recordHealth(makeHealth('healthy'), 1);
      expect(state.detectPatterns()).toEqual([]);
    });
  });

  describe('getSummary', () => {
    it('returns complete summary', () => {
      const state = new WatchState('test-pg');
      state.recordHealth(makeHealth('healthy'), 1);
      state.recordHealth(makeHealth('unhealthy'), 2);
      state.recordProposal(makeDiagnosis(), makePlan(), 2);

      const summary = state.getSummary();
      expect(summary.totalCycles).toBe(2);
      expect(summary.transitions).toHaveLength(1);
      expect(summary.proposals).toHaveLength(1);
      expect(summary.uptimePercent).toBe(50);
      expect(summary.startedAt).toBeDefined();
      expect(summary.lastUpdated).toBeDefined();
    });
  });

  describe('serialisation', () => {
    it('serialises and deserialises round-trip', () => {
      const state = new WatchState('test-pg');
      state.recordHealth(makeHealth('healthy', 0.9), 1);
      state.recordHealth(makeHealth('unhealthy', 0.85), 2);
      state.recordProposal(makeDiagnosis(), makePlan(), 2);

      const serialised = state.serialise();
      const restored = WatchState.deserialise(serialised);

      expect(restored.target).toBe('test-pg');
      expect(restored.getLastStatus()).toBe('unhealthy');

      const originalSummary = state.getSummary();
      const restoredSummary = restored.getSummary();

      expect(restoredSummary.totalCycles).toBe(originalSummary.totalCycles);
      expect(restoredSummary.transitions).toEqual(originalSummary.transitions);
      expect(restoredSummary.proposals).toEqual(originalSummary.proposals);
    });

    it('deserialised state continues accumulating', () => {
      const state = new WatchState('test-pg');
      state.recordHealth(makeHealth('healthy'), 1);

      const serialised = state.serialise();
      const restored = WatchState.deserialise(serialised);
      const transition = restored.recordHealth(makeHealth('unhealthy'), 2);

      expect(transition).not.toBeNull();
      expect(transition!.from).toBe('healthy');
      expect(transition!.to).toBe('unhealthy');
      expect(restored.getSummary().totalCycles).toBe(2);
    });

    it('serialises version field', () => {
      const state = new WatchState('test-pg');
      const serialised = state.serialise();
      expect(serialised.version).toBe(1);
    });
  });
});
