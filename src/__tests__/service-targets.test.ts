// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { serviceTargetsFromConfig, serviceStatusWatchingDetail } from '../cli/service-targets.js';
import type { SiteConfig } from '../config/schema.js';

function configWith(services: SiteConfig['services']): SiteConfig {
  return {
    apiVersion: 'crisismode/v1',
    kind: 'SiteConfig',
    metadata: { name: 'test-site', environment: 'development' },
    targets: [],
    ...(services !== undefined ? { services } : {}),
  };
}

describe('serviceTargetsFromConfig', () => {
  it('returns no targets when services is absent', () => {
    const config = configWith(undefined);
    expect(serviceTargetsFromConfig(config)).toEqual([]);
  });

  it('returns no targets when services is empty', () => {
    expect(serviceTargetsFromConfig(configWith([]))).toEqual([]);
  });

  it('synthesizes a catalog id as a service-status target using the catalog probe host/port', () => {
    const targets = serviceTargetsFromConfig(configWith(['github']));
    expect(targets).toEqual([
      { name: 'github', kind: 'service-status', primary: { host: 'api.github.com', port: 443 } },
    ]);
  });

  it('resolves a catalog alias to its canonical id', () => {
    const targets = serviceTargetsFromConfig(configWith(['flyio']));
    expect(targets[0]?.name).toBe('fly');
  });

  it('synthesizes a raw domain (no catalog entry) with port 443 by default', () => {
    const targets = serviceTargetsFromConfig(configWith(['api.myvendor.com']));
    expect(targets).toEqual([
      { name: 'api.myvendor.com', kind: 'service-status', primary: { host: 'api.myvendor.com', port: 443 } },
    ]);
  });

  it('synthesizes the long { host, port } form with the explicit port', () => {
    const targets = serviceTargetsFromConfig(configWith([{ host: 'internal.example.com', port: 8443 }]));
    expect(targets).toEqual([
      { name: 'internal.example.com', kind: 'service-status', primary: { host: 'internal.example.com', port: 8443 } },
    ]);
  });

  it('every synthesized target has a mandatory, non-simulator primary', () => {
    const targets = serviceTargetsFromConfig(configWith(['stripe', 'a-raw-domain.example.com']));
    for (const target of targets) {
      expect(target.primary).toBeDefined();
      expect(target.primary?.host).not.toBe('simulator');
    }
  });

  it('preserves configured order and handles multiple mixed entries', () => {
    const targets = serviceTargetsFromConfig(configWith(['stripe', 'github', { host: 'api.myvendor.com' }]));
    expect(targets.map((t) => t.name)).toEqual(['stripe', 'github', 'api.myvendor.com']);
    expect(targets.every((t) => t.kind === 'service-status')).toBe(true);
  });
});

describe('serviceStatusWatchingDetail', () => {
  it('lists catalog services by id with no annotation', () => {
    expect(serviceStatusWatchingDetail(configWith(['stripe', 'github']))).toBe('watching stripe, github');
  });

  it('annotates a raw domain as reachability-only', () => {
    expect(serviceStatusWatchingDetail(configWith(['stripe', 'api.myvendor.com']))).toBe(
      'watching stripe, api.myvendor.com (reachability only)',
    );
  });

  it('annotates every raw domain individually when there are more than one', () => {
    expect(serviceStatusWatchingDetail(configWith(['api.one.example.com', 'api.two.example.com']))).toBe(
      'watching api.one.example.com (reachability only), api.two.example.com (reachability only)',
    );
  });
});
