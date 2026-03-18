// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Watch-state — persistent state accumulator for shadow/continuous observation.
 *
 * Tracks health history, transitions, confidence trends, recovery proposals,
 * and detects recurring patterns across watch cycles. State is held in memory
 * during a watch session and can be serialised to/from JSON for persistence.
 */

import type { HealthStatus, HealthAssessment } from '../types/health.js';
import type { DiagnosisResult } from '../types/diagnosis-result.js';
import type { RecoveryPlan } from '../types/recovery-plan.js';

// ── Types ──

export interface HealthSnapshot {
  cycle: number;
  status: HealthStatus;
  confidence: number;
  signalCount: number;
  timestamp: string;
}

export interface HealthTransition {
  from: HealthStatus;
  to: HealthStatus;
  cycle: number;
  timestamp: string;
}

export interface RecoveryProposal {
  id: string;
  cycle: number;
  scenario: string | null;
  confidence: number;
  stepCount: number;
  timestamp: string;
}

export interface RecurringPattern {
  pattern: string;
  occurrences: number;
  firstSeen: string;
  lastSeen: string;
  description: string;
}

export interface DegradationForecast {
  /** Predicted status if current trend continues */
  predictedStatus: HealthStatus;
  /** Confidence in the prediction (0-1) */
  confidence: number;
  /** Estimated cycles until predicted status is reached */
  cyclesUntil: number;
  /** What metric is driving the prediction */
  driver: 'confidence-trend' | 'signal-growth' | 'pattern-recurrence' | 'status-trajectory';
  /** Human-readable explanation */
  explanation: string;
  /** Recommended preventive action */
  recommendation: string;
}

export interface HealthCard {
  target: string;
  currentStatus: HealthStatus;
  currentConfidence: number;
  uptimePercent: number;
  avgConfidence: number;
  totalCycles: number;
  transitionCount: number;
  proposalCount: number;
  patterns: RecurringPattern[];
  forecasts: DegradationForecast[];
  lastChecked: string;
  watchingSince: string;
}

export interface WatchStateSummary {
  totalCycles: number;
  healthSnapshots: HealthSnapshot[];
  transitions: HealthTransition[];
  proposals: RecoveryProposal[];
  patterns: RecurringPattern[];
  startedAt: string;
  lastUpdated: string;
  uptimePercent: number;
  avgConfidence: number;
}

export interface SerializedWatchState {
  version: 1;
  target: string;
  snapshots: HealthSnapshot[];
  transitions: HealthTransition[];
  proposals: RecoveryProposal[];
  startedAt: string;
  lastUpdated: string;
}

// ── Watch State ──

const MAX_SNAPSHOTS = 1000;
const PATTERN_WINDOW = 20;

export class WatchState {
  readonly target: string;
  readonly startedAt: string;

  private snapshots: HealthSnapshot[] = [];
  private transitions: HealthTransition[] = [];
  private proposals: RecoveryProposal[] = [];
  private lastStatus: HealthStatus | null = null;
  private lastUpdated: string;

  constructor(target: string, startedAt?: string) {
    this.target = target;
    this.startedAt = startedAt ?? new Date().toISOString();
    this.lastUpdated = this.startedAt;
  }

  /** Record a health check result from one watch cycle. */
  recordHealth(assessment: HealthAssessment, cycle: number): HealthTransition | null {
    const snapshot: HealthSnapshot = {
      cycle,
      status: assessment.status,
      confidence: assessment.confidence,
      signalCount: assessment.signals.length,
      timestamp: assessment.observedAt,
    };

    this.snapshots.push(snapshot);
    this.lastUpdated = snapshot.timestamp;

    // Trim oldest snapshots if over limit
    if (this.snapshots.length > MAX_SNAPSHOTS) {
      this.snapshots = this.snapshots.slice(-MAX_SNAPSHOTS);
    }

    // Detect transition
    let transition: HealthTransition | null = null;
    if (this.lastStatus !== null && this.lastStatus !== assessment.status) {
      transition = {
        from: this.lastStatus,
        to: assessment.status,
        cycle,
        timestamp: snapshot.timestamp,
      };
      this.transitions.push(transition);
    }

    this.lastStatus = assessment.status;
    return transition;
  }

  /** Record a recovery proposal generated during watch. */
  recordProposal(diagnosis: DiagnosisResult, plan: RecoveryPlan, cycle: number): RecoveryProposal {
    const proposal: RecoveryProposal = {
      id: plan.metadata?.planId ?? `proposal-${cycle}`,
      cycle,
      scenario: diagnosis.scenario,
      confidence: diagnosis.confidence,
      stepCount: plan.steps?.length ?? 0,
      timestamp: new Date().toISOString(),
    };
    this.proposals.push(proposal);
    return proposal;
  }

  /** Get the last recorded health status. */
  getLastStatus(): HealthStatus | null {
    return this.lastStatus;
  }

  /** Get the most recent health snapshot. */
  getLastSnapshot(): HealthSnapshot | null {
    return this.snapshots.length > 0 ? this.snapshots[this.snapshots.length - 1] : null;
  }

  /** Build a health card summarising current state and trends. */
  getHealthCard(): HealthCard {
    const healthyCycles = this.snapshots.filter((s) => s.status === 'healthy').length;
    const total = this.snapshots.length;
    const uptimePercent = total > 0 ? (healthyCycles / total) * 100 : 100;

    const avgConfidence =
      total > 0
        ? this.snapshots.reduce((sum, s) => sum + s.confidence, 0) / total
        : 0;

    const lastSnapshot = this.getLastSnapshot();

    return {
      target: this.target,
      currentStatus: lastSnapshot?.status ?? 'unknown',
      currentConfidence: lastSnapshot?.confidence ?? 0,
      uptimePercent: Math.round(uptimePercent * 10) / 10,
      avgConfidence: Math.round(avgConfidence * 1000) / 1000,
      totalCycles: total,
      transitionCount: this.transitions.length,
      proposalCount: this.proposals.length,
      patterns: this.detectPatterns(),
      forecasts: this.forecastDegradation(),
      lastChecked: lastSnapshot?.timestamp ?? this.startedAt,
      watchingSince: this.startedAt,
    };
  }

  /** Forecast degradation by analysing trends in health data. */
  forecastDegradation(): DegradationForecast[] {
    const forecasts: DegradationForecast[] = [];
    if (this.snapshots.length < 5) return forecasts;

    // 1. Confidence trend — linear regression on recent confidence values
    const recentWindow = Math.min(this.snapshots.length, 30);
    const recent = this.snapshots.slice(-recentWindow);
    const slope = linearSlope(recent.map((s) => s.confidence));

    if (slope < -0.01) {
      // Confidence declining — estimate when it crosses 0.5 (unhealthy threshold)
      const lastConf = recent[recent.length - 1].confidence;
      const threshold = 0.5;
      if (lastConf > threshold) {
        const cyclesUntil = Math.ceil((lastConf - threshold) / Math.abs(slope));
        forecasts.push({
          predictedStatus: 'unhealthy',
          confidence: Math.min(Math.abs(slope) * 20, 0.9),
          cyclesUntil,
          driver: 'confidence-trend',
          explanation: `Confidence declining at ${(slope * 100).toFixed(2)}%/cycle — will cross unhealthy threshold in ~${cyclesUntil} cycles`,
          recommendation: 'Investigate root cause now while system is still healthy. Run `crisismode diagnose`.',
        });
      }
    }

    // 2. Signal count growth — more signals = more warnings
    const signalSlope = linearSlope(recent.map((s) => s.signalCount));
    if (signalSlope > 0.1 && recent[recent.length - 1].signalCount >= 2) {
      const currentSignals = recent[recent.length - 1].signalCount;
      const dangerThreshold = currentSignals * 2;
      const cyclesUntil = Math.ceil(dangerThreshold / signalSlope);
      forecasts.push({
        predictedStatus: 'unhealthy',
        confidence: Math.min(signalSlope * 5, 0.8),
        cyclesUntil: Math.max(cyclesUntil, 1),
        driver: 'signal-growth',
        explanation: `Health signal count growing at ${signalSlope.toFixed(2)}/cycle (currently ${currentSignals} signals)`,
        recommendation: 'New health signals appearing — check for emerging issues with `crisismode scan --verbose`.',
      });
    }

    // 3. Pattern recurrence — known patterns predict future issues
    const patterns = this.detectPatterns();
    for (const pattern of patterns) {
      if (pattern.pattern === 'flapping' && pattern.occurrences >= 4) {
        forecasts.push({
          predictedStatus: 'unhealthy',
          confidence: Math.min(pattern.occurrences * 0.15, 0.85),
          cyclesUntil: 3,
          driver: 'pattern-recurrence',
          explanation: `Flapping detected (${pattern.occurrences} transitions) — system likely to become unstable again`,
          recommendation: 'Flapping indicates an intermittent root cause. Investigate before the next failure cycle.',
        });
      }
      if (pattern.pattern === 'degradation-cycle' && pattern.occurrences >= 2) {
        forecasts.push({
          predictedStatus: 'unhealthy',
          confidence: Math.min(pattern.occurrences * 0.2, 0.9),
          cyclesUntil: 5,
          driver: 'pattern-recurrence',
          explanation: `Degradation cycle detected (${pattern.occurrences}x) — system repeatedly failing and partially recovering`,
          recommendation: 'Recurring degradation suggests incomplete recovery. Review previous recovery proposals.',
        });
      }
    }

    // 4. Status trajectory — if last N snapshots show a trend toward unhealthy
    const lastN = this.snapshots.slice(-5);
    const statusWeights: Record<string, number> = { healthy: 1, recovering: 0.5, unhealthy: 0, unknown: 0.3 };
    const statusSlope = linearSlope(lastN.map((s) => statusWeights[s.status] ?? 0.5));
    if (statusSlope < -0.1 && this.lastStatus !== 'unhealthy') {
      forecasts.push({
        predictedStatus: 'unhealthy',
        confidence: Math.min(Math.abs(statusSlope) * 3, 0.8),
        cyclesUntil: Math.ceil(1 / Math.abs(statusSlope)),
        driver: 'status-trajectory',
        explanation: 'Health status trending downward across recent cycles',
        recommendation: 'System health deteriorating. Proactive diagnosis recommended.',
      });
    }

    // Sort by confidence descending
    forecasts.sort((a, b) => b.confidence - a.confidence);
    return forecasts;
  }

  /** Detect recurring health patterns (e.g., flapping, degradation cycles). */
  detectPatterns(): RecurringPattern[] {
    const patterns: RecurringPattern[] = [];
    if (this.snapshots.length < 3) return patterns;

    // Pattern: Flapping (rapid healthy<->unhealthy transitions)
    const recentTransitions = this.transitions.slice(-PATTERN_WINDOW);
    const flaps = recentTransitions.filter(
      (t) =>
        (t.from === 'healthy' && t.to === 'unhealthy') ||
        (t.from === 'unhealthy' && t.to === 'healthy'),
    );
    if (flaps.length >= 3) {
      patterns.push({
        pattern: 'flapping',
        occurrences: flaps.length,
        firstSeen: flaps[0].timestamp,
        lastSeen: flaps[flaps.length - 1].timestamp,
        description: `Health status flapping between healthy and unhealthy (${flaps.length} transitions in recent window)`,
      });
    }

    // Pattern: Degradation cycle (healthy -> recovering -> unhealthy repeats)
    const degradationSequences = this.findStatusSequences(['healthy', 'recovering', 'unhealthy']);
    if (degradationSequences >= 2) {
      const recoveringSnapshots = this.snapshots.filter((s) => s.status === 'recovering');
      patterns.push({
        pattern: 'degradation-cycle',
        occurrences: degradationSequences,
        firstSeen: recoveringSnapshots[0]?.timestamp ?? this.startedAt,
        lastSeen: recoveringSnapshots[recoveringSnapshots.length - 1]?.timestamp ?? this.lastUpdated,
        description: `Recurring degradation cycle: healthy → recovering → unhealthy (${degradationSequences} occurrences)`,
      });
    }

    // Pattern: Confidence drift (average confidence dropping over time)
    const confidenceDrift = this.detectConfidenceDrift();
    if (confidenceDrift !== null) {
      patterns.push({
        pattern: 'confidence-drift',
        occurrences: 1,
        firstSeen: this.snapshots[0].timestamp,
        lastSeen: this.snapshots[this.snapshots.length - 1].timestamp,
        description: `Confidence trending ${confidenceDrift < 0 ? 'down' : 'up'} (${(confidenceDrift * 100).toFixed(1)}% change)`,
      });
    }

    // Pattern: Persistent unhealthy (unhealthy for N+ consecutive cycles)
    const consecutiveUnhealthy = this.countConsecutiveStatus('unhealthy');
    if (consecutiveUnhealthy >= 5) {
      const unhealthySnapshots = this.snapshots.filter((s) => s.status === 'unhealthy');
      patterns.push({
        pattern: 'persistent-unhealthy',
        occurrences: consecutiveUnhealthy,
        firstSeen: unhealthySnapshots[0]?.timestamp ?? this.startedAt,
        lastSeen: unhealthySnapshots[unhealthySnapshots.length - 1]?.timestamp ?? this.lastUpdated,
        description: `System has been unhealthy for ${consecutiveUnhealthy} consecutive cycles`,
      });
    }

    return patterns;
  }

  /** Get a full summary of watch state. */
  getSummary(): WatchStateSummary {
    const card = this.getHealthCard();
    return {
      totalCycles: this.snapshots.length,
      healthSnapshots: [...this.snapshots],
      transitions: [...this.transitions],
      proposals: [...this.proposals],
      patterns: card.patterns,
      startedAt: this.startedAt,
      lastUpdated: this.lastUpdated,
      uptimePercent: card.uptimePercent,
      avgConfidence: card.avgConfidence,
    };
  }

  /** Serialise state to JSON-safe object for persistence. */
  serialise(): SerializedWatchState {
    return {
      version: 1,
      target: this.target,
      snapshots: [...this.snapshots],
      transitions: [...this.transitions],
      proposals: [...this.proposals],
      startedAt: this.startedAt,
      lastUpdated: this.lastUpdated,
    };
  }

  /** Restore state from a serialised object. */
  static deserialise(data: SerializedWatchState): WatchState {
    const state = new WatchState(data.target, data.startedAt);
    state.snapshots = [...data.snapshots];
    state.transitions = [...data.transitions];
    state.proposals = [...data.proposals];
    state.lastUpdated = data.lastUpdated;

    // Restore lastStatus from the most recent snapshot
    if (data.snapshots.length > 0) {
      state.lastStatus = data.snapshots[data.snapshots.length - 1].status;
    }

    return state;
  }

  // ── Private helpers ──

  private findStatusSequences(sequence: HealthStatus[]): number {
    if (this.snapshots.length < sequence.length) return 0;
    let count = 0;
    let seqIndex = 0;

    for (const snapshot of this.snapshots) {
      if (snapshot.status === sequence[seqIndex]) {
        seqIndex++;
        if (seqIndex === sequence.length) {
          count++;
          seqIndex = 0;
        }
      } else if (snapshot.status === sequence[0]) {
        seqIndex = 1;
      } else {
        seqIndex = 0;
      }
    }

    return count;
  }

  private detectConfidenceDrift(): number | null {
    if (this.snapshots.length < 10) return null;

    const half = Math.floor(this.snapshots.length / 2);
    const firstHalf = this.snapshots.slice(0, half);
    const secondHalf = this.snapshots.slice(half);

    const avgFirst = firstHalf.reduce((s, snap) => s + snap.confidence, 0) / firstHalf.length;
    const avgSecond = secondHalf.reduce((s, snap) => s + snap.confidence, 0) / secondHalf.length;

    const drift = avgSecond - avgFirst;

    // Only report significant drift (>5%)
    if (Math.abs(drift) < 0.05) return null;
    return drift;
  }

  private countConsecutiveStatus(status: HealthStatus): number {
    let max = 0;
    let current = 0;
    for (const snapshot of this.snapshots) {
      if (snapshot.status === status) {
        current++;
        max = Math.max(max, current);
      } else {
        current = 0;
      }
    }
    return max;
  }
}

// ── Utilities ──

/**
 * Simple linear regression slope over a sequence of values.
 * Returns the rate of change per index step.
 */
function linearSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;

  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumX2 += i * i;
  }

  const denominator = n * sumX2 - sumX * sumX;
  if (denominator === 0) return 0;

  return (n * sumXY - sumX * sumY) / denominator;
}
