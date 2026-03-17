// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from 'vitest';
import {
  probeNetwork,
  getNetworkProfile,
  isInternetAvailable,
  isHubReachable,
  resetNetworkProfile,
} from '../framework/network-profile.js';

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
      expect(profile.hub.probes[0].target).toBe('hub');
    });

    it('probes custom targets when provided', async () => {
      const profile = await probeNetwork({
        targets: [
          { host: 'localhost', port: 9998, label: 'test-target' },
        ],
      });

      expect(profile.targets.probes.length).toBe(1);
      expect(profile.targets.probes[0].target).toBe('test-target');
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
