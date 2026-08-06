// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';
import {
  probeNetwork,
  getNetworkProfile,
  isInternetAvailable,
  isHubReachable,
  resetNetworkProfile,
} from '../framework/network-profile.js';
import { probeTcpBounded } from '../framework/triage-probes.js';

afterEach(() => {
  resetNetworkProfile();
});

describe('network-profile', () => {
  describe('getNetworkProfile', () => {
    it('returns null before probeNetwork is called', () => {
      expect(getNetworkProfile()).toBeNull();
    });

    it('returns cached profile after probeNetwork', async () => {
      await probeNetwork();
      const profile = getNetworkProfile();
      expect(profile).not.toBeNull();
      expect(profile!.profiledAt).toBeTruthy();
      expect(profile!.mode).toBeTruthy();
    });
  });

  describe('probeNetwork', () => {
    it('returns a profile with all layers', async () => {
      const profile = await probeNetwork();

      expect(profile.internet).toBeDefined();
      expect(profile.hub).toBeDefined();
      expect(profile.targets).toBeDefined();
      expect(profile.dns).toBeDefined();
      expect(profile.mode).toBeTruthy();
      expect(['full', 'private_only', 'isolated', 'unknown']).toContain(profile.mode);
    });

    it('probes hub endpoint when provided', async () => {
      const profile = await probeNetwork({
        hubEndpoint: 'http://localhost:9999',
      });

      expect(profile.hub.probes.length).toBe(1);
      expect(profile.hub.probes[0]!.target).toBe('hub');
    });

    it('probes custom targets when provided', async () => {
      const profile = await probeNetwork({
        targets: [
          { host: 'localhost', port: 9998, label: 'test-target' },
        ],
      });

      expect(profile.targets.probes.length).toBe(1);
      expect(profile.targets.probes[0]!.target).toBe('test-target');
    });

    it('reports hub as unknown when no endpoint given', async () => {
      const profile = await probeNetwork();
      expect(profile.hub.status).toBe('unknown');
    });

    it('reports targets as unknown when none given', async () => {
      const profile = await probeNetwork();
      expect(profile.targets.status).toBe('unknown');
    });
  });

  describe('convenience helpers', () => {
    it('isInternetAvailable returns false before probe', () => {
      expect(isInternetAvailable()).toBe(false);
    });

    it('isHubReachable returns false before probe', () => {
      expect(isHubReachable()).toBe(false);
    });
  });

  describe('resetNetworkProfile', () => {
    it('clears the cached profile', async () => {
      await probeNetwork();
      expect(getNetworkProfile()).not.toBeNull();
      resetNetworkProfile();
      expect(getNetworkProfile()).toBeNull();
    });
  });
});

describe('shared bounded-execution machinery', () => {
  it('probeTcpBounded produces the ProbeResult shape probeNetwork returns', async () => {
    const shared = await probeTcpBounded('127.0.0.1', 1, 'closed-port', 500);
    const profile = await probeNetwork({ targets: [{ host: '127.0.0.1', port: 1, label: 'closed-port' }] });
    const viaProfile = profile.targets.probes[0]!;

    expect(Object.keys(shared).sort()).toEqual(Object.keys(viaProfile).sort());
    expect(shared.target).toBe(viaProfile.target);
    expect(shared.reachable).toBe(false);
    expect(viaProfile.reachable).toBe(false);
    expect(typeof viaProfile.latencyMs).toBe('number');
  });

  // This module and triage answer different DNS questions on purpose. The
  // behavioral difference only shows up on hosts where getaddrinfo and a raw
  // query disagree (hosts-file entries, split-DNS), so a runtime assertion
  // would pass on most machines even after a wrong swap. Assert the API.
  it('probeDns still asks the getaddrinfo question, not a raw resolver query', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../framework/network-profile.ts', import.meta.url)),
      'utf-8',
    );
    expect(source).toContain('lookup');
    expect(source).not.toContain('boundedResolve');
    // ...while still delegating the timeout plumbing to the shared helper.
    expect(source).toContain('runBounded');
  });
});
