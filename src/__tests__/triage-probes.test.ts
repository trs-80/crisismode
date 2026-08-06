// SPDX-License-Identifier: Apache-2.0

import { createSocket } from 'node:dgram';
import { describe, it, expect } from 'vitest';
import { classifyObserverContext, detectObserverContext } from '../framework/triage-probes.js';

describe('classifyObserverContext', () => {
  it('calls a Kubernetes pod a server', () => {
    const result = classifyObserverContext({
      platform: 'linux',
      env: { KUBERNETES_SERVICE_HOST: '10.96.0.1' },
      dmi: null,
    });
    expect(result.context).toBe('server');
    expect(result.evidence).toContain('KUBERNETES_SERVICE_HOST');
  });

  it('calls a cloud DMI vendor string a server', () => {
    const result = classifyObserverContext({
      platform: 'linux',
      env: {},
      dmi: 'Amazon EC2 t3.medium',
    });
    expect(result.context).toBe('server');
    expect(result.evidence).toContain('amazon');
  });

  it('assumes darwin with no server markers is a laptop, and says it is an assumption', () => {
    const result = classifyObserverContext({ platform: 'darwin', env: {}, dmi: null });
    expect(result.context).toBe('laptop');
    expect(result.evidence).toContain('assumption');
  });

  it('returns unknown for a bare Linux host with no markers', () => {
    const result = classifyObserverContext({ platform: 'linux', env: {}, dmi: 'LENOVO 20XW' });
    expect(result.context).toBe('unknown');
  });

  it('ignores an empty environment marker', () => {
    const result = classifyObserverContext({ platform: 'darwin', env: { DYNO: '' }, dmi: null });
    expect(result.context).toBe('laptop');
  });
});

describe('detectObserverContext', () => {
  it('classifies the real host without throwing', () => {
    const result = detectObserverContext();
    expect(['laptop', 'server', 'unknown']).toContain(result.context);
    expect(result.evidence.length).toBeGreaterThan(0);
  });
});

import {
  boundedResolve, nodeTriageProbes, parseIpRouteDefault, parseRouteGetDefault, runBounded,
} from '../framework/triage-probes.js';

describe('route table parsing', () => {
  it('parses the Linux `ip route show default` form', () => {
    const stdout = 'default via 192.168.1.1 dev wlan0 proto dhcp metric 600 \n';
    expect(parseIpRouteDefault(stdout)).toBe('192.168.1.1');
  });

  it('returns null when Linux has no default route', () => {
    expect(parseIpRouteDefault('')).toBeNull();
  });

  it('parses the macOS `route -n get default` form', () => {
    const stdout = [
      '   route to: default',
      'destination: default',
      '       mask: default',
      '    gateway: 10.0.0.1',
      '  interface: en0',
    ].join('\n');
    expect(parseRouteGetDefault(stdout)).toBe('10.0.0.1');
  });

  it('returns null when macOS reports no gateway', () => {
    expect(parseRouteGetDefault('   route to: default\n  interface: lo0\n')).toBeNull();
  });
});

describe('nodeTriageProbes', () => {
  const probes = nodeTriageProbes(1_000, ['1.1.1.1', '8.8.8.8']);

  it('lists this machine\'s active interfaces', async () => {
    const result = await probes.listInterfaces();
    expect(Array.isArray(result.activeInterfaces)).toBe(true);
  });

  it('never throws when looking up the default gateway', async () => {
    const result = await probes.findDefaultGateway();
    expect(result.address === null || typeof result.address === 'string').toBe(true);
  });

  it('returns a failed TCP probe as data, not an exception', async () => {
    const result = await probes.connectTcp('127.0.0.1', 1, 'closed-port');
    expect(result.target).toBe('closed-port');
    expect(result.reachable).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('returns a failed fetch as data, not an exception', async () => {
    const result = await probes.fetchUrl('http://127.0.0.1:1/', 'GET');
    expect(result.status).toBeNull();
    expect(result.error).toBeTruthy();
    expect(result.body).toBe('');
  });
});

describe('runBounded', () => {
  it('returns the value when the operation finishes in time', async () => {
    const outcome = await runBounded(async () => 'done', 1_000);
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.value).toBe('done');
  });

  it('returns an error instead of throwing when the operation rejects', async () => {
    const outcome = await runBounded(async () => { throw new Error('boom'); }, 1_000);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toContain('boom');
  });

  it('gives up on a stalled operation and runs the cancel hook', async () => {
    let cancelled = false;
    const outcome = await runBounded(
      () => new Promise<string>(() => {}),
      50,
      () => { cancelled = true; },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toContain('timed out');
    // Without this, a raced-out query keeps the event loop alive after the
    // CLI has already printed its report.
    expect(cancelled).toBe(true);
  });

  it('works without a cancel hook, for APIs that cannot be cancelled', async () => {
    const outcome = await runBounded(() => new Promise<string>(() => {}), 50);
    expect(outcome.ok).toBe(false);
  });
});

describe('boundedResolve', () => {
  // Hermetic test fixture: UDP socket on localhost that receives DNS queries
  // but never responds. This is deterministic on every machine and exercises
  // the real c-ares timeout path without depending on network routing.
  async function createHermeticBlackhole(): Promise<{ servers: string[]; close: () => void }> {
    const socket = createSocket('udp4');
    const port = await new Promise<number>((resolve) => {
      socket.bind(0, '127.0.0.1', () => {
        const addr = socket.address();
        resolve(addr.port);
      });
    });

    // Receive queries but never respond (true blackhole)
    socket.on('message', () => {});

    return {
      servers: [`127.0.0.1:${port}`],
      close: () => socket.close(),
    };
  }

  it('gives up on its own timeout instead of c-ares\' default schedule', async () => {
    const fixture = await createHermeticBlackhole();
    try {
      const started = Date.now();
      const result = await boundedResolve('example.com', fixture.servers, 300);
      const elapsed = Date.now() - started;
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
      expect(elapsed).toBeLessThan(2_000);
    } finally {
      fixture.close();
    }
  });

  it('classifies rather than hanging when every resolver is unreachable', async () => {
    const fixture = await createHermeticBlackhole();
    try {
      const probesWithDeadResolvers = nodeTriageProbes(300, fixture.servers);
      const started = Date.now();
      const result = await probesWithDeadResolvers.resolveDns('example.com');
      const elapsed = Date.now() - started;
      // A definite false is a classification; a hang would be `unknown`.
      expect(result.publicResolved).toBe(false);
      expect(typeof result.systemResolved).toBe('boolean');
      // Concurrent, not sequential: two 300ms lookups must not cost 600ms+.
      // A sequential implementation would take ~600ms and slip past a loose
      // bound, so this must sit below that sum, not just below the deadline.
      expect(elapsed).toBeLessThan(600);
    } finally {
      fixture.close();
    }
  });
});
