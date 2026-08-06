// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted: the mock factory is evaluated when triage.js is first imported,
// which happens before a plain `const` at module scope is initialised.
const { getTriageReport } = vi.hoisted(() => ({ getTriageReport: vi.fn() }));
vi.mock('../framework/triage.js', () => ({ getTriageReport }));

import { defaultOfflineGate } from '../agent/llm-provider/offline-gate.js';

function report(verdict: string) {
  return {
    verdict,
    explanation: `triage says: ${verdict}`,
    nextStep: 'do the thing',
    layers: [],
    observerContext: 'laptop',
    observerContextEvidence: 'darwin',
    escalationLevel: 2,
    checkedAt: new Date().toISOString(),
    durationMs: 12,
  };
}

beforeEach(() => {
  getTriageReport.mockReset();
});

describe('defaultOfflineGate', () => {
  it('defers when triage localised the failure to this machine', async () => {
    getTriageReport.mockReturnValue(report('local'));
    expect(await defaultOfflineGate()).toEqual({ verdict: 'local', explanation: 'triage says: local' });
  });

  it('defers when triage localised the failure to the network', async () => {
    getTriageReport.mockReturnValue(report('network'));
    expect(await defaultOfflineGate()).toEqual({ verdict: 'network', explanation: 'triage says: network' });
  });

  it('does not defer when triage has not run — null is no information, not offline', async () => {
    getTriageReport.mockReturnValue(null);
    expect(await defaultOfflineGate()).toBeNull();
  });

  it('does not defer on a mixed verdict — "could not localise" is not evidence the observer is offline', async () => {
    getTriageReport.mockReturnValue(report('mixed'));
    expect(await defaultOfflineGate()).toBeNull();
  });

  it('does not defer when the machine and network are fine', async () => {
    for (const verdict of ['healthy', 'remote']) {
      getTriageReport.mockReturnValue(report(verdict));
      expect(await defaultOfflineGate(), verdict).toBeNull();
    }
  });

  it('does not defer when reading the triage cache throws', async () => {
    getTriageReport.mockImplementation(() => { throw new Error('triage module exploded'); });
    expect(await defaultOfflineGate()).toBeNull();
  });

  it('never runs triage itself — only the cached accessor is called', async () => {
    getTriageReport.mockReturnValue(null);
    await defaultOfflineGate();
    expect(getTriageReport).toHaveBeenCalledTimes(1);
  });
});
