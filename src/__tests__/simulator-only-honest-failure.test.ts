// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Credibility policy tests for the simulator-only registrations (ceph, etcd,
 * flink, kafka — the four agents with no live-client.ts).
 *
 * Same standard live-registration.ts states and enforces: explicit simulator
 * targets (host === 'simulator', or no primary) get the simulator; every
 * other target is REFUSED. We never silently substitute simulated data for
 * real systems — a simulator-only agent handed a production host must throw,
 * so scan reports an honest `unknown` finding instead of a fabricated one.
 */

import { describe, it, expect } from 'vitest';
import type { ResolvedTarget } from '../config/schema.js';

function target(kind: string, host: string, port = 0): ResolvedTarget {
  return {
    name: `test-${kind}`,
    kind,
    primary: { host, port },
    replicas: [],
    credentials: {},
  } as unknown as ResolvedTarget;
}

function targetWithoutPrimary(kind: string): ResolvedTarget {
  return {
    name: `test-${kind}`,
    kind,
    replicas: [],
    credentials: {},
  } as unknown as ResolvedTarget;
}

const cases = [
  {
    kind: 'kafka',
    simulatorClass: 'KafkaSimulator',
    realHost: 'kafka-1.prod.internal',
    realPort: 9092,
    load: async () => (await import('../agent/kafka/registration.js')).kafkaRecoveryRegistration,
  },
  {
    kind: 'etcd',
    simulatorClass: 'EtcdSimulator',
    realHost: 'etcd-1.prod.internal',
    realPort: 2379,
    load: async () => (await import('../agent/etcd/registration.js')).etcdRecoveryRegistration,
  },
  {
    kind: 'ceph',
    simulatorClass: 'CephSimulator',
    realHost: 'ceph-mon-1.prod.internal',
    realPort: 6789,
    load: async () => (await import('../agent/ceph/registration.js')).cephStorageRegistration,
  },
  {
    kind: 'flink',
    simulatorClass: 'FlinkSimulator',
    realHost: 'flink-jm.prod.internal',
    realPort: 8081,
    load: async () => (await import('../agent/flink/registration.js')).flinkRecoveryRegistration,
  },
] as const;

describe.each(cases)('$kind registration (simulator-only)', (c) => {
  it('uses the simulator for explicit simulator targets', async () => {
    const registration = await c.load();
    const instance = await registration.createAgent(target(c.kind, 'simulator', c.realPort));
    expect(instance.backend.constructor.name).toBe(c.simulatorClass);
    await instance.backend.close();
  });

  it('uses the simulator when the target declares no primary host', async () => {
    const registration = await c.load();
    const instance = await registration.createAgent(targetWithoutPrimary(c.kind));
    expect(instance.backend.constructor.name).toBe(c.simulatorClass);
    await instance.backend.close();
  });

  it('refuses a real host instead of serving fabricated simulator data', async () => {
    const registration = await c.load();
    await expect(
      registration.createAgent(target(c.kind, c.realHost, c.realPort)),
    ).rejects.toThrow(/no live client/i);
  });

  it('names the kind, the host, and the simulator escape hatch in the refusal', async () => {
    const registration = await c.load();
    const err = await registration
      .createAgent(target(c.kind, c.realHost, c.realPort))
      .then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain(c.kind);
    expect(err!.message).toContain(c.realHost);
    expect(err!.message).toContain('simulator');
  });
});
