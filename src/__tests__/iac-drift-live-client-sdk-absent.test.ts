// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Regression coverage for the SDK-not-installed drift path: getRdsDrift /
 * getS3Drift / getDynamoDrift used to return PermissionMissing when the AWS
 * SDK package for that service wasn't installed, which downstream renders as
 * "IAM action ... not allowed" with a grant-IAM-permission hint — wrong
 * advice for what is really an npm-install problem. They now match the
 * existence methods' modeling (checkRdsExistence et al.) and degrade to null
 * (drift unknown) instead. The SDK packages ARE installed in this repo (they
 * are optionalDependencies), so "not installed" is simulated by mocking the
 * import to reject, exactly what tryImportAws sees when the package is
 * genuinely missing.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@aws-sdk/client-rds', () => {
  throw new Error("Cannot find package '@aws-sdk/client-rds'");
});
vi.mock('@aws-sdk/client-s3', () => {
  throw new Error("Cannot find package '@aws-sdk/client-s3'");
});
vi.mock('@aws-sdk/client-dynamodb', () => {
  throw new Error("Cannot find package '@aws-sdk/client-dynamodb'");
});

import { IacDriftLiveClient } from '../agent/iac-drift/live-client.js';
import type { IacResource } from '../agent/iac-drift/state-parser.js';

function makeResource(overrides: Partial<IacResource>): IacResource {
  return { type: 'aws_db_instance', name: 'r', id: 'r', attributes: {}, ...overrides };
}

describe('IacDriftLiveClient drift with the AWS SDK not installed', () => {
  it('getResourceDrift(aws_db_instance) returns null, not PermissionMissing, when @aws-sdk/client-rds is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iac-live-sdk-'));
    const client = new IacDriftLiveClient({ dir });
    const db = makeResource({ type: 'aws_db_instance', id: 'prod-db' });
    expect(await client.getResourceDrift(db)).toBeNull();
    await client.close();
  });

  it('getResourceDrift(aws_s3_bucket) returns null, not PermissionMissing, when @aws-sdk/client-s3 is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iac-live-sdk-'));
    const client = new IacDriftLiveClient({ dir });
    const bucket = makeResource({ type: 'aws_s3_bucket', id: 'user-uploads' });
    expect(await client.getResourceDrift(bucket)).toBeNull();
    await client.close();
  });

  it('getResourceDrift(aws_dynamodb_table) returns null, not PermissionMissing, when @aws-sdk/client-dynamodb is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iac-live-sdk-'));
    const client = new IacDriftLiveClient({ dir });
    const table = makeResource({ type: 'aws_dynamodb_table', id: 'sessions' });
    expect(await client.getResourceDrift(table)).toBeNull();
    await client.close();
  });
});
