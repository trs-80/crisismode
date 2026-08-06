// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { buildDnsLayer, buildGatewayLayer, buildInterfaceLayer } from '../framework/triage.js';

describe('buildInterfaceLayer', () => {
  it('passes when a non-loopback interface has an address', () => {
    const layer = buildInterfaceLayer({ activeInterfaces: ['en0', 'utun3'] }, 4);
    expect(layer.status).toBe('pass');
    expect(layer.detail).toContain('en0');
    expect(layer.code).toBeUndefined();
    expect(layer.durationMs).toBe(4);
  });

  it('fails with no-active-interface when nothing is up', () => {
    const layer = buildInterfaceLayer({ activeInterfaces: [] }, 1);
    expect(layer.status).toBe('fail');
    expect(layer.code).toBe('no-active-interface');
    expect(layer.nextStep).toContain('Wi-Fi');
  });
});

describe('buildGatewayLayer', () => {
  it('reports the gateway address as context', () => {
    const layer = buildGatewayLayer({ address: '192.168.1.1' }, 2);
    expect(layer.status).toBe('pass');
    expect(layer.detail).toContain('192.168.1.1');
  });

  it('records unknown rather than guessing when the route table is unreadable', () => {
    const layer = buildGatewayLayer({ address: null }, 2);
    expect(layer.status).toBe('unknown');
    expect(layer.code).toBe('gateway-unknown');
    expect(layer.detail).toContain('context only');
  });
});

describe('buildDnsLayer', () => {
  it('passes when the system resolver answers', () => {
    const layer = buildDnsLayer({ systemResolved: true, publicResolved: true }, 12);
    expect(layer.status).toBe('pass');
    expect(layer.code).toBeUndefined();
  });

  it('blames this machine when only the public resolvers answer', () => {
    const layer = buildDnsLayer(
      { systemResolved: false, publicResolved: true, systemError: 'queryA ESERVFAIL' },
      30,
    );
    expect(layer.status).toBe('fail');
    expect(layer.code).toBe('resolver-broken');
    expect(layer.detail).toContain('1.1.1.1');
    expect(layer.detail).toContain('queryA ESERVFAIL');
  });

  it('blames the network when no resolver answers', () => {
    const layer = buildDnsLayer({ systemResolved: false, publicResolved: false }, 40);
    expect(layer.status).toBe('fail');
    expect(layer.code).toBe('dns-unreachable');
    expect(layer.nextStep).toContain('network');
  });
});
