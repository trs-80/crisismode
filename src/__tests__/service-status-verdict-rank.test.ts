// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import {
  worstVerdict, isUnreachableVerdict, HEALTH_STATUS_BY_VERDICT, SCENARIO_BY_VERDICT,
} from '../agent/service-status/verdict-rank.js';
import type { ServiceStatusReport, ServiceVerdict } from '../framework/service-status/types.js';

function reportWith(verdict: ServiceVerdict): ServiceStatusReport {
  return {
    id: 'stripe',
    label: 'Stripe',
    source: 'catalog',
    host: 'api.stripe.com',
    port: 443,
    statusAssessment: 'operational',
    incidents: [],
    probe: 'reachable',
    verdict,
    detail: 'stub',
    checkedAt: new Date().toISOString(),
    durationMs: 1,
  };
}

describe('worstVerdict', () => {
  it('defaults to healthy for an empty report list', () => {
    expect(worstVerdict([])).toBe('healthy');
  });

  it('confirmed_incident outranks every other real verdict', () => {
    expect(worstVerdict([reportWith('degraded_upstream'), reportWith('confirmed_incident')])).toBe('confirmed_incident');
  });

  /**
   * Regression: an earlier version ranked `offline_skipped` at -1, below
   * `worstVerdict`'s 'healthy' seed (rank 0) — an all-skipped report set
   * never displaced the seed and the function returned 'healthy'. Fixed by
   * ranking `offline_skipped` above every other verdict (Task 6 review
   * Finding 2).
   */
  it('offline_skipped outranks healthy — an all-skipped report set is not reported as healthy', () => {
    expect(worstVerdict([reportWith('offline_skipped')])).toBe('offline_skipped');
    expect(worstVerdict([reportWith('healthy'), reportWith('offline_skipped')])).toBe('offline_skipped');
  });

  it('offline_skipped outranks even confirmed_incident — an unchecked fact beats a checked-and-bad one', () => {
    expect(worstVerdict([reportWith('confirmed_incident'), reportWith('offline_skipped')])).toBe('offline_skipped');
  });
});

describe('isUnreachableVerdict', () => {
  it('is true for down_for_you and the unreachable_* family', () => {
    expect(isUnreachableVerdict('down_for_you')).toBe(true);
    expect(isUnreachableVerdict('unreachable_unverified')).toBe(true);
    expect(isUnreachableVerdict('unreachable_probe_only')).toBe(true);
  });

  it('is false for every healthy variant, degraded, incident, and offline_skipped', () => {
    expect(isUnreachableVerdict('healthy')).toBe(false);
    expect(isUnreachableVerdict('healthy_probe_only')).toBe(false);
    expect(isUnreachableVerdict('healthy_unverified')).toBe(false);
    expect(isUnreachableVerdict('degraded_upstream')).toBe(false);
    expect(isUnreachableVerdict('confirmed_incident')).toBe(false);
    expect(isUnreachableVerdict('offline_skipped')).toBe(false);
  });
});

describe('offline_skipped degrades honestly downstream of the worst-verdict rank change', () => {
  it('maps to an unknown HealthStatus, not a fabricated healthy/recovering/unhealthy', () => {
    expect(HEALTH_STATUS_BY_VERDICT.offline_skipped).toBe('unknown');
  });

  it('maps to a null scenario — never asserts a dependency failure that was never checked', () => {
    expect(SCENARIO_BY_VERDICT.offline_skipped).toBeNull();
  });
});
