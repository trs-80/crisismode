// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Fix-round coverage for IacDriftLiveClient: S3-backend state acquisition,
 * per-region client caching, and existence/drift branches the original
 * brief-mandated test file didn't exercise (DynamoDB, S3 AccessDenied
 * existence, the NoSuchLifecycleConfiguration non-error path).
 *
 * The S3-backend and region-caching tests mock the AWS SDK constructors
 * directly (same pattern as src/__tests__/aws-rds-live-client.test.ts) so we
 * can assert on *which* client/region was constructed without any real AWS
 * calls. Everything else uses the existing `clients` injection seam.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockStsSend = vi.fn();
const mockS3Send = vi.fn();
const mockRdsConstructedRegions: string[] = [];

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class { send = mockStsSend; },
  GetCallerIdentityCommand: class { constructor(public params?: unknown) {} },
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class { send = mockS3Send; },
  GetObjectCommand: class { constructor(public params?: unknown) {} },
  HeadBucketCommand: class { constructor(public params?: unknown) {} },
  GetBucketVersioningCommand: class { constructor(public params?: unknown) {} },
  GetBucketLifecycleConfigurationCommand: class { constructor(public params?: unknown) {} },
}));

vi.mock('@aws-sdk/client-rds', () => ({
  RDSClient: class {
    constructor(config: { region: string }) {
      mockRdsConstructedRegions.push(config.region);
    }
    send = vi.fn(async () => ({ DBInstances: [] }));
  },
  DescribeDBInstancesCommand: class { constructor(public params?: unknown) {} },
}));

import { IacDriftLiveClient } from '../agent/iac-drift/live-client.js';
import { isPermissionMissing } from '../agent/aws-common.js';
import type { IacResource } from '../agent/iac-drift/state-parser.js';
import { V4_STATE } from './fixtures/iac-tfstate-v4.js';

async function projectWithS3Backend(bucket: string, key: string, region: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'iac-live-s3-'));
  await mkdir(join(dir, '.terraform'));
  await writeFile(
    join(dir, '.terraform', 'terraform.tfstate'),
    JSON.stringify({ backend: { type: 's3', config: { bucket, key, region } } }),
  );
  return dir;
}

function makeResource(overrides: Partial<IacResource>): IacResource {
  return { type: 'aws_db_instance', name: 'r', id: 'r', attributes: {}, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRdsConstructedRegions.length = 0;
});

describe('IacDriftLiveClient S3-backend state loading', () => {
  it('reports unreadable with the credential reason when the STS pre-flight fails', async () => {
    mockStsSend.mockRejectedValue(new Error('ExpiredToken: the security token included in the request is expired'));
    const dir = await projectWithS3Backend('my-tf-state', 'prod/terraform.tfstate', 'us-west-2');
    const client = new IacDriftLiveClient({ dir });
    const status = await client.getStateStatus();
    expect(status).toMatchObject({ source: 's3-backend', readable: false });
    expect(status.reason).toContain('ExpiredToken');
    await client.close();
  });

  it('reads state from S3 and reports staleness from LastModified', async () => {
    mockStsSend.mockResolvedValue({ Account: '' });
    mockS3Send.mockResolvedValue({
      Body: { transformToString: async () => V4_STATE },
      LastModified: new Date(Date.now() - 5 * 86400_000),
    });
    const dir = await projectWithS3Backend('my-tf-state', 'prod/terraform.tfstate', 'us-west-2');
    const client = new IacDriftLiveClient({ dir });
    const status = await client.getStateStatus();
    expect(status).toMatchObject({ source: 's3-backend', readable: true, serial: 42 });
    expect(status.staleDays).toBeGreaterThanOrEqual(4);
    expect((await client.listManagedResources()).length).toBeGreaterThan(0);
    await client.close();
  });

  it('reports unreadable naming s3:GetObject when GetObject is access-denied', async () => {
    mockStsSend.mockResolvedValue({ Account: '' });
    mockS3Send.mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    const dir = await projectWithS3Backend('my-tf-state', 'prod/terraform.tfstate', 'us-west-2');
    const client = new IacDriftLiveClient({ dir });
    const status = await client.getStateStatus();
    expect(status.readable).toBe(false);
    expect(status.reason).toContain('s3:GetObject');
    await client.close();
  });
});

describe('IacDriftLiveClient region-scoped client caching', () => {
  it('constructs a client per resource region and reuses it only within that region', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iac-live-region-'));
    const client = new IacDriftLiveClient({ dir });
    const dbUsEast = makeResource({ id: 'db-a', region: 'us-east-1' });
    const dbEuWest = makeResource({ id: 'db-b', region: 'eu-west-1' });

    await client.checkResourceExistence(dbUsEast);
    await client.checkResourceExistence(dbUsEast); // same region — cache hit, no new client
    await client.checkResourceExistence(dbEuWest); // different region — must not reuse the us-east-1 client

    expect(mockRdsConstructedRegions).toEqual(['us-east-1', 'eu-west-1']);
    await client.close();
  });
});

describe('IacDriftLiveClient existence + drift branches not covered by the brief test', () => {
  it('maps S3 AccessDenied on HeadBucket to PermissionMissing(s3:ListBucket)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iac-live-'));
    const client = new IacDriftLiveClient({
      dir,
      clients: { s3: { send: async () => { throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' }); } } },
    });
    const bucket = makeResource({ type: 'aws_s3_bucket', id: 'user-uploads' });
    const result = await client.checkResourceExistence(bucket);
    expect(isPermissionMissing(result) && result.permissionMissing).toBe('s3:ListBucket');
    await client.close();
  });

  it('treats NoSuchLifecycleConfiguration as "no lifecycle rules" rather than an error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iac-live-'));
    // Versioning succeeds; only the lifecycle call 404s with the AWS "no
    // configuration at all" error, which must be read as hasLifecycleRules:
    // false rather than an unexpected failure that degrades drift to null.
    const client = new IacDriftLiveClient({
      dir,
      clients: {
        s3: {
          send: async (cmd: unknown) => {
            const commandName = (cmd as { commandName?: string }).commandName;
            if (commandName === 'GetBucketVersioningCommand') return { Status: 'Enabled' };
            throw Object.assign(new Error('no lifecycle configuration'), { name: 'NoSuchLifecycleConfiguration' });
          },
        },
      },
    });
    const bucket = makeResource({
      type: 'aws_s3_bucket',
      id: 'user-uploads',
      attributes: { versioning: [{ enabled: true }], lifecycle_rule: [{ enabled: true }] },
    });
    const drift = await client.getResourceDrift(bucket);
    // versioning matches (Enabled/Enabled, no drift); lifecycle_rule intent is
    // present in state but observed hasLifecycleRules is false -> one drift.
    expect(drift).toMatchObject({ drifts: [{ attribute: 'lifecycle_rule', intended: 'true', observed: 'false' }] });
    await client.close();
  });

  it('checks DynamoDB existence and PITR drift', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iac-live-'));
    const client = new IacDriftLiveClient({
      dir,
      clients: {
        dynamo: {
          send: async () => ({
            Table: { BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' } },
            ContinuousBackupsDescription: {
              PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: 'ENABLED' },
            },
          }),
        },
      },
    });
    const table = makeResource({
      type: 'aws_dynamodb_table',
      id: 'sessions',
      attributes: { billing_mode: 'PAY_PER_REQUEST', point_in_time_recovery: [{ enabled: true }] },
    });
    expect(await client.checkResourceExistence(table)).toEqual({ existence: 'exists' });
    const drift = await client.getResourceDrift(table);
    expect(drift).toMatchObject({ drifts: [] });
    await client.close();
  });
});
