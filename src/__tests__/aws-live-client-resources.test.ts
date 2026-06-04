// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Shared counters the hoisted SDK mocks write to.
const h = vi.hoisted(() => ({ dynamoClients: 0, dynamoDestroys: 0, s3Sends: 0 }));

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient {
    constructor() {
      h.dynamoClients++;
    }
    async send() {
      return {
        ContinuousBackupsDescription: {
          PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: 'ENABLED' },
        },
      };
    }
    destroy() {
      h.dynamoDestroys++;
    }
  }
  class DescribeContinuousBackupsCommand {
    constructor(public input: unknown) {}
  }
  class UpdateContinuousBackupsCommand {
    constructor(public input: unknown) {}
  }
  return { DynamoDBClient, DescribeContinuousBackupsCommand, UpdateContinuousBackupsCommand };
});

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    async send() {
      h.s3Sends++;
      return {};
    }
    destroy() {}
  }
  const cmd = (name: string) =>
    class {
      static cmdName = name;
      constructor(public input: unknown) {}
    };
  return {
    S3Client,
    GetBucketVersioningCommand: cmd('GetBucketVersioning'),
    GetBucketLifecycleConfigurationCommand: cmd('GetBucketLifecycle'),
    PutBucketVersioningCommand: cmd('PutBucketVersioning'),
    PutBucketLifecycleConfigurationCommand: cmd('PutBucketLifecycle'),
  };
});

beforeEach(() => {
  h.dynamoClients = 0;
  h.dynamoDestroys = 0;
  h.s3Sends = 0;
});

describe('DynamoDbRecoveryLiveClient — client reuse', () => {
  it('reuses a single DynamoDB client across calls and destroys it on close()', async () => {
    const { DynamoDbRecoveryLiveClient } = await import('../agent/aws-dynamodb/live-client.js');
    const client = new DynamoDbRecoveryLiveClient({ region: 'us-east-1', table: 't' });

    await client.getTableBackupConfig();
    await client.getTableBackupConfig();
    await client.executeCommand({
      type: 'structured_command',
      operation: 'update_continuous_backups',
      parameters: {},
    });

    // One pooled client for all three operations — no per-call socket churn.
    expect(h.dynamoClients).toBe(1);
    expect(h.dynamoDestroys).toBe(0);

    await client.close();
    expect(h.dynamoDestroys).toBe(1);

    // close() is idempotent and safe to call with no live client.
    await client.close();
    expect(h.dynamoDestroys).toBe(1);
  });
});

describe('S3RecoveryLiveClient — lifecycle guard', () => {
  it('rejects put_bucket_lifecycle with no rules instead of sending an empty Rules set', async () => {
    const { S3RecoveryLiveClient } = await import('../agent/aws-s3/live-client.js');
    const client = new S3RecoveryLiveClient({ region: 'us-east-1', bucket: 'b' });

    await expect(
      client.executeCommand({
        type: 'structured_command',
        operation: 'put_bucket_lifecycle',
        parameters: { rules: [] },
      }),
    ).rejects.toThrow(/at least one lifecycle rule/);

    await expect(
      client.executeCommand({
        type: 'structured_command',
        operation: 'put_bucket_lifecycle',
        parameters: {},
      }),
    ).rejects.toThrow(/at least one lifecycle rule/);

    // The guard short-circuits before any S3 call is made.
    expect(h.s3Sends).toBe(0);
  });

  it('sends the configuration when at least one rule is present', async () => {
    const { S3RecoveryLiveClient } = await import('../agent/aws-s3/live-client.js');
    const client = new S3RecoveryLiveClient({ region: 'us-east-1', bucket: 'b' });

    const result = await client.executeCommand({
      type: 'structured_command',
      operation: 'put_bucket_lifecycle',
      parameters: {
        rules: [{ id: 'r1', prefix: 'backups/', transitions: [{ days: 30, storageClass: 'GLACIER' }] }],
      },
    });

    expect(result).toEqual({ lifecycleConfigured: true });
    expect(h.s3Sends).toBe(1);
  });
});
