// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type {
  IacDriftBackend,
  IacDriftScenario,
  IacStateStatus,
  ResourceExistence,
} from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import { compareCheckValue } from '../../framework/check-helpers.js';
import { parseTfState, type IacResource } from './state-parser.js';
import {
  compareRdsInstance,
  compareS3Bucket,
  compareDynamoTable,
  type DriftComparison,
  type ObservedRdsFacts,
  type ObservedS3Facts,
  type ObservedDynamoFacts,
} from './drift-compare.js';
import type { PermissionMissing } from '../aws-common.js';

/** Embedded tfstate v4 fixture — mirrors the shape of the shared test fixture
 *  (src/__tests__/fixtures/iac-tfstate-v4.ts) without importing from __tests__. */
const FIXTURE_STATE = JSON.stringify({
  version: 4,
  terraform_version: '1.9.0',
  serial: 42,
  lineage: 'abc',
  resources: [
    {
      mode: 'managed', type: 'aws_db_instance', name: 'main',
      instances: [{ attributes: {
        id: 'prod-db', arn: 'arn:aws:rds:us-east-1::db:prod-db',
        instance_class: 'db.t3.medium', engine: 'postgres', engine_version: '16',
        multi_az: false, backup_retention_period: 7, deletion_protection: true,
        storage_type: 'gp3', allocated_storage: 20,
      } }],
    },
    { mode: 'managed', type: 'aws_s3_bucket', name: 'uploads',
      instances: [{ attributes: { id: 'user-uploads', bucket: 'user-uploads', arn: 'arn:aws:s3:::user-uploads' } }] },
    { mode: 'managed', type: 'aws_s3_bucket_versioning', name: 'uploads',
      instances: [{ attributes: { id: 'user-uploads', bucket: 'user-uploads', versioning_configuration: [{ status: 'Enabled' }] } }] },
    { mode: 'managed', type: 'aws_dynamodb_table', name: 'sessions',
      instances: [{ attributes: {
        id: 'sessions', arn: 'arn:aws:dynamodb:us-east-1::table/sessions',
        billing_mode: 'PAY_PER_REQUEST', point_in_time_recovery: [{ enabled: true }],
      } }] },
    { mode: 'managed', type: 'aws_elasticache_cluster', name: 'cache',
      instances: [{ attributes: { id: 'app-cache', arn: 'arn:aws:elasticache:us-east-1::cluster:app-cache' } }] },
  ],
});

const RDS_OBSERVED: Record<IacDriftScenario, ObservedRdsFacts> = {
  drifted: {
    instanceClass: 'db.t3.large',
    engine: 'postgres',
    engineVersion: '16',
    multiAz: false,
    backupRetentionPeriod: 7,
    deletionProtection: false,
    storageType: 'gp3',
    allocatedStorageGb: 20,
  },
  aligned: {
    instanceClass: 'db.t3.medium',
    engine: 'postgres',
    engineVersion: '16',
    multiAz: false,
    backupRetentionPeriod: 7,
    deletionProtection: true,
    storageType: 'gp3',
    allocatedStorageGb: 20,
  },
  state_unreadable: {
    instanceClass: 'db.t3.medium',
    engine: 'postgres',
    engineVersion: '16',
    multiAz: false,
    backupRetentionPeriod: 7,
    deletionProtection: true,
    storageType: 'gp3',
    allocatedStorageGb: 20,
  },
};

const S3_OBSERVED: ObservedS3Facts = { versioningEnabled: true, hasLifecycleRules: false };
const DYNAMO_OBSERVED: ObservedDynamoFacts = { billingMode: 'PAY_PER_REQUEST', pitrEnabled: true };

/** In-memory scenario simulator for Terraform drift detection. Never touches
 *  the filesystem or a real state backend — the embedded fixture above stands
 *  in for a parsed tfstate, and every comparison runs through the real Task 2
 *  comparators rather than a parallel fake. */
export class IacDriftSimulator implements IacDriftBackend {
  constructor(private scenario: IacDriftScenario = 'drifted') {}

  transition(to: string): void {
    this.scenario = to as IacDriftScenario;
  }

  private stateResources(): IacResource[] {
    const parsed = parseTfState(FIXTURE_STATE);
    return parsed.ok ? parsed.resources : [];
  }

  async getStateStatus(): Promise<IacStateStatus> {
    if (this.scenario === 'state_unreadable') {
      return {
        source: 'local',
        detail: 'terraform.tfstate',
        readable: false,
        reason: 'state file is not valid JSON',
      };
    }

    const parsed = parseTfState(FIXTURE_STATE);
    return {
      source: 'local',
      detail: 'terraform.tfstate',
      readable: true,
      serial: parsed.ok ? parsed.summary.serial : undefined,
      resourceCounts: parsed.ok ? parsed.summary.resourceCounts : undefined,
    };
  }

  async listManagedResources(): Promise<IacResource[]> {
    if (this.scenario === 'state_unreadable') return [];
    return this.stateResources();
  }

  async checkResourceExistence(resource: IacResource): Promise<ResourceExistence | PermissionMissing> {
    if (resource.type === 'aws_elasticache_cluster') {
      return { existence: 'unknown', reason: 'no existence check for aws_elasticache_cluster yet' };
    }
    if (this.scenario === 'drifted' && resource.type === 'aws_s3_bucket') {
      return { existence: 'missing' };
    }
    return { existence: 'exists' };
  }

  async getResourceDrift(resource: IacResource): Promise<DriftComparison | PermissionMissing | null> {
    switch (resource.type) {
      case 'aws_db_instance':
        return compareRdsInstance(resource, RDS_OBSERVED[this.scenario]);
      case 'aws_s3_bucket':
        return compareS3Bucket(resource, this.stateResources(), S3_OBSERVED);
      case 'aws_dynamodb_table':
        return compareDynamoTable(resource, DYNAMO_OBSERVED);
      default:
        return null;
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
      if ('existence' in existence && existence.existence === 'missing') count += 1;
    }
    return count;
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'structured_command') {
      throw new Error(`Unsupported iac-drift simulator command type: ${command.type}`);
    }

    switch (command.operation) {
      case 'scan_iac_drift': {
        const stateStatus = await this.getStateStatus();
        const resources = await this.listManagedResources();
        return { stateStatus, resourceCount: resources.length };
      }
      default:
        return { simulated: true, operation: command.operation, parameters: command.parameters };
    }
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

    // Fail closed, matching the live client (and the vector-store
    // precedent): a precondition/success-criteria check on an unrecognized
    // statement is a plan-authoring bug, and this backend must not let it
    // pass silently. Throwing was considered instead, but the graph engine's
    // node functions (src/framework/graph-nodes.ts) call evaluateCheck
    // without a surrounding try/catch — an exception here would propagate
    // out of LangGraph's stream() uncaught rather than surface as a failed
    // step, so `false` is the only semantic both execution engines handle
    // safely.
    return false;
  }

  async close(): Promise<void> {}
}
