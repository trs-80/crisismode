// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, vi } from 'vitest';
import {
  checkService,
  checkServices,
  combineVerdict,
  verdictDetail,
  defaultProbe,
  CHECK_CONCURRENCY,
} from '../framework/service-status/checker.js';
import type { ServiceVerdict } from '../framework/service-status/types.js';
import type { StatusAssessment, ProbeOutcome } from '../framework/service-status/types.js';
import type { OfflineGate } from '../framework/offline-gate.js';

// combineVerdict never accepts 'not_checked' (see checker.ts's
// CheckedStatusAssessment) — it can only be produced on the OfflineGate
// short-circuit path, which returns before combineVerdict is ever called.
type CheckedStatusAssessment = Exclude<StatusAssessment, 'not_checked'>;

const MAJOR_WITH_INCIDENT = {
  status: { indicator: 'major', description: 'Partial System Outage' },
  components: [{ name: 'API', status: 'partial_outage' }],
  incidents: [
    { name: 'Elevated API errors', impact: 'major', status: 'investigating', shortlink: 'https://stspg.io/x1' },
  ],
};

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 503,
    json: async () => body,
  } as unknown as Response;
}

describe('combineVerdict', () => {
  const TABLE: Array<[CheckedStatusAssessment, ProbeOutcome, ServiceVerdict]> = [
    ['incident_reported', 'reachable', 'confirmed_incident'],
    ['incident_reported', 'connect_failed', 'confirmed_incident'],
    ['degraded_reported', 'reachable', 'degraded_upstream'],
    ['degraded_reported', 'connect_failed', 'confirmed_incident'],
    ['degraded_reported', 'dns_failed', 'confirmed_incident'],
    ['operational', 'reachable', 'healthy'],
    ['operational', 'connect_failed', 'down_for_you'],
    ['operational', 'dns_failed', 'down_for_you'],
    ['status_unavailable', 'reachable', 'healthy_unverified'],
    ['status_unavailable', 'connect_failed', 'unreachable_unverified'],
    ['no_status_source', 'reachable', 'healthy_probe_only'],
    ['no_status_source', 'connect_failed', 'unreachable_probe_only'],
  ];

  it.each(TABLE)('%s + %s -> %s', (s, p, v) => {
    expect(combineVerdict(s, p)).toBe(v);
  });
});

describe('checkService', () => {
  it('a confirmed incident on a catalog service: verdict confirmed_incident, incidents propagated, honest wording', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(MAJOR_WITH_INCIDENT));
    const probeImpl = vi.fn(async (): Promise<ProbeOutcome> => 'reachable');
    const offlineGate: OfflineGate = async () => null;

    const report = await checkService(
      { id: 'github' },
      { fetchImpl, probeImpl, offlineGate },
    );

    expect(report.verdict).toBe('confirmed_incident');
    expect(report.incidents).toEqual([
      { title: 'Elevated API errors', impact: 'major', url: 'https://stspg.io/x1' },
    ]);
    expect(report.detail).toContain('down for everyone');
    expect(report.source).toBe('catalog');
  });

  it('status fetch rejects: status_unavailable, never worded as an outage', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network unreachable');
    });
    const probeImpl = vi.fn(async (): Promise<ProbeOutcome> => 'reachable');
    const offlineGate: OfflineGate = async () => null;

    const report = await checkService(
      { id: 'github' },
      { fetchImpl, probeImpl, offlineGate },
    );

    expect(report.statusAssessment).toBe('status_unavailable');
    expect(report.detail).toContain("status page couldn't be checked");
    expect(report.detail).not.toContain('down for everyone');
  });

  it('a raw domain with no catalog entry: fetch never called, no_status_source, reachability-only wording', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const probeImpl = vi.fn(async (): Promise<ProbeOutcome> => 'reachable');
    const offlineGate: OfflineGate = async () => null;

    const report = await checkService(
      { id: 'api.myvendor.com', host: 'api.myvendor.com' },
      { fetchImpl, probeImpl, offlineGate },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(report.statusAssessment).toBe('no_status_source');
    expect(report.source).toBe('domain');
    expect(report.detail).toContain('reachability only');
  });

  it('offline per OfflineGate: every check skipped, no provider blamed', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const probeImpl = vi.fn(async (): Promise<ProbeOutcome> => 'reachable');
    const offlineGate: OfflineGate = async () => ({ verdict: 'local', explanation: 'no network interface' });

    const report = await checkService(
      { id: 'github' },
      { fetchImpl, probeImpl, offlineGate },
    );

    expect(report.verdict).toBe('offline_skipped');
    expect(report.probe).toBe('skipped');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(probeImpl).not.toHaveBeenCalled();
  });

  it('offline per OfflineGate: statusAssessment is not_checked, distinct from status_unavailable', async () => {
    // A machine-readable consumer (crisismode down --json) filtering on
    // statusAssessment must be able to tell "we didn't check anything
    // because this machine is offline" apart from "their status page is
    // flaky" (status_unavailable) — the two mean very different things.
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const probeImpl = vi.fn(async (): Promise<ProbeOutcome> => 'reachable');
    const offlineGate: OfflineGate = async () => ({ verdict: 'network', explanation: 'no route to host' });

    const report = await checkService(
      { id: 'github' },
      { fetchImpl, probeImpl, offlineGate },
    );

    expect(report.statusAssessment).toBe('not_checked');
    expect(report.statusAssessment).not.toBe('status_unavailable');
  });

  it('operational but unreachable: down_for_you, hedged wording pointing at the user side', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ status: { indicator: 'none' }, components: [], incidents: [] }),
    );
    const probeImpl = vi.fn(async (): Promise<ProbeOutcome> => 'connect_failed');
    const offlineGate: OfflineGate = async () => null;

    const report = await checkService(
      { id: 'github' },
      { fetchImpl, probeImpl, offlineGate },
    );

    expect(report.verdict).toBe('down_for_you');
    expect(report.detail).toContain('likely your network, DNS, or config');
  });

  /**
   * CodeRabbit wave (Minor): checkService's doc comment promises neither leg
   * can throw out of the function. defaultOfflineGate already catches
   * internally, but an injected offlineGate (CheckerDeps.offlineGate) is a
   * public seam — a rejecting gate must fall through to the normal checks
   * (like a `null`/false result would), not propagate and (inside
   * checkServices) fail the whole Promise.all, discarding every report
   * already computed for other targets.
   */
  it('an offlineGate that rejects falls through to the normal checks instead of throwing out of checkService', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ status: { indicator: 'none' }, components: [], incidents: [] }));
    const probeImpl = vi.fn(async (): Promise<ProbeOutcome> => 'reachable');
    const offlineGate: OfflineGate = async () => {
      throw new Error('gate boom');
    };

    const report = await checkService(
      { id: 'github' },
      { fetchImpl, probeImpl, offlineGate },
    );

    expect(report.verdict).not.toBe('offline_skipped');
    expect(report.verdict).toBe('healthy');
    expect(fetchImpl).toHaveBeenCalled();
    expect(probeImpl).toHaveBeenCalled();
  });
});

describe('defaultProbe — bounded DNS phase (Critical: unbounded dns.lookup)', () => {
  it('a lookup that never resolves classifies as dns_failed within the probe budget, not a real OS resolver timeout', async () => {
    const neverResolvingLookup = (() => new Promise<never>(() => {})) as unknown as Parameters<typeof defaultProbe>[3];
    const budgetMs = 100;

    const start = performance.now();
    const outcome = await defaultProbe('svc.example.invalid', 443, budgetMs, neverResolvingLookup);
    const elapsed = performance.now() - start;

    expect(outcome).toBe('dns_failed');
    // Generous margin over the 100ms budget to absorb CI scheduling jitter —
    // still nowhere close to the seconds-to-tens-of-seconds an actual
    // black-holed OS resolver timeout would take if unbounded.
    expect(elapsed).toBeLessThan(2000);
  });

  it('a lookup that rejects still classifies as dns_failed (unchanged behavior)', async () => {
    const rejectingLookup = (async () => {
      throw new Error('ENOTFOUND');
    }) as unknown as Parameters<typeof defaultProbe>[3];

    const outcome = await defaultProbe('svc.example.invalid', 443, 100, rejectingLookup);
    expect(outcome).toBe('dns_failed');
  });
});

async function flushMicrotasks(times = 15): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe('checkServices concurrency', () => {
  it('bounds in-flight probes to exactly CHECK_CONCURRENCY while targets queue', async () => {
    expect(CHECK_CONCURRENCY).toBe(5);

    const targets = Array.from({ length: 12 }, (_, i) => ({
      id: `svc-${i}.example.com`,
      host: `svc-${i}.example.com`,
    }));

    let inFlight = 0;
    let maxInFlight = 0;
    const deferreds: Array<{ resolve: (v: ProbeOutcome) => void }> = [];

    const probeImpl = vi.fn(
      () =>
        new Promise<ProbeOutcome>((resolve) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          deferreds.push({
            resolve: (v) => {
              inFlight--;
              resolve(v);
            },
          });
        }),
    );

    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const offlineGate: OfflineGate = async () => null;

    const resultsPromise = checkServices(targets, { fetchImpl, probeImpl, offlineGate });

    // Let the microtask queue drain so the pool fills up — no setTimeout, no
    // wall-clock: the assertion is on the pool's structure, released only by
    // hand below.
    await flushMicrotasks();

    expect(inFlight).toBe(5);
    expect(deferreds.length).toBe(5);
    expect(probeImpl).toHaveBeenCalledTimes(5);

    // Release the 12 targets in three waves (5, 5, 2), verifying the pool
    // never exceeds 5 in flight at any point.
    let released = 0;
    while (released < 12) {
      const batch = deferreds.splice(0, deferreds.length);
      expect(batch.length).toBeGreaterThan(0);
      expect(batch.length).toBeLessThanOrEqual(5);
      for (const d of batch) {
        d.resolve('reachable');
        released++;
      }
      await flushMicrotasks();
      expect(inFlight).toBeLessThanOrEqual(5);
      expect(maxInFlight).toBeLessThanOrEqual(5);
    }

    const results = await resultsPromise;
    expect(results).toHaveLength(12);
    expect(probeImpl).toHaveBeenCalledTimes(12);
    expect(maxInFlight).toBe(5);
  });
});

describe('verdictDetail', () => {
  it('reachability-only wording is always present for probe-only verdicts', () => {
    expect(
      verdictDetail({
        verdict: 'healthy_probe_only', label: 'api.foo.com', incidents: [], source: 'domain', statusAssessment: 'no_status_source',
      }),
    ).toContain('reachability only');
    expect(
      verdictDetail({
        verdict: 'unreachable_probe_only', label: 'api.foo.com', incidents: [], source: 'domain', statusAssessment: 'no_status_source',
      }),
    ).toContain('reachability only');
  });

  it('down_for_you hedges toward the user side', () => {
    expect(
      verdictDetail({
        verdict: 'down_for_you', label: 'GitHub', incidents: [], source: 'catalog', statusAssessment: 'operational',
      }),
    ).toContain('likely your network, DNS, or config');
  });

  it('confirmed_incident from an actual incident_reported keeps the "confirmed an incident" / "down for everyone" wording', () => {
    const detail = verdictDetail({
      verdict: 'confirmed_incident', label: 'Stripe', incidents: [], source: 'catalog', statusAssessment: 'incident_reported',
    });
    expect(detail).toContain('down for everyone');
    expect(detail).toContain('confirmed an incident');
  });

  it('confirmed_incident reached via degraded_reported + failed probe does NOT claim a confirmed incident or "down for everyone"', () => {
    // Critical 1: combineVerdict maps degraded_reported + a failed probe to
    // the same 'confirmed_incident' verdict as an actual incident_reported
    // row, but zero incidents were ever confirmed on this path and one
    // machine's failed probe is not "everyone". Branching on
    // statusAssessment must keep this row honest.
    const detail = verdictDetail({
      verdict: 'confirmed_incident', label: 'Stripe', incidents: [], source: 'catalog', statusAssessment: 'degraded_reported',
    });
    expect(detail).not.toContain('confirmed an incident');
    expect(detail).not.toContain('down for everyone');
    expect(detail).toContain('degradation');
  });

  it('incident_reported + a failed probe keeps the existing incident wording (not the degraded wording)', async () => {
    // Through the real checkService so the failed probe actually participates
    // (verdictDetail itself never sees the probe).
    const fetchImpl = vi.fn(async () => jsonResponse(MAJOR_WITH_INCIDENT));
    const probeImpl = vi.fn(async (): Promise<ProbeOutcome> => 'connect_failed');
    const offlineGate: OfflineGate = async () => null;

    const report = await checkService({ id: 'github' }, { fetchImpl, probeImpl, offlineGate });

    expect(report.verdict).toBe('confirmed_incident');
    expect(report.statusAssessment).toBe('incident_reported');
    expect(report.detail).toContain('down for everyone');
    expect(report.detail).toContain('confirmed an incident');
  });
});

describe('fetchStatus via checkService — untested classification paths (ledger #3)', () => {
  it('a non-2xx status response classifies as status_unavailable', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, false));
    const probeImpl = vi.fn(async (): Promise<ProbeOutcome> => 'reachable');
    const offlineGate: OfflineGate = async () => null;

    const report = await checkService(
      { id: 'github' },
      { fetchImpl, probeImpl, offlineGate },
    );

    expect(report.statusAssessment).toBe('status_unavailable');
    expect(report.detail).not.toContain('down for everyone');
  });

  it('a 2xx response with an unparseable body classifies as status_unavailable', async () => {
    // parseStatuspageSummary returns null on a body that doesn't match the
    // Statuspage v2 shape — a 200 response is not itself evidence of health.
    const fetchImpl = vi.fn(async () => jsonResponse({ this: 'is not a statuspage body' }));
    const probeImpl = vi.fn(async (): Promise<ProbeOutcome> => 'reachable');
    const offlineGate: OfflineGate = async () => null;

    const report = await checkService(
      { id: 'github' },
      { fetchImpl, probeImpl, offlineGate },
    );

    expect(report.statusAssessment).toBe('status_unavailable');
    expect(report.detail).not.toContain('down for everyone');
  });
});
