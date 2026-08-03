// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IacDriftLiveClient } from '../agent/iac-drift/live-client.js';
import { isPermissionMissing } from '../agent/aws-common.js';
import { V4_STATE } from './fixtures/iac-tfstate-v4.js';

async function projectWithState(state = V4_STATE): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'iac-live-'));
  await writeFile(join(dir, 'terraform.tfstate'), state);
  return dir;
}

const accessDenied = () => Object.assign(new Error('User is not authorized'), { name: 'AccessDeniedException' });
const notFound = (name: string) => Object.assign(new Error('not found'), { name });

describe('IacDriftLiveClient state acquisition', () => {
  it('reads local state and reports staleness from mtime', async () => {
    const dir = await projectWithState();
    const old = new Date(Date.now() - 60 * 86400_000);
    await utimes(join(dir, 'terraform.tfstate'), old, old);
    const client = new IacDriftLiveClient({ dir });
    const status = await client.getStateStatus();
    expect(status).toMatchObject({ source: 'local', readable: true, serial: 42 });
    expect(status.staleDays).toBeGreaterThanOrEqual(59);
    expect((await client.listManagedResources()).length).toBeGreaterThan(0);
    await client.close();
  });

  it('reports unreadable state with the parse reason', async () => {
    const dir = await projectWithState('{corrupt');
    const client = new IacDriftLiveClient({ dir });
    const status = await client.getStateStatus();
    expect(status.readable).toBe(false);
    expect(status.reason).toContain('JSON');
    expect(await client.listManagedResources()).toEqual([]);
    await client.close();
  });
});

describe('IacDriftLiveClient existence + drift', () => {
  it('maps NotFound to missing and AccessDenied to PermissionMissing per service', async () => {
    const dir = await projectWithState();
    const client = new IacDriftLiveClient({
      dir,
      clients: {
        rds: { send: async () => { throw accessDenied(); } },
        s3: { send: async () => { throw notFound('NotFound'); } },
      },
    });
    const resources = await client.listManagedResources();
    const db = resources.find((r) => r.type === 'aws_db_instance')!;
    const bucket = resources.find((r) => r.type === 'aws_s3_bucket')!;
    const cache = resources.find((r) => r.type === 'aws_elasticache_cluster')!;

    const dbResult = await client.checkResourceExistence(db);
    expect(isPermissionMissing(dbResult) && dbResult.permissionMissing).toBe('rds:DescribeDBInstances');
    expect(await client.checkResourceExistence(bucket)).toEqual({ existence: 'missing' });
    expect(await client.checkResourceExistence(cache)).toMatchObject({ existence: 'unknown' });
    await client.close();
  });

  it('computes attribute drift from a DescribeDBInstances response', async () => {
    const dir = await projectWithState();
    const client = new IacDriftLiveClient({
      dir,
      clients: {
        rds: { send: async () => ({ DBInstances: [{
          DBInstanceIdentifier: 'prod-db', DBInstanceClass: 'db.t3.large', Engine: 'postgres',
          EngineVersion: '16.4', MultiAZ: false, BackupRetentionPeriod: 7,
          DeletionProtection: true, StorageType: 'gp3', AllocatedStorage: 20,
        }] }) },
      },
    });
    const db = (await client.listManagedResources()).find((r) => r.type === 'aws_db_instance')!;
    const drift = await client.getResourceDrift(db);
    expect(drift).toMatchObject({
      drifts: [{ attribute: 'instance_class', intended: 'db.t3.medium', observed: 'db.t3.large' }],
    });
    await client.close();
  });

  it('returns null drift for types outside the deep trio', async () => {
    const dir = await projectWithState();
    const client = new IacDriftLiveClient({ dir });
    const cache = (await client.listManagedResources()).find((r) => r.type === 'aws_elasticache_cluster')!;
    expect(await client.getResourceDrift(cache)).toBeNull();
    await client.close();
  });
});
