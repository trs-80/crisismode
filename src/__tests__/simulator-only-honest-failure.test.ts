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
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ResolvedTarget } from '../config/schema.js';
import { resolveTarget } from '../config/resolve.js';

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

/**
 * A `crisismode.yaml` target may legally omit `primary` (it is optional —
 * config/schema.ts:108). `resolveTarget()` then stamps the internal
 * `{ host: 'aws', port: 0 }` placeholder (config/resolve.ts:21), which is not
 * 'simulator', so these agents still refuse — correctly, since nobody pointed
 * them at anything. But the refusal must not quote the synthesized `aws:0`
 * endpoint back at the operator: it is an internal resolver artifact, it
 * implies AWS is involved when it is not, and it hides the actual problem
 * (the target has no host).
 *
 * These go through the real `resolveTarget()` rather than a hand-built object
 * so the test breaks if the resolver's fallback behaviour ever changes.
 */
describe.each(cases)('$kind registration — target declared without `primary`', (c) => {
  it('still refuses (nothing was configured to observe)', async () => {
    const registration = await c.load();
    const resolved = resolveTarget({ name: `my-${c.kind}`, kind: c.kind });
    await expect(registration.createAgent(resolved)).rejects.toThrow();
  });

  it('never leaks the synthesized aws:0 placeholder into the message', async () => {
    const registration = await c.load();
    const resolved = resolveTarget({ name: `my-${c.kind}`, kind: c.kind });
    const err = await registration
      .createAgent(resolved)
      .then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toContain('aws:0');
    expect(err!.message).not.toContain('aws');
  });

  it('says the target has no primary host, and names the target and kind', async () => {
    const registration = await c.load();
    const resolved = resolveTarget({ name: `my-${c.kind}`, kind: c.kind });
    const err = await registration
      .createAgent(resolved)
      .then(() => null, (e: unknown) => e as Error);
    expect(err!.message).toMatch(/no primary host/i);
    expect(err!.message).toContain(`my-${c.kind}`);
    expect(err!.message).toContain(c.kind);
  });

  it('offers both concrete fixes: a real primary host, or the simulator host', async () => {
    const registration = await c.load();
    const resolved = resolveTarget({ name: `my-${c.kind}`, kind: c.kind });
    const err = await registration
      .createAgent(resolved)
      .then(() => null, (e: unknown) => e as Error);
    expect(err!.message).toContain('primary.host: simulator');
    expect(err!.message).toMatch(/primary/);
  });

  it('is a different message from the real-infrastructure refusal', async () => {
    const registration = await c.load();
    const omitted = await registration
      .createAgent(resolveTarget({ name: `my-${c.kind}`, kind: c.kind }))
      .then(() => null, (e: unknown) => e as Error);
    const realHost = await registration
      .createAgent(target(c.kind, c.realHost, c.realPort))
      .then(() => null, (e: unknown) => e as Error);
    expect(omitted!.message).not.toBe(realHost!.message);
    // The real-host refusal keeps naming the endpoint it was pointed at.
    expect(realHost!.message).toContain(`${c.realHost}:${c.realPort}`);
  });
});

/**
 * Records which layer actually catches an omitted `primary`, so the two
 * messages don't drift into competing with each other. A YAML config never
 * reaches `refuseWithoutHost` — `validateTarget()` rejects it first with its
 * own remediation. `refuseWithoutHost` is the backstop for in-memory
 * SiteConfigs handed straight to AgentRegistry, which skip that validation.
 */
describe('layering: who rejects an omitted `primary`', () => {
  it('the config loader rejects a YAML target with no primary, before any agent runs', async () => {
    const { loadConfig } = await import('../config/loader.js');
    const dir = mkdtempSync(join(tmpdir(), 'crisismode-noprimary-'));
    const configPath = join(dir, 'crisismode.yaml');
    writeFileSync(
      configPath,
      [
        'apiVersion: crisismode/v1',
        'kind: SiteConfig',
        'metadata:',
        '  name: test-site',
        'targets:',
        '  - name: my-kafka',
        '    kind: kafka',
        '',
      ].join('\n'),
      'utf-8',
    );
    try {
      expect(() => loadConfig({ configPath })).toThrow(/must have a primary with host/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an in-memory SiteConfig skips that validation and hits the agent-level refusal', async () => {
    const { AgentRegistry } = await import('../config/agent-registry.js');
    const registry = new AgentRegistry({
      apiVersion: 'crisismode/v1',
      kind: 'SiteConfig',
      metadata: { name: 'prog' },
      targets: [{ name: 'my-kafka', kind: 'kafka' }],
    } as never);
    await expect(registry.createForTarget('my-kafka')).rejects.toThrow(/no primary host/i);
  });
});

/**
 * An explicitly configured `aws` host must NOT be mistaken for the resolver's
 * omitted-primary placeholder. Matching on the string 'aws' would be
 * programming by coincidence; the discriminator has to come from the config.
 */
describe('explicit host vs. omitted primary', () => {
  it('treats an explicitly configured aws host as a real endpoint, not an omission', async () => {
    const { kafkaRecoveryRegistration } = await import('../agent/kafka/registration.js');
    const resolved = resolveTarget({
      name: 'explicit-aws-kafka',
      kind: 'kafka',
      primary: { host: 'aws', port: 0 },
    });
    const err = await kafkaRecoveryRegistration
      .createAgent(resolved)
      .then(() => null, (e: unknown) => e as Error);
    expect(err!.message).toMatch(/no live client/i);
    expect(err!.message).not.toMatch(/no primary host/i);
  });
});
