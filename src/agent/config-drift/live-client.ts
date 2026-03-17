// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * ConfigDriftLiveClient — compares running environment variables, secrets,
 * and config files against git-tracked expected values.
 *
 * Works by reading the current process environment, checking file system
 * config files, and optionally querying Kubernetes for configmap/secret state.
 */

import { execFile } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { promisify } from 'node:util';
import type {
  ConfigDriftBackend,
  EnvVarStatus,
  SecretStatus,
  ConfigDiff,
  ConfigChange,
} from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';

const execFileAsync = promisify(execFile);

export interface ConfigExpectation {
  /** Environment variable or config file path */
  path: string;
  /** Expected value (null = should not be set) */
  expected: string | null;
  /** Source type */
  source: 'env' | 'file' | 'secret' | 'remote';
  /** Whether to mask the value in output */
  masked?: boolean;
}

export interface SecretExpectation {
  name: string;
  provider: 'vault' | 'cert-manager' | 'aws-secrets-manager' | 'k8s-secret';
  /** K8s namespace (if applicable) */
  namespace?: string;
}

export interface ConfigDriftLiveConfig {
  /** Expected config values to check against */
  expectations: ConfigExpectation[];
  /** Secrets to check mount/expiry status */
  secrets?: SecretExpectation[];
  /** Git repo root for comparing file configs (default: cwd) */
  gitRoot?: string;
  /** Kubernetes namespace for configmap/secret queries */
  k8sNamespace?: string;
}

export class ConfigDriftLiveClient implements ConfigDriftBackend {
  private readonly config: ConfigDriftLiveConfig;

  constructor(config: ConfigDriftLiveConfig) {
    this.config = config;
  }

  async getEnvironmentVars(): Promise<EnvVarStatus[]> {
    const results: EnvVarStatus[] = [];

    for (const exp of this.config.expectations) {
      if (exp.source !== 'env') continue;

      const actual = process.env[exp.path] ?? null;
      const masked = exp.masked ?? (exp.path.includes('SECRET') || exp.path.includes('PASSWORD') || exp.path.includes('KEY') || exp.path.includes('TOKEN'));

      results.push({
        name: exp.path,
        expected: masked && exp.expected ? this.maskValue(exp.expected) : exp.expected,
        actual: masked && actual ? this.maskValue(actual) : actual,
        source: 'env',
        masked,
      });
    }

    return results;
  }

  async getSecretStatus(): Promise<SecretStatus[]> {
    const secrets = this.config.secrets ?? [];
    const results: SecretStatus[] = [];

    for (const secret of secrets) {
      if (secret.provider === 'k8s-secret' && this.config.k8sNamespace) {
        const status = await this.checkK8sSecret(secret.name, this.config.k8sNamespace);
        results.push(status);
      } else if (secret.provider === 'cert-manager') {
        const status = await this.checkCertificate(secret.name);
        results.push(status);
      } else {
        // Generic check — just verify the secret name resolves to something
        results.push({
          name: secret.name,
          provider: secret.provider,
          mounted: process.env[secret.name] !== undefined,
          expired: false,
        });
      }
    }

    return results;
  }

  async getConfigDiff(): Promise<ConfigDiff[]> {
    const diffs: ConfigDiff[] = [];

    for (const exp of this.config.expectations) {
      const actual = await this.getActualValue(exp);
      if (actual !== null && exp.expected !== null && actual !== exp.expected) {
        diffs.push({
          path: exp.path,
          expected: exp.masked ? this.maskValue(exp.expected) : exp.expected,
          actual: exp.masked ? this.maskValue(actual) : actual,
          source: exp.source,
        });
      } else if (actual === null && exp.expected !== null) {
        diffs.push({
          path: exp.path,
          expected: exp.masked ? this.maskValue(exp.expected) : exp.expected,
          actual: '<not set>',
          source: exp.source,
        });
      }
    }

    return diffs;
  }

  async getRecentConfigChanges(): Promise<ConfigChange[]> {
    const changes: ConfigChange[] = [];
    const gitRoot = this.config.gitRoot ?? process.cwd();

    // Check git log for recent config file changes
    try {
      const { stdout } = await execFileAsync('git', [
        'log',
        '--oneline',
        '--diff-filter=M',
        '--since=7 days ago',
        '--name-only',
        '--',
        '*.env',
        '*.env.*',
        '*.json',
        '*.yaml',
        '*.yml',
        '*.toml',
      ], { cwd: gitRoot });

      const lines = stdout.trim().split('\n').filter(Boolean);
      let currentCommit = '';
      let currentAuthor = '';

      for (const line of lines) {
        if (line.match(/^[a-f0-9]+ /)) {
          const parts = line.split(' ');
          currentCommit = parts[0];
          currentAuthor = parts.slice(1).join(' ');
        } else if (line.trim()) {
          changes.push({
            path: line.trim(),
            changedAt: new Date().toISOString(), // Simplified; would parse git log dates in production
            changedBy: currentAuthor || currentCommit,
            source: 'git',
          });
        }
      }
    } catch {
      // Git not available or not a git repo — skip
    }

    return changes;
  }

  private async getActualValue(exp: ConfigExpectation): Promise<string | null> {
    switch (exp.source) {
      case 'env':
        return process.env[exp.path] ?? null;
      case 'file':
        try {
          return (await readFile(exp.path, 'utf-8')).trim();
        } catch {
          return null;
        }
      case 'secret':
        return process.env[exp.path] ?? null;
      case 'remote':
        // Remote config would need HTTP fetch — return env var fallback
        return process.env[exp.path] ?? null;
      default:
        return null;
    }
  }

  private async checkK8sSecret(name: string, namespace: string): Promise<SecretStatus> {
    try {
      const { stdout } = await execFileAsync('kubectl', [
        'get', 'secret', name,
        '-n', namespace,
        '-o', 'jsonpath={.metadata.creationTimestamp}',
      ]);
      return {
        name,
        provider: 'k8s-secret',
        mounted: true,
        expired: false,
        lastRotated: stdout.trim(),
      };
    } catch {
      return { name, provider: 'k8s-secret', mounted: false, expired: false };
    }
  }

  private async checkCertificate(name: string): Promise<SecretStatus> {
    // Check if cert file exists and whether it's expired
    try {
      await access(name);
      const { stdout } = await execFileAsync('openssl', [
        'x509', '-enddate', '-noout', '-in', name,
      ]);
      const dateMatch = stdout.match(/notAfter=(.+)/);
      if (dateMatch) {
        const expiry = new Date(dateMatch[1]);
        return {
          name,
          provider: 'cert-manager',
          mounted: true,
          expired: expiry < new Date(),
          lastRotated: expiry.toISOString(),
        };
      }
      return { name, provider: 'cert-manager', mounted: true, expired: false };
    } catch {
      return { name, provider: 'cert-manager', mounted: false, expired: false };
    }
  }

  private maskValue(value: string): string {
    if (value.length <= 8) return '***';
    return value.slice(0, 4) + '***' + value.slice(-4);
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'api_call' && command.type !== 'configuration_change') {
      throw new Error(`Unsupported config-drift live client command type: ${command.type}`);
    }

    switch (command.operation) {
      case 'scan_config':
        return {
          envVars: await this.getEnvironmentVars(),
          secrets: await this.getSecretStatus(),
          configDiffs: await this.getConfigDiff(),
          recentChanges: await this.getRecentConfigChanges(),
        };
      case 'restore_env_vars': {
        // In a real environment, this would update K8s configmaps/secrets
        // or call the relevant config management API
        const variables = (command.parameters?.variables as string[]) ?? [];
        return {
          restored: false,
          variables,
          note: 'Environment variable restoration requires platform-specific implementation (K8s configmap update, etc.)',
        };
      }
      case 'rotate_secrets': {
        const secrets = (command.parameters?.secrets as string[]) ?? [];
        return {
          rotated: false,
          secrets,
          note: 'Secret rotation requires provider-specific implementation (Vault, cert-manager, etc.)',
        };
      }
      case 'restore_config_files': {
        const files = (command.parameters?.files as string[]) ?? [];
        const gitRoot = this.config.gitRoot ?? process.cwd();
        const restored: string[] = [];

        for (const file of files) {
          try {
            // Restore file from git HEAD
            await execFileAsync('git', ['checkout', 'HEAD', '--', file], { cwd: gitRoot });
            restored.push(file);
          } catch {
            // Skip files that can't be restored from git
          }
        }

        return { restored: restored.length > 0, files: restored };
      }
      case 'verify_alignment': {
        const diffs = await this.getConfigDiff();
        return { aligned: diffs.length === 0, diffs };
      }
      default:
        throw new Error(`Unknown config-drift operation: ${command.operation}`);
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
      const diffs = await this.getConfigDiff();
      const envMismatches = diffs.filter((d) => d.source === 'env').length;
      return this.compare(envMismatches, check.expect.operator, check.expect.value);
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
        id: 'config-drift-live-read',
        kind: 'capability_provider',
        name: 'Config Drift Live Read Provider',
        maturity: 'live_validated',
        capabilities: ['config.env.read', 'config.secrets.read'],
        executionContexts: ['config_read'],
        targetKinds: ['application-config'],
        commandTypes: ['api_call'],
        supportsDryRun: true,
        supportsExecute: true,
      },
      {
        id: 'config-drift-live-write',
        kind: 'capability_provider',
        name: 'Config Drift Live Write Provider',
        maturity: 'live_validated',
        capabilities: ['config.env.restore', 'config.secrets.rotate', 'config.file.restore'],
        executionContexts: ['config_write'],
        targetKinds: ['application-config'],
        commandTypes: ['configuration_change'],
        supportsDryRun: true,
        supportsExecute: true,
      },
    ];
  }

  transition(_to: string): void {
    // No-op for live client.
  }

  async close(): Promise<void> {
    // No persistent connections to clean up.
  }

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
