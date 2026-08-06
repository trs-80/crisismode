// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import {
  buildCaptiveLayer, buildDnsLayer, buildGatewayLayer, buildInterfaceLayer,
  buildInternetLayer, buildTargetsLayer, CAPTIVE_ENDPOINTS, matchesCaptiveExpectation,
} from '../framework/triage.js';
import type { HttpProbeResult } from '../framework/triage.js';

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

const gstatic = CAPTIVE_ENDPOINTS[0]!;
const apple = CAPTIVE_ENDPOINTS[1]!;

function http(over: Partial<HttpProbeResult> = {}): HttpProbeResult {
  return { status: 204, body: '', redirected: false, latencyMs: 8, ...over };
}

describe('matchesCaptiveExpectation', () => {
  it('accepts an exactly-204 empty response from gstatic', () => {
    expect(matchesCaptiveExpectation(gstatic, http())).toBe(true);
  });

  it('rejects a 200 with a body from gstatic', () => {
    expect(matchesCaptiveExpectation(gstatic, http({ status: 200, body: '<html>sign in</html>' }))).toBe(false);
  });

  it('accepts captive.apple.com answering 200 with Success in the body', () => {
    expect(matchesCaptiveExpectation(apple, http({ status: 200, body: '<HTML><BODY>Success</BODY></HTML>' }))).toBe(true);
  });

  it('rejects a 200 from captive.apple.com without Success', () => {
    expect(matchesCaptiveExpectation(apple, http({ status: 200, body: '<html>hotel wifi</html>' }))).toBe(false);
  });

  it('rejects any redirect', () => {
    expect(matchesCaptiveExpectation(gstatic, http({ status: 302, redirected: true }))).toBe(false);
  });

  it('rejects a probe that never completed', () => {
    expect(matchesCaptiveExpectation(gstatic, http({ status: null, error: 'fetch failed' }))).toBe(false);
  });
});

describe('buildCaptiveLayer', () => {
  it('passes when every endpoint that responds matches its expected response', () => {
    const layer = buildCaptiveLayer([{ endpoint: gstatic, probe: http() }], 20);
    expect(layer.status).toBe('pass');
  });

  it('reports a captive portal when a response arrives but does not match', () => {
    const layer = buildCaptiveLayer([{ endpoint: gstatic, probe: http({ status: 302, redirected: true }) }], 20);
    expect(layer.status).toBe('fail');
    expect(layer.code).toBe('captive-portal');
    expect(layer.nextStep).toContain('sign-in');
  });

  it('reports a captive portal when one endpoint matches but another does not', () => {
    // A gstatic 204 must not hide an Apple redirect (or vice versa) running
    // alongside it — any mismatching or redirected endpoint means a portal.
    const layer = buildCaptiveLayer([
      { endpoint: gstatic, probe: http() },
      { endpoint: apple, probe: http({ status: 302, redirected: true }) },
    ], 20);
    expect(layer.status).toBe('fail');
    expect(layer.code).toBe('captive-portal');
  });

  it('records unknown when no connectivity-check endpoint responded at all', () => {
    const layer = buildCaptiveLayer([{ endpoint: gstatic, probe: http({ status: null, error: 'fetch failed' }) }], 20);
    expect(layer.status).toBe('unknown');
  });
});

describe('buildInternetLayer', () => {
  it('passes when at least one host answers, and records per-host probes', () => {
    const layer = buildInternetLayer([
      { url: 'https://api.anthropic.com', probe: http({ status: 401, latencyMs: 40 }) },
      { url: 'https://api.github.com', probe: http({ status: null, error: 'fetch failed', latencyMs: 1500 }) },
    ], 60);
    expect(layer.status).toBe('pass');
    expect(layer.probes).toHaveLength(2);
    expect(layer.probes![0]!.reachable).toBe(true);
    expect(layer.probes![1]!.error).toBe('fetch failed');
  });

  it('fails when no host answers', () => {
    const layer = buildInternetLayer([
      { url: 'https://api.anthropic.com', probe: http({ status: null, error: 'fetch failed' }) },
    ], 60);
    expect(layer.status).toBe('fail');
    expect(layer.code).toBe('internet-unreachable');
  });
});

describe('buildTargetsLayer', () => {
  it('skips when there is nothing to probe', () => {
    const layer = buildTargetsLayer([], 0);
    expect(layer.status).toBe('skipped');
  });

  it('passes when every target accepts a connection', () => {
    const layer = buildTargetsLayer([{ target: 'pg', reachable: true, latencyMs: 3 }], 5);
    expect(layer.status).toBe('pass');
  });

  it('reports targets-partial when only some answer', () => {
    const layer = buildTargetsLayer([
      { target: 'pg', reachable: true, latencyMs: 3 },
      { target: 'redis', reachable: false, latencyMs: 800, error: 'ECONNREFUSED' },
    ], 810);
    expect(layer.status).toBe('fail');
    expect(layer.code).toBe('targets-partial');
    expect(layer.detail).toContain('redis');
  });

  it('reports targets-unreachable when none answer', () => {
    const layer = buildTargetsLayer([{ target: 'pg', reachable: false, latencyMs: 800 }], 810);
    expect(layer.status).toBe('fail');
    expect(layer.code).toBe('targets-unreachable');
  });
});
