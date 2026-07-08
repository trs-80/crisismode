// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { resolveTarget } from '../config/resolve.js';

describe('resolveTarget kind-specific options', () => {
  it('passes queue options through to the resolved target', () => {
    const resolved = resolveTarget({
      name: 'q',
      kind: 'message-queue',
      primary: { host: 'localhost', port: 6379 },
      queue: { queueNames: ['emails'], keyPrefix: 'bull', tls: true },
    });
    expect(resolved.queue).toEqual({ queueNames: ['emails'], keyPrefix: 'bull', tls: true });
  });

  it('passes configDrift options through to the resolved target', () => {
    const resolved = resolveTarget({
      name: 'cfg',
      kind: 'application-config',
      primary: { host: 'auto', port: 0 },
      configDrift: {
        envExamplePath: '.env.example',
        expectations: [{ path: 'NODE_ENV', expected: 'production', source: 'env' }],
      },
    });
    expect(resolved.configDrift?.envExamplePath).toBe('.env.example');
    expect(resolved.configDrift?.expectations).toHaveLength(1);
  });

  it('leaves options undefined when absent', () => {
    const resolved = resolveTarget({
      name: 'pg',
      kind: 'postgresql',
      primary: { host: 'localhost', port: 5432 },
    });
    expect(resolved.queue).toBeUndefined();
    expect(resolved.configDrift).toBeUndefined();
  });
});
