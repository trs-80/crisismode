// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type {
  ConfigDriftBackend,
  EnvVarStatus,
  SecretStatus,
  ConfigDiff,
  ConfigChange,
} from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';

export type SimulatorState = 'drifted' | 'correcting' | 'aligned';

export class ConfigDriftSimulator implements ConfigDriftBackend {
  private state: SimulatorState = 'drifted';

  transition(to: string): void {
    this.state = to as SimulatorState;
  }

  async getEnvironmentVars(): Promise<EnvVarStatus[]> {
    const base: EnvVarStatus[] = [
      {
        name: 'DATABASE_URL',
        expected: 'postgresql://app:***@db-primary.prod:5432/appdb',
        actual: this.state === 'drifted'
          ? 'postgresql://app:***@db-staging.dev:5432/appdb'
          : 'postgresql://app:***@db-primary.prod:5432/appdb',
        source: 'kubernetes-secret',
        lastChanged: '2026-03-16T02:15:00Z',
        masked: true,
      },
      {
        name: 'LOG_LEVEL',
        expected: 'info',
        actual: 'info',
        source: 'configmap',
        masked: false,
      },
      {
        name: 'FEATURE_FLAGS_ENDPOINT',
        expected: 'https://flags.prod.internal/api/v2',
        actual: this.state === 'drifted'
          ? 'https://flags.staging.internal/api/v2'
          : 'https://flags.prod.internal/api/v2',
        source: 'configmap',
        lastChanged: '2026-03-16T02:15:00Z',
        masked: false,
      },
      {
        name: 'REDIS_URL',
        expected: 'redis://cache-primary.prod:6379',
        actual: 'redis://cache-primary.prod:6379',
        source: 'kubernetes-secret',
        masked: true,
      },
    ];
    return base;
  }

  async getSecretStatus(): Promise<SecretStatus[]> {
    return [
      {
        name: 'api-gateway-key',
        provider: 'vault',
        mounted: true,
        expired: this.state === 'drifted',
        lastRotated: '2026-02-14T08:00:00Z',
      },
      {
        name: 'tls-cert-prod',
        provider: 'cert-manager',
        mounted: true,
        expired: false,
        lastRotated: '2026-03-01T00:00:00Z',
      },
      {
        name: 'db-credentials',
        provider: 'vault',
        mounted: true,
        expired: false,
        lastRotated: '2026-03-10T12:00:00Z',
      },
    ];
  }

  async getConfigDiff(): Promise<ConfigDiff[]> {
    if (this.state === 'aligned') {
      return [];
    }

    const diffs: ConfigDiff[] = [
      {
        path: '/etc/app/feature-flags.json',
        expected: '{"new_checkout": true, "dark_mode": false}',
        actual: this.state === 'drifted'
          ? '{"new_checkout": false, "dark_mode": true}'
          : '{"new_checkout": true, "dark_mode": false}',
        source: 'file',
      },
    ];

    if (this.state === 'drifted') {
      diffs.push(
        {
          path: 'DATABASE_URL',
          expected: 'postgresql://app:***@db-primary.prod:5432/appdb',
          actual: 'postgresql://app:***@db-staging.dev:5432/appdb',
          source: 'env',
        },
        {
          path: 'FEATURE_FLAGS_ENDPOINT',
          expected: 'https://flags.prod.internal/api/v2',
          actual: 'https://flags.staging.internal/api/v2',
          source: 'env',
        },
      );
    }

    return diffs;
  }

  async getRecentConfigChanges(): Promise<ConfigChange[]> {
    return [
      {
        path: 'DATABASE_URL',
        previousValue: '***masked***',
        currentValue: '***masked***',
        changedAt: '2026-03-16T02:15:00Z',
        changedBy: 'deploy-pipeline-v2.3.1',
        source: 'kubernetes-secret',
      },
      {
        path: '/etc/app/feature-flags.json',
        previousValue: '{"new_checkout": true, "dark_mode": false}',
        currentValue: '{"new_checkout": false, "dark_mode": true}',
        changedAt: '2026-03-16T02:14:30Z',
        changedBy: 'deploy-pipeline-v2.3.1',
        source: 'configmap',
      },
      {
        path: 'FEATURE_FLAGS_ENDPOINT',
        previousValue: 'https://flags.prod.internal/api/v2',
        currentValue: 'https://flags.staging.internal/api/v2',
        changedAt: '2026-03-16T02:14:30Z',
        changedBy: 'deploy-pipeline-v2.3.1',
        source: 'configmap',
      },
    ];
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'api_call' && command.type !== 'configuration_change') {
      throw new Error(`Unsupported config-drift simulator command type: ${command.type}`);
    }

    switch (command.operation) {
      case 'scan_config':
        return {
          envVars: await this.getEnvironmentVars(),
          secrets: await this.getSecretStatus(),
          configDiffs: await this.getConfigDiff(),
          recentChanges: await this.getRecentConfigChanges(),
        };
      case 'restore_env_vars':
        this.transition('correcting');
        return { restored: true, variables: command.parameters?.variables };
      case 'rotate_secrets':
        return { rotated: true, secrets: command.parameters?.secrets };
      case 'restore_config_files':
        this.transition('aligned');
        return { restored: true, files: command.parameters?.files };
      case 'verify_alignment':
        return {
          aligned: this.state === 'aligned',
          diffs: await this.getConfigDiff(),
        };
      default:
        return { simulated: true, operation: command.operation, parameters: command.parameters };
    }
  }

  async evaluateCheck(check: CheckExpression): Promise<boolean> {
    const stmt = check.statement ?? '';

    if (stmt === 'config_drift_count') {
      const diffs = await this.getConfigDiff();
      return this.compare(diffs.length, check.expect.operator, check.expect.value);
    }

    if (stmt === 'expired_secrets_count') {
      const secrets = await this.getSecretStatus();
      const expiredCount = secrets.filter((s) => s.expired).length;
      return this.compare(expiredCount, check.expect.operator, check.expect.value);
    }

    if (stmt === 'env_var_mismatches') {
      const vars = await this.getEnvironmentVars();
      const mismatches = vars.filter((v) => v.expected !== v.actual).length;
      return this.compare(mismatches, check.expect.operator, check.expect.value);
    }

    if (stmt === 'all_configs_aligned') {
      const diffs = await this.getConfigDiff();
      return this.compare(diffs.length === 0, check.expect.operator, check.expect.value);
    }

    return true;
  }

  listCapabilityProviders(): CapabilityProviderDescriptor[] {
    return [
      {
        id: 'config-drift-simulator-read',
        kind: 'capability_provider',
        name: 'Config Drift Simulator Read Provider',
        maturity: 'simulator_only',
        capabilities: ['config.env.read', 'config.secrets.read'],
        executionContexts: ['config_read'],
        targetKinds: ['application-config'],
        commandTypes: ['api_call'],
        supportsDryRun: true,
        supportsExecute: true,
      },
      {
        id: 'config-drift-simulator-write',
        kind: 'capability_provider',
        name: 'Config Drift Simulator Write Provider',
        maturity: 'simulator_only',
        capabilities: ['config.env.restore', 'config.secrets.rotate', 'config.file.restore'],
        executionContexts: ['config_write'],
        targetKinds: ['application-config'],
        commandTypes: ['configuration_change'],
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
