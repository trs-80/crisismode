// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * IacDriftLiveClient — connects to a real Terraform project (local state file
 * or S3 backend) and, for the deep-comparator trio (RDS/S3/DynamoDB), to real
 * AWS to check existence and attribute drift.
 *
 * Strictly read-only: never writes/locks Terraform state, never runs the
 * terraform binary, and only issues Describe, Get, and Head AWS calls. Every
 * failure degrades to an honest typed result — unreadable state with a
 * reason, PermissionMissing naming the exact IAM action, or existence
 * 'unknown' with a reason — never a throw from a public method, never a guess.
 */

import { readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tryImportAws, resolveAwsCredentials, isPermissionMissing } from '../aws-common.js';
import type { PermissionMissing } from '../aws-common.js';
import { isAccessDeniedError } from '../aws-rds/control-plane-helpers.js';
import { discoverStateSource, parseTfState, type IacResource } from './state-parser.js';
import {
  compareRdsInstance,
  compareS3Bucket,
  compareDynamoTable,
  type DriftComparison,
} from './drift-compare.js';
import type {
  IacDriftBackend,
  IacStateStatus,
  ResourceExistence,
} from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import { compareCheckValue } from '../../framework/check-helpers.js';
import type * as S3SdkModule from '@aws-sdk/client-s3';
import type * as RdsSdkModule from '@aws-sdk/client-rds';
import type * as DynamoSdkModule from '@aws-sdk/client-dynamodb';

const execFileAsync = promisify(execFile);

/** Minimal client seam — the injected test fakes and the real SDK clients
 *  both satisfy this shape. */
interface SendableClient {
  send(cmd: unknown): Promise<unknown>;
}

export interface IacDriftLiveConfig {
  dir: string;
  /** Test seam: pre-built SDK clients; production leaves this undefined. */
  clients?: {
    s3?: SendableClient;
    rds?: SendableClient;
    dynamo?: SendableClient;
  };
}

interface LoadedState {
  status: IacStateStatus;
  resources: IacResource[];
}

export class IacDriftLiveClient implements IacDriftBackend {
  private readonly cfg: IacDriftLiveConfig;
  private loaded?: Promise<LoadedState>;
  /** Region of the discovered S3 state backend, if any — used as a region
   *  fallback for resources whose ARN carried no region. */
  private stateBackendRegion?: string;

  private rdsClient: SendableClient | null = null;
  private rdsSdk: typeof RdsSdkModule | null = null;
  private s3Client: SendableClient | null = null;
  private s3Sdk: typeof S3SdkModule | null = null;
  private dynamoClient: SendableClient | null = null;
  private dynamoSdk: typeof DynamoSdkModule | null = null;

  constructor(config: IacDriftLiveConfig) {
    this.cfg = config;
  }

  // ── State loading ──

  private load(): Promise<LoadedState> {
    if (!this.loaded) this.loaded = this.loadState();
    return this.loaded;
  }

  private async detectDirtyTfFiles(): Promise<boolean | undefined> {
    try {
      const { stdout } = await execFileAsync('git', ['status', '--porcelain', '--', '*.tf'], { cwd: this.cfg.dir });
      return stdout.trim().length > 0;
    } catch {
      return undefined;
    }
  }

  private async loadState(): Promise<LoadedState> {
    const dirtyTfFiles = await this.detectDirtyTfFiles();
    const source = await discoverStateSource(this.cfg.dir);

    if (source.kind === 'unsupported-backend') {
      return {
        status: {
          source: 'unsupported-backend',
          detail: source.backendType,
          readable: false,
          reason: `unsupported Terraform backend: ${source.backendType}`,
          dirtyTfFiles,
        },
        resources: [],
      };
    }

    if (source.kind === 'none') {
      return {
        status: {
          source: 'none',
          detail: 'no Terraform state found',
          readable: false,
          reason: 'no Terraform state found',
          dirtyTfFiles,
        },
        resources: [],
      };
    }

    if (source.kind === 'local') {
      let raw: string;
      let mtime: Date;
      try {
        raw = await readFile(source.path, 'utf-8');
        mtime = (await stat(source.path)).mtime;
      } catch (err) {
        return {
          status: {
            source: 'local',
            detail: source.path,
            readable: false,
            reason: err instanceof Error ? err.message : String(err),
            dirtyTfFiles,
          },
          resources: [],
        };
      }
      return this.finishFromRaw(raw, {
        source: 'local',
        detail: source.path,
        lastModifiedAt: mtime.toISOString(),
        staleDays: Math.floor((Date.now() - mtime.getTime()) / 86400_000),
        dirtyTfFiles,
      });
    }

    // s3-backend
    this.stateBackendRegion = source.region;
    const detail = `s3://${source.bucket}/${source.key}`;
    const credentials = await resolveAwsCredentials({ region: source.region });
    if (!credentials.valid) {
      return {
        status: {
          source: 's3-backend',
          detail,
          readable: false,
          reason: credentials.reason ?? 'AWS credentials invalid',
          dirtyTfFiles,
        },
        resources: [],
      };
    }

    const sdk = await tryImportAws<typeof S3SdkModule>('@aws-sdk/client-s3');
    if (!sdk) {
      return {
        status: {
          source: 's3-backend',
          detail,
          readable: false,
          reason: '@aws-sdk/client-s3 is not installed',
          dirtyTfFiles,
        },
        resources: [],
      };
    }

    try {
      const client = new sdk.S3Client({ region: source.region });
      const resp = await client.send(new sdk.GetObjectCommand({ Bucket: source.bucket, Key: source.key }));
      const raw = await (resp.Body as { transformToString(): Promise<string> }).transformToString();
      const lastModifiedAt = resp.LastModified ? new Date(resp.LastModified).toISOString() : undefined;
      const staleDays = resp.LastModified
        ? Math.floor((Date.now() - new Date(resp.LastModified).getTime()) / 86400_000)
        : undefined;
      return this.finishFromRaw(raw, {
        source: 's3-backend',
        detail,
        lastModifiedAt,
        staleDays,
        dirtyTfFiles,
      });
    } catch (err) {
      const reason = isAccessDeniedError(err)
        ? `missing s3:GetObject permission on the state bucket (${source.bucket})`
        : err instanceof Error ? err.message : String(err);
      return {
        status: {
          source: 's3-backend',
          detail,
          readable: false,
          reason,
          dirtyTfFiles,
        },
        resources: [],
      };
    }
  }

  private finishFromRaw(
    raw: string,
    partial: Pick<IacStateStatus, 'source' | 'detail' | 'lastModifiedAt' | 'staleDays' | 'dirtyTfFiles'>,
  ): LoadedState {
    const parsed = parseTfState(raw);
    if (!parsed.ok) {
      return {
        status: { ...partial, readable: false, reason: parsed.reason },
        resources: [],
      };
    }
    return {
      status: {
        ...partial,
        readable: true,
        serial: parsed.summary.serial,
        resourceCounts: parsed.summary.resourceCounts,
      },
      resources: parsed.resources,
    };
  }

  async getStateStatus(): Promise<IacStateStatus> {
    return (await this.load()).status;
  }

  async listManagedResources(): Promise<IacResource[]> {
    return (await this.load()).resources;
  }

  // ── AWS clients ──

  private async resolveRegion(resource: IacResource): Promise<string> {
    if (resource.region) return resource.region;
    await this.load(); // ensures stateBackendRegion is populated when discoverable
    return this.stateBackendRegion || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
  }

  private async ensureRds(region: string): Promise<SendableClient | null> {
    if (this.cfg.clients?.rds) return this.cfg.clients.rds;
    if (this.rdsClient) return this.rdsClient;
    const sdk = await tryImportAws<typeof RdsSdkModule>('@aws-sdk/client-rds');
    if (!sdk) return null;
    this.rdsSdk = sdk;
    this.rdsClient = new sdk.RDSClient({ region });
    return this.rdsClient;
  }

  private async ensureS3(region: string): Promise<SendableClient | null> {
    if (this.cfg.clients?.s3) return this.cfg.clients.s3;
    if (this.s3Client) return this.s3Client;
    const sdk = await tryImportAws<typeof S3SdkModule>('@aws-sdk/client-s3');
    if (!sdk) return null;
    this.s3Sdk = sdk;
    this.s3Client = new sdk.S3Client({ region });
    return this.s3Client;
  }

  private async ensureDynamo(region: string): Promise<SendableClient | null> {
    if (this.cfg.clients?.dynamo) return this.cfg.clients.dynamo;
    if (this.dynamoClient) return this.dynamoClient;
    const sdk = await tryImportAws<typeof DynamoSdkModule>('@aws-sdk/client-dynamodb');
    if (!sdk) return null;
    this.dynamoSdk = sdk;
    this.dynamoClient = new sdk.DynamoDBClient({ region });
    return this.dynamoClient;
  }

  // ── Existence ──

  async checkResourceExistence(resource: IacResource): Promise<ResourceExistence | PermissionMissing> {
    switch (resource.type) {
      case 'aws_db_instance':
        return this.checkRdsExistence(resource);
      case 'aws_s3_bucket':
        return this.checkS3Existence(resource);
      case 'aws_dynamodb_table':
        return this.checkDynamoExistence(resource);
      default:
        return { existence: 'unknown', reason: `no existence check for ${resource.type} yet` };
    }
  }

  private async checkRdsExistence(resource: IacResource): Promise<ResourceExistence | PermissionMissing> {
    const region = await this.resolveRegion(resource);
    const rds = await this.ensureRds(region);
    if (!rds) return { existence: 'unknown', reason: '@aws-sdk/client-rds is not installed' };
    try {
      const cmd = this.rdsSdk && !this.cfg.clients?.rds
        ? new this.rdsSdk.DescribeDBInstancesCommand({ DBInstanceIdentifier: resource.id })
        : { input: { DBInstanceIdentifier: resource.id } };
      await rds.send(cmd);
      return { existence: 'exists' };
    } catch (err) {
      if (err instanceof Error && (err.name === 'DBInstanceNotFoundFault' || err.name === 'DBInstanceNotFound')) {
        return { existence: 'missing' };
      }
      if (isAccessDeniedError(err)) return { permissionMissing: 'rds:DescribeDBInstances' };
      return { existence: 'unknown', reason: err instanceof Error ? err.message : String(err) };
    }
  }

  private async checkS3Existence(resource: IacResource): Promise<ResourceExistence | PermissionMissing> {
    const region = await this.resolveRegion(resource);
    const s3 = await this.ensureS3(region);
    if (!s3) return { existence: 'unknown', reason: '@aws-sdk/client-s3 is not installed' };
    try {
      const cmd = this.s3Sdk && !this.cfg.clients?.s3
        ? new this.s3Sdk.HeadBucketCommand({ Bucket: resource.id })
        : { input: { Bucket: resource.id } };
      await s3.send(cmd);
      return { existence: 'exists' };
    } catch (err) {
      if (this.isS3NotFound(err)) return { existence: 'missing' };
      if (isAccessDeniedError(err)) return { permissionMissing: 's3:ListBucket' };
      return { existence: 'unknown', reason: err instanceof Error ? err.message : String(err) };
    }
  }

  private isS3NotFound(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    if (err.name === 'NotFound' || err.name === 'NoSuchBucket') return true;
    const metadata = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
    return metadata?.httpStatusCode === 404;
  }

  private async checkDynamoExistence(resource: IacResource): Promise<ResourceExistence | PermissionMissing> {
    const region = await this.resolveRegion(resource);
    const dynamo = await this.ensureDynamo(region);
    if (!dynamo) return { existence: 'unknown', reason: '@aws-sdk/client-dynamodb is not installed' };
    try {
      const cmd = this.dynamoSdk && !this.cfg.clients?.dynamo
        ? new this.dynamoSdk.DescribeTableCommand({ TableName: resource.id })
        : { input: { TableName: resource.id } };
      await dynamo.send(cmd);
      return { existence: 'exists' };
    } catch (err) {
      if (err instanceof Error && err.name === 'ResourceNotFoundException') return { existence: 'missing' };
      if (isAccessDeniedError(err)) return { permissionMissing: 'dynamodb:DescribeTable' };
      return { existence: 'unknown', reason: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── Drift (deep trio only) ──

  async getResourceDrift(resource: IacResource): Promise<DriftComparison | PermissionMissing | null> {
    switch (resource.type) {
      case 'aws_db_instance':
        return this.getRdsDrift(resource);
      case 'aws_s3_bucket':
        return this.getS3Drift(resource);
      case 'aws_dynamodb_table':
        return this.getDynamoDrift(resource);
      default:
        return null;
    }
  }

  private async getRdsDrift(resource: IacResource): Promise<DriftComparison | PermissionMissing | null> {
    const region = await this.resolveRegion(resource);
    const rds = await this.ensureRds(region);
    if (!rds) return { permissionMissing: 'sdk:@aws-sdk/client-rds not installed' };
    try {
      const cmd = this.rdsSdk && !this.cfg.clients?.rds
        ? new this.rdsSdk.DescribeDBInstancesCommand({ DBInstanceIdentifier: resource.id })
        : { input: { DBInstanceIdentifier: resource.id } };
      const resp = await rds.send(cmd) as RdsSdkModule.DescribeDBInstancesCommandOutput;
      const instance = resp.DBInstances?.[0];
      if (!instance) return null;
      return compareRdsInstance(resource, {
        instanceClass: instance.DBInstanceClass ?? '',
        engine: instance.Engine ?? '',
        engineVersion: instance.EngineVersion ?? '',
        multiAz: instance.MultiAZ ?? false,
        backupRetentionPeriod: instance.BackupRetentionPeriod ?? 0,
        deletionProtection: instance.DeletionProtection ?? false,
        storageType: instance.StorageType ?? '',
        allocatedStorageGb: instance.AllocatedStorage ?? 0,
      });
    } catch (err) {
      if (isAccessDeniedError(err)) return { permissionMissing: 'rds:DescribeDBInstances' };
      throw err;
    }
  }

  private async getS3Drift(resource: IacResource): Promise<DriftComparison | PermissionMissing | null> {
    const region = await this.resolveRegion(resource);
    const s3 = await this.ensureS3(region);
    if (!s3) return { permissionMissing: 'sdk:@aws-sdk/client-s3 not installed' };
    const live = !this.cfg.clients?.s3 ? this.s3Sdk : null;

    let versioningEnabled: boolean;
    try {
      const cmd = live ? new live.GetBucketVersioningCommand({ Bucket: resource.id }) : { input: { Bucket: resource.id } };
      const resp = await s3.send(cmd) as S3SdkModule.GetBucketVersioningCommandOutput;
      versioningEnabled = resp.Status === 'Enabled';
    } catch (err) {
      if (isAccessDeniedError(err)) return { permissionMissing: 's3:GetBucketVersioning' };
      throw err;
    }

    let hasLifecycleRules: boolean;
    try {
      const cmd = live
        ? new live.GetBucketLifecycleConfigurationCommand({ Bucket: resource.id })
        : { input: { Bucket: resource.id } };
      const resp = await s3.send(cmd) as S3SdkModule.GetBucketLifecycleConfigurationCommandOutput;
      hasLifecycleRules = (resp.Rules?.length ?? 0) > 0;
    } catch (err) {
      if (err instanceof Error && err.name === 'NoSuchLifecycleConfiguration') {
        hasLifecycleRules = false;
      } else if (isAccessDeniedError(err)) {
        return { permissionMissing: 's3:GetBucketLifecycleConfiguration' };
      } else {
        throw err;
      }
    }

    const { resources } = await this.load();
    return compareS3Bucket(resource, resources, { versioningEnabled, hasLifecycleRules });
  }

  private async getDynamoDrift(resource: IacResource): Promise<DriftComparison | PermissionMissing | null> {
    const region = await this.resolveRegion(resource);
    const dynamo = await this.ensureDynamo(region);
    if (!dynamo) return { permissionMissing: 'sdk:@aws-sdk/client-dynamodb not installed' };
    const live = !this.cfg.clients?.dynamo ? this.dynamoSdk : null;

    let billingMode: string;
    try {
      const cmd = live ? new live.DescribeTableCommand({ TableName: resource.id }) : { input: { TableName: resource.id } };
      const resp = await dynamo.send(cmd) as DynamoSdkModule.DescribeTableCommandOutput;
      billingMode = resp.Table?.BillingModeSummary?.BillingMode ?? 'PROVISIONED';
    } catch (err) {
      if (isAccessDeniedError(err)) return { permissionMissing: 'dynamodb:DescribeTable' };
      throw err;
    }

    let pitrEnabled: boolean;
    try {
      const cmd = live
        ? new live.DescribeContinuousBackupsCommand({ TableName: resource.id })
        : { input: { TableName: resource.id } };
      const resp = await dynamo.send(cmd) as DynamoSdkModule.DescribeContinuousBackupsCommandOutput;
      pitrEnabled = resp.ContinuousBackupsDescription?.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus === 'ENABLED';
    } catch (err) {
      if (isAccessDeniedError(err)) return { permissionMissing: 'dynamodb:DescribeContinuousBackups' };
      throw err;
    }

    return compareDynamoTable(resource, { billingMode, pitrEnabled });
  }

  // ── ExecutionBackend ──

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'structured_command') {
      throw new Error(`Unsupported iac-drift live client command type: ${command.type}`);
    }
    switch (command.operation) {
      case 'scan_iac_drift': {
        const stateStatus = await this.getStateStatus();
        const resources = await this.listManagedResources();
        return { stateStatus, resourceCount: resources.length };
      }
      default:
        throw new Error(`Unknown iac-drift operation: ${command.operation}`);
    }
  }

  private async totalDriftCount(): Promise<number> {
    const resources = await this.listManagedResources();
    let count = 0;
    for (const resource of resources) {
      const drift = await this.getResourceDrift(resource);
      if (drift && 'drifts' in drift) count += drift.drifts.length;
    }
    return count;
  }

  private async totalMissingCount(): Promise<number> {
    const resources = await this.listManagedResources();
    let count = 0;
    for (const resource of resources) {
      const existence = await this.checkResourceExistence(resource);
      if (!isPermissionMissing(existence) && existence.existence === 'missing') count += 1;
    }
    return count;
  }

  async evaluateCheck(check: CheckExpression): Promise<boolean> {
    const stmt = check.statement ?? '';

    if (stmt === 'iac_drift_count') {
      const count = await this.totalDriftCount();
      return compareCheckValue(count, check.expect.operator, check.expect.value);
    }

    if (stmt === 'iac_missing_count') {
      const count = await this.totalMissingCount();
      return compareCheckValue(count, check.expect.operator, check.expect.value);
    }

    if (stmt === 'iac_state_readable') {
      const status = await this.getStateStatus();
      return compareCheckValue(status.readable ? 1 : 0, check.expect.operator, check.expect.value);
    }

    return true;
  }

  async close(): Promise<void> {
    // Only destroy constructed SDK clients — injected test clients are owned
    // by the caller.
    if (this.rdsClient && !this.cfg.clients?.rds) {
      (this.rdsClient as unknown as { destroy?: () => void }).destroy?.();
    }
    if (this.s3Client && !this.cfg.clients?.s3) {
      (this.s3Client as unknown as { destroy?: () => void }).destroy?.();
    }
    if (this.dynamoClient && !this.cfg.clients?.dynamo) {
      (this.dynamoClient as unknown as { destroy?: () => void }).destroy?.();
    }
    this.rdsClient = null;
    this.rdsSdk = null;
    this.s3Client = null;
    this.s3Sdk = null;
    this.dynamoClient = null;
    this.dynamoSdk = null;
  }
}
