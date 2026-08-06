// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, vi } from 'vitest';
import { runTriage } from '../framework/triage.js';
import type { DnsProbeResult, TriageProbes } from '../framework/triage.js';

function healthyProbes(overrides: Partial<TriageProbes> = {}): TriageProbes {
  return {
    listInterfaces: async () => ({ activeInterfaces: ['en0'] }),
    findDefaultGateway: async () => ({ address: '192.168.1.1' }),
    resolveDns: async () => ({ systemResolved: true, publicResolved: true }),
    // GET is only ever used for the two captive-portal endpoints, and each
    // has its own real expected response (see CAPTIVE_ENDPOINTS) — a single
    // fixed GET response cannot satisfy both simultaneously, since
    // captive.apple.com's healthy response is a 200 with a "Success" body
    // while gstatic's is a bare 204. HEAD is only used for the internet
    // layer, which accepts any non-error, non-null status.
    fetchUrl: async (url: string, method: 'GET' | 'HEAD') => (
      method === 'HEAD'
        ? { status: 200, body: '', redirected: false, latencyMs: 12 }
        : url.includes('captive.apple.com')
          ? { status: 200, body: 'Success', redirected: false, latencyMs: 5 }
          : { status: 204, body: '', redirected: false, latencyMs: 5 }
    ),
    connectTcp: async (_host: string, _port: number, label: string) => ({ target: label, reachable: true, latencyMs: 3 }),
    ...overrides,
  };
}

const laptop = { context: 'laptop' as const, evidence: 'test fixture' };
const server = { context: 'server' as const, evidence: 'test fixture' };

describe('runTriage', () => {
  it('reports healthy when every layer passes and no targets were given', async () => {
    const report = await runTriage({ probes: healthyProbes(), observerContext: laptop });
    expect(report.verdict).toBe('healthy');
    expect(report.layers.map((l) => l.layer)).toEqual([
      'interfaces', 'gateway', 'dns', 'captive-portal', 'internet', 'targets',
    ]);
    expect(report.layers.find((l) => l.layer === 'targets')!.status).toBe('skipped');
    expect(report.escalationLevel).toBe(2);
    expect(report.observerContext).toBe('laptop');
    expect(report.explanation.length).toBeGreaterThan(0);
    expect(report.nextStep.length).toBeGreaterThan(0);
  });

  it('short-circuits every later layer when no interface is up', async () => {
    const report = await runTriage({
      probes: healthyProbes({ listInterfaces: async () => ({ activeInterfaces: [] }) }),
      observerContext: laptop,
    });
    expect(report.verdict).toBe('local');
    expect(report.layers.filter((l) => l.status === 'skipped')).toHaveLength(5);
  });

  it('skips the captive-portal check in a server environment', async () => {
    const report = await runTriage({ probes: healthyProbes(), observerContext: server });
    const captive = report.layers.find((l) => l.layer === 'captive-portal')!;
    expect(captive.status).toBe('skipped');
    expect(captive.detail).toContain('server environment');
    expect(report.verdict).toBe('healthy');
  });

  it('detects a captive portal from a non-matching response', async () => {
    const report = await runTriage({
      probes: healthyProbes({
        fetchUrl: async (_url: string, method: 'GET' | 'HEAD') => (
          method === 'GET'
            ? { status: 302, body: '', redirected: true, latencyMs: 5 }
            : { status: 200, body: '', redirected: false, latencyMs: 12 }
        ),
      }),
      observerContext: laptop,
    });
    expect(report.verdict).toBe('network');
    expect(report.layers.find((l) => l.layer === 'captive-portal')!.code).toBe('captive-portal');
  });

  it('probes the targets it is given', async () => {
    const report = await runTriage({
      probes: healthyProbes({
        connectTcp: async (_host: string, _port: number, label: string) => ({ target: label, reachable: false, latencyMs: 9, error: 'ECONNREFUSED' }),
      }),
      observerContext: laptop,
      targets: [{ host: '127.0.0.1', port: 5432, label: 'main-pg' }],
    });
    expect(report.verdict).toBe('remote');
    expect(report.layers.find((l) => l.layer === 'targets')!.probes).toHaveLength(1);
  });

  // Stage 4's cap: a large config or autodiscovery result must not open one
  // socket per target unbounded. 25 targets is over MAX_STAGE4_TARGETS (20).
  it('caps the number of targets it probes and reports how many were omitted', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const manyTargets = Array.from({ length: 25 }, (_, i) => (
      { host: '127.0.0.1', port: 5000 + i, label: `svc-${i}` }
    ));
    const report = await runTriage({
      probes: healthyProbes({
        connectTcp: async (_host: string, _port: number, label: string) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await Promise.resolve();
          inFlight -= 1;
          return { target: label, reachable: true, latencyMs: 1 };
        },
      }),
      observerContext: laptop,
      targets: manyTargets,
    });
    const targetsLayer = report.layers.find((l) => l.layer === 'targets')!;
    expect(targetsLayer.probes).toHaveLength(20);
    expect(targetsLayer.detail).toContain('5 additional target(s)');
    // Never more than the concurrency limit's worth of sockets in flight.
    expect(maxInFlight).toBeLessThanOrEqual(5);
  });

  // The OUTER bound: a probe that ignores its own timeout (only reachable via
  // an injected pathological probe — the real ones bound themselves, see the
  // boundedResolve tests in Task 6) is still cut off, and the honest result of
  // an unassessable layer is `mixed`, never `healthy`.
  it('records unknown for a probe that never resolves, without hanging', async () => {
    vi.useFakeTimers();
    try {
      const pending = runTriage({
        probes: healthyProbes({ resolveDns: () => new Promise<DnsProbeResult>(() => {}) }),
        observerContext: laptop,
        timeoutMs: 800,
      });
      await vi.advanceTimersByTimeAsync(10_000);
      const report = await pending;
      expect(report.layers.find((l) => l.layer === 'dns')!.status).toBe('unknown');
      expect(report.verdict).toBe('mixed');
    } finally {
      vi.useRealTimers();
    }
  });

  // The ≤5s acceptance criterion, as a property rather than a hope. Per-probe
  // timeouts here (3s) would otherwise compose to 9s+ across the stages.
  it('finishes inside the whole-run deadline even when every probe stalls', async () => {
    vi.useFakeTimers();
    try {
      const stalled: TriageProbes = {
        listInterfaces: async () => ({ activeInterfaces: ['en0'] }),
        findDefaultGateway: () => new Promise(() => {}),
        resolveDns: () => new Promise(() => {}),
        fetchUrl: () => new Promise(() => {}),
        connectTcp: () => new Promise(() => {}),
      };
      const pending = runTriage({
        probes: stalled,
        observerContext: laptop,
        timeoutMs: 3_000,
        targets: [{ host: '127.0.0.1', port: 5432, label: 'main-pg' }],
      });
      await vi.advanceTimersByTimeAsync(30_000);
      const report = await pending;
      expect(report.durationMs).toBeLessThanOrEqual(5_000);
      expect(report.layers).toHaveLength(6);
      // The deadline bit before the target stage, so targets is unknown-by-budget.
      const targets = report.layers.find((l) => l.layer === 'targets')!;
      expect(targets.status).toBe('unknown');
      expect(targets.detail).toContain('budget');
      // Whatever else is true, a run this degraded may never read as healthy.
      expect(report.verdict).not.toBe('healthy');
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks layers it ran out of budget for as unknown, never skipped', async () => {
    vi.useFakeTimers();
    try {
      // The DNS probe consumes the entire 1000ms budget, so every later stage
      // is out of time before it starts.
      const pending = runTriage({
        probes: healthyProbes({ resolveDns: () => new Promise<DnsProbeResult>(() => {}) }),
        observerContext: laptop,
        timeoutMs: 1_000,
        deadlineMs: 1_000,
      });
      await vi.advanceTimersByTimeAsync(10_000);
      const report = await pending;
      const unrun = report.layers.filter(
        (l) => l.layer === 'captive-portal' || l.layer === 'internet' || l.layer === 'targets',
      );
      expect(unrun).toHaveLength(3);
      expect(unrun.every((l) => l.status === 'unknown')).toBe(true);
      expect(unrun.every((l) => l.status !== 'skipped')).toBe(true);
      expect(unrun[0]!.detail).toContain('budget');
      // A truncated run must never be able to report healthy.
      expect(report.verdict).toBe('mixed');
    } finally {
      vi.useRealTimers();
    }
  });
});
