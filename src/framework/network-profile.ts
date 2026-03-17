// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Network profile — lightweight connectivity assessment run once at startup.
 *
 * Probes three layers:
 *   1. Internet — can we reach external APIs? (Anthropic, GitHub, etc.)
 *   2. Hub — can the spoke reach the coordination hub?
 *   3. Targets — can we reach the configured infrastructure targets?
 *
 * Results are cached for the lifetime of the process to avoid repeated
 * probing during a crisis. Consumers use `getNetworkProfile()` to read
 * the cached result without blocking.
 *
 * Design rationale:
 * - DNS resolution is tested separately from TCP connect so we can
 *   distinguish "no DNS" from "firewall blocking port 443".
 * - Internet probe uses a HEAD request against a well-known, highly
 *   available endpoint (Anthropic API root). We don't send credentials.
 * - All probes run in parallel with short timeouts (3s) so the total
 *   startup cost is ~3s even in a fully air-gapped environment.
 * - The profile is informational — it never blocks execution. Features
 *   that need internet should check `profile.internet.available` and
 *   skip gracefully rather than waiting for a timeout.
 */

import { createConnection } from 'node:net';
import { lookup } from 'node:dns/promises';

// ── Types ──

export type ConnectivityStatus = 'available' | 'unavailable' | 'degraded' | 'unknown';

export interface ProbeResult {
  target: string;
  reachable: boolean;
  latencyMs: number;
  error?: string;
}

export interface NetworkLayer {
  status: ConnectivityStatus;
  probes: ProbeResult[];
  checkedAt: string;
}

export interface NetworkProfile {
  /** Can we reach external internet APIs? */
  internet: NetworkLayer;
  /** Can we reach the CrisisMode hub? */
  hub: NetworkLayer;
  /** Can we reach configured infrastructure targets? */
  targets: NetworkLayer;
  /** DNS resolution working? */
  dns: { available: boolean; latencyMs: number };
  /** Overall operating mode inferred from the profile */
  mode: NetworkMode;
  /** When this profile was created */
  profiledAt: string;
}

export type NetworkMode =
  | 'full'           // Internet + private network available
  | 'private_only'   // Private network reachable, no internet
  | 'isolated'       // No network connectivity at all
  | 'unknown';       // Probes haven't run yet

// ── Default probe targets ──

const INTERNET_PROBES = [
  { host: 'api.anthropic.com', port: 443, label: 'anthropic-api' },
  { host: 'api.github.com', port: 443, label: 'github-api' },
];

const DNS_TEST_HOST = 'api.anthropic.com';
const PROBE_TIMEOUT_MS = 3_000;

// ── Singleton cache ──

let cachedProfile: NetworkProfile | null = null;

/**
 * Get the cached network profile. Returns null if `probeNetwork()` hasn't
 * been called yet. This is a non-blocking read.
 */
export function getNetworkProfile(): NetworkProfile | null {
  return cachedProfile;
}

/**
 * Check whether internet is available, using the cached profile.
 * Returns false if the profile hasn't been built yet (fail-safe).
 */
export function isInternetAvailable(): boolean {
  return cachedProfile?.internet.status === 'available';
}

/**
 * Check whether the hub is reachable, using the cached profile.
 */
export function isHubReachable(): boolean {
  return cachedProfile?.hub.status === 'available';
}

/**
 * Probe network connectivity and cache the result.
 *
 * Call this once at CLI startup. All probes run in parallel, total
 * wall-clock time is bounded by PROBE_TIMEOUT_MS (~3s).
 *
 * @param hubEndpoint - Optional hub URL from site config
 * @param targets - Optional list of {host, port} targets from site config
 */
export async function probeNetwork(options: {
  hubEndpoint?: string;
  targets?: Array<{ host: string; port: number; label: string }>;
} = {}): Promise<NetworkProfile> {
  const start = Date.now();

  // Run all probes in parallel
  const [dnsResult, internetProbes, hubProbes, targetProbes] = await Promise.all([
    probeDns(),
    probeEndpoints(INTERNET_PROBES),
    options.hubEndpoint ? probeHub(options.hubEndpoint) : Promise.resolve([]),
    options.targets ? probeEndpoints(options.targets) : Promise.resolve([]),
  ]);

  const internet = buildLayer(internetProbes);
  const hub = buildLayer(hubProbes);
  const targets = buildLayer(targetProbes);
  const mode = inferMode(internet, hub, targets, dnsResult.available);

  const profile: NetworkProfile = {
    internet,
    hub,
    targets,
    dns: dnsResult,
    mode,
    profiledAt: new Date(start).toISOString(),
  };

  cachedProfile = profile;
  return profile;
}

/**
 * Reset the cached profile. Useful for testing.
 */
export function resetNetworkProfile(): void {
  cachedProfile = null;
}

// ── Internal probing functions ──

async function probeDns(): Promise<{ available: boolean; latencyMs: number }> {
  const start = Date.now();
  try {
    await withTimeout(lookup(DNS_TEST_HOST), PROBE_TIMEOUT_MS);
    return { available: true, latencyMs: Date.now() - start };
  } catch {
    return { available: false, latencyMs: Date.now() - start };
  }
}

async function probeEndpoints(
  endpoints: Array<{ host: string; port: number; label: string }>,
): Promise<ProbeResult[]> {
  return Promise.all(endpoints.map((ep) => probeTcp(ep.host, ep.port, ep.label)));
}

async function probeHub(endpoint: string): Promise<ProbeResult[]> {
  try {
    const url = new URL(endpoint);
    const host = url.hostname;
    const port = url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 80);
    return [await probeTcp(host, port, 'hub')];
  } catch {
    return [{
      target: 'hub',
      reachable: false,
      latencyMs: 0,
      error: `Invalid hub endpoint: ${endpoint}`,
    }];
  }
}

function probeTcp(host: string, port: number, label: string): Promise<ProbeResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });

    const timer = setTimeout(() => {
      socket.destroy();
      resolve({
        target: label,
        reachable: false,
        latencyMs: Date.now() - start,
        error: `Timeout after ${PROBE_TIMEOUT_MS}ms`,
      });
    }, PROBE_TIMEOUT_MS);

    socket.on('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({
        target: label,
        reachable: true,
        latencyMs: Date.now() - start,
      });
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({
        target: label,
        reachable: false,
        latencyMs: Date.now() - start,
        error: err.message,
      });
    });
  });
}

function buildLayer(probes: ProbeResult[]): NetworkLayer {
  if (probes.length === 0) {
    return { status: 'unknown', probes: [], checkedAt: new Date().toISOString() };
  }

  const reachableCount = probes.filter((p) => p.reachable).length;
  let status: ConnectivityStatus;
  if (reachableCount === probes.length) {
    status = 'available';
  } else if (reachableCount > 0) {
    status = 'degraded';
  } else {
    status = 'unavailable';
  }

  return { status, probes, checkedAt: new Date().toISOString() };
}

function inferMode(
  internet: NetworkLayer,
  hub: NetworkLayer,
  targets: NetworkLayer,
  dnsAvailable: boolean,
): NetworkMode {
  const hasInternet = internet.status === 'available' || internet.status === 'degraded';
  const hasPrivateNetwork = hub.status === 'available'
    || hub.status === 'degraded'
    || targets.status === 'available'
    || targets.status === 'degraded';

  if (hasInternet) return 'full';
  if (hasPrivateNetwork || dnsAvailable) return 'private_only';
  if (internet.probes.length === 0 && hub.probes.length === 0 && targets.probes.length === 0) return 'unknown';
  return 'isolated';
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout')), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
