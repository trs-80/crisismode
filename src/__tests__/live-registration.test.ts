// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, vi } from 'vitest';
import { createLiveRegistration } from '../config/live-registration.js';
import type { ResolvedTarget } from '../config/schema.js';
import type { ExecutionBackend } from '../framework/backend.js';
import { queueBacklogManifest } from '../agent/queue-backlog/manifest.js';

class FakeBackend implements ExecutionBackend {
  label: string;
  constructor(label: string) { this.label = label; }
  async executeCommand(): Promise<unknown> { return null; }
  async evaluateCheck(): Promise<boolean> { return true; }
  async close(): Promise<void> {}
}

class FakeAgent {
  backend: ExecutionBackend;
  manifest = queueBacklogManifest;
  constructor(backend: ExecutionBackend) { this.backend = backend; }
}

function target(host: string): ResolvedTarget {
  return {
    name: 't', kind: 'message-queue',
    primary: { host, port: 6379 },
    replicas: [], credentials: {},
  };
}

function makeRegistration(buildLiveBackend: (t: ResolvedTarget) => Promise<ExecutionBackend>) {
  return createLiveRegistration({
    kind: 'message-queue',
    name: 'queue-backlog-recovery',
    manifest: queueBacklogManifest,
    loadAgent: async () => FakeAgent as never,
    loadSimulator: async () => (class extends FakeBackend {
      constructor() { super('simulator'); }
    }) as never,
    buildLiveBackend,
  });
}

describe('createLiveRegistration', () => {
  it('uses the simulator for explicit simulator targets', async () => {
    const buildLive = vi.fn();
    const reg = makeRegistration(buildLive as never);
    const instance = await reg.createAgent(target('simulator'));
    expect((instance.backend as FakeBackend).label).toBe('simulator');
    expect(buildLive).not.toHaveBeenCalled();
  });

  it('builds the live backend for real hosts', async () => {
    const live = new FakeBackend('live');
    const reg = makeRegistration(async () => live);
    const instance = await reg.createAgent(target('db.example.com'));
    expect(instance.backend).toBe(live);
  });

  it('treats the "auto" sentinel host as live, not simulator', async () => {
    const live = new FakeBackend('live');
    const reg = makeRegistration(async () => live);
    const instance = await reg.createAgent(target('auto'));
    expect(instance.backend).toBe(live);
  });

  it('propagates live connection failures — never silently simulates', async () => {
    const reg = makeRegistration(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    await expect(reg.createAgent(target('db.example.com'))).rejects.toThrow('ECONNREFUSED');
  });
});
