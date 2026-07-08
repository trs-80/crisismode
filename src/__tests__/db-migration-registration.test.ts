// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { dbMigrationRegistration } from '../agent/db-migration/registration.js';

describe('dbMigrationRegistration', () => {
  it('uses the simulator for explicit simulator targets', async () => {
    const instance = await dbMigrationRegistration.createAgent({
      name: 'sim', kind: 'managed-database',
      primary: { host: 'simulator', port: 0 },
      replicas: [], credentials: {},
    });
    expect(instance.backend.constructor.name).toBe('DbMigrationSimulator');
    await instance.backend.close();
  });

  it('rejects (never simulates) when the live database is unreachable', async () => {
    await expect(
      dbMigrationRegistration.createAgent({
        name: 'db', kind: 'managed-database',
        primary: { host: '127.0.0.1', port: 1, database: 'appdb' },
        replicas: [], credentials: { username: 'u', password: 'p' },
      }),
    ).rejects.toThrow();
  }, 15_000);
});
