// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * S3RecoveryLiveClient — connects to real AWS S3 and implements S3RecoveryBackend.
 *
 * Queries bucket versioning and lifecycle configuration against actual S3 buckets.
 * Used when running the spoke against real infrastructure.
 */

import type { S3RecoveryBackend, BucketConfig, LifecycleRule } from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';
import { tryImportAws } from '../aws-common.js';
import { compareCheckValue } from '../../framework/check-helpers.js';

type S3Module = typeof import('@aws-sdk/client-s3');

export interface S3ConnectionConfig {
  region: string;
  bucket: string;
  profile?: string;
}

export class S3RecoveryLiveClient implements S3RecoveryBackend {
  private config: S3ConnectionConfig;
  private s3Module: S3Module | null = null;
  private client: InstanceType<S3Module['S3Client']> | null = null;

  constructor(config: S3ConnectionConfig) {
    this.config = config;
  }

  private async getS3Module(): Promise<S3Module> {
    if (!this.s3Module) {
      const mod = await tryImportAws<S3Module>('@aws-sdk/client-s3');
      if (!mod) throw new Error('@aws-sdk/client-s3 is not installed');
      this.s3Module = mod;
    }
    return this.s3Module;
  }

  /**
   * Lazily construct and reuse a single S3Client. Each client owns an HTTP
   * connection pool, so creating one per call would leak sockets across
   * getBucketConfig/executeCommand/evaluateCheck. Disposed in close().
   */
  private async getClient(): Promise<InstanceType<S3Module['S3Client']>> {
    if (!this.client) {
      const s3 = await this.getS3Module();
      this.client = new s3.S3Client({
        region: this.config.region,
        ...(this.config.profile ? { profile: this.config.profile } : {}),
      });
    }
    return this.client;
  }

  async getBucketConfig(): Promise<BucketConfig> {
    const s3 = await this.getS3Module();
    const client = await this.getClient();

    // Get versioning status
    const versioningResp = await client.send(
      new s3.GetBucketVersioningCommand({ Bucket: this.config.bucket }),
    );
    const versioningStatus = versioningResp.Status === 'Enabled'
      ? 'Enabled'
      : versioningResp.Status === 'Suspended'
        ? 'Suspended'
        : 'Disabled';

    // Get lifecycle rules
    let lifecycleRules: LifecycleRule[] = [];
    try {
      const lifecycleResp = await client.send(
        new s3.GetBucketLifecycleConfigurationCommand({ Bucket: this.config.bucket }),
      );
      lifecycleRules = (lifecycleResp.Rules ?? []).map((rule) => ({
        id: rule.ID ?? 'unknown',
        status: rule.Status === 'Enabled' ? 'Enabled' as const : 'Disabled' as const,
        prefix: rule.Filter && 'Prefix' in rule.Filter ? (rule.Filter.Prefix ?? '') : '',
        transitions: (rule.Transitions ?? []).map((t) => ({
          days: t.Days ?? 0,
          storageClass: t.StorageClass ?? 'STANDARD',
        })),
        expiration: rule.Expiration?.Days ? { days: rule.Expiration.Days } : undefined,
      }));
    } catch {
      // NoSuchLifecycleConfiguration is expected when no lifecycle rules exist
      lifecycleRules = [];
    }

    return {
      bucket: this.config.bucket,
      region: this.config.region,
      versioningStatus,
      lifecycleRules,
    };
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'structured_command') {
      throw new Error(`Unsupported command type: ${command.type}`);
    }

    const s3 = await this.getS3Module();
    const client = await this.getClient();

    switch (command.operation) {
      case 'get_bucket_config': {
        return { config: await this.getBucketConfig() };
      }
      case 'put_bucket_versioning': {
        await client.send(
          new s3.PutBucketVersioningCommand({
            Bucket: this.config.bucket,
            VersioningConfiguration: { Status: 'Enabled' },
          }),
        );
        return { versioningEnabled: true };
      }
      case 'put_bucket_lifecycle': {
        const rules = command.parameters?.rules as Array<{
          id: string;
          prefix: string;
          transitions: Array<{ days: number; storageClass: string }>;
          expiration?: { days: number };
        }> | undefined;

        if (!rules || rules.length === 0) {
          // S3 rejects PutBucketLifecycleConfiguration with an empty Rules set
          // (clearing requires DeleteBucketLifecycle). A recovery plan should
          // always supply at least one rule — fail with a clear message rather
          // than an opaque MalformedXML error from the SDK.
          throw new Error('put_bucket_lifecycle requires at least one lifecycle rule');
        }

        const s3Rules = rules.map((rule) => ({
          ID: rule.id,
          Status: 'Enabled' as const,
          Filter: { Prefix: rule.prefix },
          Transitions: rule.transitions.map((t) => ({
            Days: t.days,
            StorageClass: t.storageClass as 'STANDARD_IA' | 'GLACIER' | 'DEEP_ARCHIVE',
          })),
          ...(rule.expiration ? { Expiration: { Days: rule.expiration.days } } : {}),
        }));

        await client.send(
          new s3.PutBucketLifecycleConfigurationCommand({
            Bucket: this.config.bucket,
            LifecycleConfiguration: { Rules: s3Rules as never },
          }),
        );
        return { lifecycleConfigured: true };
      }
      default:
        throw new Error(`Unknown S3 operation: ${command.operation}`);
    }
  }

  async evaluateCheck(check: CheckExpression): Promise<boolean> {
    const stmt = check.statement ?? '';

    if (stmt.includes('versioning_status')) {
      const config = await this.getBucketConfig();
      return compareCheckValue(config.versioningStatus, check.expect.operator, check.expect.value);
    }

    if (stmt.includes('lifecycle_rule_count')) {
      const config = await this.getBucketConfig();
      return compareCheckValue(config.lifecycleRules.length, check.expect.operator, check.expect.value);
    }

    if (stmt.includes('bucket_exists')) {
      const s3 = await this.getS3Module();
      const client = await this.getClient();
      try {
        await client.send(new s3.HeadBucketCommand({ Bucket: this.config.bucket }));
        return compareCheckValue('true', check.expect.operator, check.expect.value);
      } catch (err) {
        // Only a confirmed 404 means the bucket is missing. Auth failures,
        // throttling, and timeouts must surface as probe errors, not as a
        // false "bucket does not exist" finding.
        const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        const name = err instanceof Error ? err.name : '';
        if (status === 404 || name === 'NotFound' || name === 'NoSuchBucket') {
          return compareCheckValue('false', check.expect.operator, check.expect.value);
        }
        throw err;
      }
    }

    return true;
  }

  listCapabilityProviders(): CapabilityProviderDescriptor[] {
    return [
      {
        id: 's3-live-admin',
        kind: 'capability_provider',
        name: 'S3 Live Admin Provider',
        maturity: 'live_validated',
        capabilities: ['s3.versioning.read', 's3.versioning.write', 's3.lifecycle.read', 's3.lifecycle.write'],
        executionContexts: ['s3_read', 's3_write'],
        targetKinds: ['aws-s3'],
        commandTypes: ['structured_command'],
        supportsDryRun: true,
        supportsExecute: true,
      },
    ];
  }

  async close(): Promise<void> {
    this.client?.destroy();
    this.client = null;
  }

}
