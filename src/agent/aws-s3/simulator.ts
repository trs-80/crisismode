// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { S3RecoveryBackend, BucketConfig } from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';

export type SimulatorState = 'degraded' | 'recovering' | 'recovered';

export class S3RecoverySimulator implements S3RecoveryBackend {
  private state: SimulatorState = 'degraded';

  transition(to: string): void {
    if (to !== 'degraded' && to !== 'recovering' && to !== 'recovered') {
      throw new Error(`Invalid S3 simulator state: ${to}`);
    }
    this.state = to;
  }

  async getBucketConfig(): Promise<BucketConfig> {
    switch (this.state) {
      case 'degraded':
        return {
          bucket: 'prod-backup-bucket',
          region: 'us-east-1',
          versioningStatus: 'Suspended',
          lifecycleRules: [],
        };
      case 'recovering':
        return {
          bucket: 'prod-backup-bucket',
          region: 'us-east-1',
          versioningStatus: 'Enabled',
          lifecycleRules: [],
        };
      case 'recovered':
        return {
          bucket: 'prod-backup-bucket',
          region: 'us-east-1',
          versioningStatus: 'Enabled',
          lifecycleRules: [
            {
              id: 'archive-old-backups',
              status: 'Enabled',
              prefix: 'backups/',
              transitions: [
                { days: 30, storageClass: 'STANDARD_IA' },
                { days: 90, storageClass: 'GLACIER' },
              ],
              expiration: { days: 365 },
            },
          ],
        };
    }
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'structured_command') {
      throw new Error(`Unsupported S3 simulator command type: ${command.type}`);
    }

    switch (command.operation) {
      case 'get_bucket_config':
        return { config: await this.getBucketConfig() };
      case 'put_bucket_versioning':
        this.transition('recovering');
        return { versioningEnabled: true };
      case 'put_bucket_lifecycle':
        this.transition('recovered');
        return { lifecycleConfigured: true };
      default:
        return { simulated: true, operation: command.operation, parameters: command.parameters };
    }
  }

  async evaluateCheck(check: CheckExpression): Promise<boolean> {
    const stmt = check.statement ?? '';

    if (stmt.includes('versioning_status')) {
      const config = await this.getBucketConfig();
      return this.compare(config.versioningStatus, check.expect.operator, check.expect.value);
    }

    if (stmt.includes('lifecycle_rule_count')) {
      const config = await this.getBucketConfig();
      return this.compare(config.lifecycleRules.length, check.expect.operator, check.expect.value);
    }

    if (stmt.includes('bucket_exists')) {
      return this.compare('true', check.expect.operator, check.expect.value);
    }

    return true;
  }

  listCapabilityProviders(): CapabilityProviderDescriptor[] {
    return [
      {
        id: 's3-simulator-admin',
        kind: 'capability_provider',
        name: 'S3 Simulator Admin Provider',
        maturity: 'simulator_only',
        capabilities: ['s3.versioning.read', 's3.versioning.write', 's3.lifecycle.read', 's3.lifecycle.write'],
        executionContexts: ['s3_read', 's3_write'],
        targetKinds: ['aws-s3'],
        commandTypes: ['structured_command'],
        supportsDryRun: true,
        supportsExecute: true,
      },
    ];
  }

  async close(): Promise<void> {}

  private compare(actual: unknown, operator: string, expected: unknown): boolean {
    const a = Number(actual);
    const e = Number(expected);

    if (Number.isNaN(a) || Number.isNaN(e)) {
      const sa = String(actual);
      const se = String(expected);
      switch (operator) {
        case 'eq': return sa === se;
        case 'neq': return sa !== se;
        default: return false;
      }
    }

    switch (operator) {
      case 'eq': return a === e;
      case 'neq': return a !== e;
      case 'gt': return a > e;
      case 'gte': return a >= e;
      case 'lt': return a < e;
      case 'lte': return a <= e;
      default: return false;
    }
  }
}
