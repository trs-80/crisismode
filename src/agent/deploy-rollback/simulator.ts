// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type {
  DeployBackend,
  DeploymentInfo,
  TrafficDistribution,
  EndpointHealth,
} from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';

export type SimulatorState = 'bad_deploy' | 'rolling_back' | 'stabilized';

export class DeploySimulator implements DeployBackend {
  private state: SimulatorState = 'bad_deploy';

  private readonly badDeploy: DeploymentInfo = {
    sha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    timestamp: new Date(Date.now() - 12 * 60_000).toISOString(), // 12 min ago
    status: 'running',
    author: 'ci-bot',
    message: 'feat: migrate user sessions to new token format',
  };

  private readonly goodDeploy: DeploymentInfo = {
    sha: '7f8e9d0c1b2a3f4e5d6c7b8a9f0e1d2c3b4a5f6e',
    timestamp: new Date(Date.now() - 2 * 3_600_000).toISOString(), // 2 hours ago
    status: 'succeeded',
    author: 'ci-bot',
    message: 'fix: correct rate limiter bucket configuration',
  };

  private readonly olderDeploy: DeploymentInfo = {
    sha: '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
    timestamp: new Date(Date.now() - 26 * 3_600_000).toISOString(), // 26 hours ago
    status: 'succeeded',
    author: 'developer-a',
    message: 'chore: update dependency versions',
  };

  transition(to: string): void {
    this.state = to as SimulatorState;
  }

  async getCurrentDeployment(): Promise<DeploymentInfo> {
    switch (this.state) {
      case 'bad_deploy':
        return { ...this.badDeploy };
      case 'rolling_back':
        return { ...this.badDeploy, status: 'rolling_back' };
      case 'stabilized':
        return { ...this.goodDeploy, status: 'running' };
    }
  }

  async listRecentDeploys(limit: number): Promise<DeploymentInfo[]> {
    return [
      await this.getCurrentDeployment(),
      { ...this.goodDeploy },
      { ...this.olderDeploy },
    ].slice(0, limit);
  }

  async getTrafficDistribution(): Promise<TrafficDistribution> {
    switch (this.state) {
      case 'bad_deploy':
        return {
          entries: [
            { target: this.badDeploy.sha.slice(0, 8), percentage: 100 },
          ],
        };
      case 'rolling_back':
        return {
          entries: [
            { target: this.badDeploy.sha.slice(0, 8), percentage: 10 },
            { target: this.goodDeploy.sha.slice(0, 8), percentage: 90 },
          ],
        };
      case 'stabilized':
        return {
          entries: [
            { target: this.goodDeploy.sha.slice(0, 8), percentage: 100 },
          ],
        };
    }
  }

  async getHealthEndpoints(): Promise<EndpointHealth[]> {
    switch (this.state) {
      case 'bad_deploy':
        return [
          { url: '/healthz', status: 'degraded', latencyMs: 1_240, errorRate: 12.4 },
          { url: '/api/v1/users', status: 'down', latencyMs: 5_000, errorRate: 34.7 },
          { url: '/api/v1/sessions', status: 'down', latencyMs: 5_000, errorRate: 62.1 },
          { url: '/api/v1/config', status: 'healthy', latencyMs: 45, errorRate: 0.1 },
        ];
      case 'rolling_back':
        return [
          { url: '/healthz', status: 'healthy', latencyMs: 120, errorRate: 1.8 },
          { url: '/api/v1/users', status: 'healthy', latencyMs: 210, errorRate: 2.3 },
          { url: '/api/v1/sessions', status: 'degraded', latencyMs: 890, errorRate: 4.1 },
          { url: '/api/v1/config', status: 'healthy', latencyMs: 42, errorRate: 0.0 },
        ];
      case 'stabilized':
        return [
          { url: '/healthz', status: 'healthy', latencyMs: 18, errorRate: 0.0 },
          { url: '/api/v1/users', status: 'healthy', latencyMs: 85, errorRate: 0.1 },
          { url: '/api/v1/sessions', status: 'healthy', latencyMs: 92, errorRate: 0.2 },
          { url: '/api/v1/config', status: 'healthy', latencyMs: 38, errorRate: 0.0 },
        ];
    }
  }

  async getRollbackTarget(): Promise<DeploymentInfo | null> {
    return { ...this.goodDeploy };
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'api_call') {
      throw new Error(`Unsupported deploy simulator command type: ${command.type}`);
    }

    switch (command.operation) {
      case 'deploy_status':
        return {
          current: await this.getCurrentDeployment(),
          traffic: await this.getTrafficDistribution(),
          endpoints: await this.getHealthEndpoints(),
        };
      case 'traffic_shift':
        this.transition('rolling_back');
        return { shifted: true, distribution: await this.getTrafficDistribution() };
      case 'full_rollback':
        this.transition('stabilized');
        return { rolledBack: true, activeDeploy: await this.getCurrentDeployment() };
      case 'health_check':
        return { endpoints: await this.getHealthEndpoints() };
      default:
        return { simulated: true, operation: command.operation, parameters: command.parameters };
    }
  }

  async evaluateCheck(check: CheckExpression): Promise<boolean> {
    const stmt = check.statement ?? '';

    if (stmt === 'deploy_health') {
      const endpoints = await this.getHealthEndpoints();
      const maxErrorRate = Math.max(...endpoints.map((e) => e.errorRate));
      return this.compare(maxErrorRate, check.expect.operator, check.expect.value);
    }

    if (stmt === 'error_rate') {
      const endpoints = await this.getHealthEndpoints();
      const avgErrorRate =
        endpoints.reduce((sum, e) => sum + e.errorRate, 0) / endpoints.length;
      return this.compare(avgErrorRate, check.expect.operator, check.expect.value);
    }

    if (stmt === 'traffic_distribution') {
      const traffic = await this.getTrafficDistribution();
      const primaryPct = traffic.entries[0]?.percentage ?? 0;
      return this.compare(primaryPct, check.expect.operator, check.expect.value);
    }

    return true;
  }

  listCapabilityProviders(): CapabilityProviderDescriptor[] {
    return [
      {
        id: 'deploy-simulator-provider',
        kind: 'capability_provider',
        name: 'Deploy Simulator Provider',
        maturity: 'simulator_only',
        capabilities: [
          'deploy.status.read',
          'deploy.history.read',
          'deploy.rollback',
          'traffic.shift',
        ],
        executionContexts: ['deploy_read', 'deploy_write'],
        targetKinds: ['application'],
        commandTypes: ['api_call'],
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
