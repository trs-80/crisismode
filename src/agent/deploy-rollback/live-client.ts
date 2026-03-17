// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * DeployLiveClient — connects to the Vercel API to query deployment state,
 * traffic distribution, and health endpoints.
 *
 * Requires VERCEL_TOKEN and VERCEL_PROJECT_ID environment variables.
 * Optionally accepts VERCEL_TEAM_ID for team-scoped projects.
 */

import type {
  DeployBackend,
  DeploymentInfo,
  TrafficDistribution,
  EndpointHealth,
} from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';

export interface VercelConfig {
  token: string;
  projectId: string;
  teamId?: string;
  /** Application health-check URLs to probe (e.g. ['https://app.example.com/healthz']) */
  healthEndpoints?: string[];
  /** Request timeout in milliseconds (default: 10000) */
  timeoutMs?: number;
}

interface VercelDeployment {
  uid: string;
  name: string;
  url: string;
  state: string;
  created: number;
  meta?: { githubCommitSha?: string; githubCommitMessage?: string; githubCommitAuthorLogin?: string };
  readyState?: string;
}

export class DeployLiveClient implements DeployBackend {
  private readonly baseUrl = 'https://api.vercel.com';
  private readonly config: VercelConfig;
  private readonly timeoutMs: number;

  constructor(config: VercelConfig) {
    this.config = config;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  private async fetch<T>(path: string): Promise<T> {
    const params = new URLSearchParams();
    if (this.config.teamId) {
      params.set('teamId', this.config.teamId);
    }
    const qs = params.toString();
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.config.token}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Vercel API error: ${response.status} ${response.statusText} for ${path}`);
    }

    return response.json() as Promise<T>;
  }

  private toDeploymentInfo(d: VercelDeployment): DeploymentInfo {
    const stateMap: Record<string, DeploymentInfo['status']> = {
      READY: 'succeeded',
      ERROR: 'failed',
      BUILDING: 'running',
      QUEUED: 'running',
      CANCELED: 'failed',
    };

    return {
      sha: d.meta?.githubCommitSha ?? d.uid,
      timestamp: new Date(d.created).toISOString(),
      status: stateMap[d.readyState ?? d.state] ?? 'running',
      author: d.meta?.githubCommitAuthorLogin ?? 'unknown',
      message: d.meta?.githubCommitMessage ?? d.name ?? '',
    };
  }

  async getCurrentDeployment(): Promise<DeploymentInfo> {
    const data = await this.fetch<{ deployments: VercelDeployment[] }>(
      `/v6/deployments?projectId=${this.config.projectId}&limit=1&state=READY`,
    );

    if (data.deployments.length === 0) {
      // Fall back to most recent deployment regardless of state
      const fallback = await this.fetch<{ deployments: VercelDeployment[] }>(
        `/v6/deployments?projectId=${this.config.projectId}&limit=1`,
      );
      if (fallback.deployments.length === 0) {
        throw new Error('No deployments found for project');
      }
      return this.toDeploymentInfo(fallback.deployments[0]);
    }

    return this.toDeploymentInfo(data.deployments[0]);
  }

  async listRecentDeploys(limit: number): Promise<DeploymentInfo[]> {
    const data = await this.fetch<{ deployments: VercelDeployment[] }>(
      `/v6/deployments?projectId=${this.config.projectId}&limit=${limit}`,
    );
    return data.deployments.map((d) => this.toDeploymentInfo(d));
  }

  async getTrafficDistribution(): Promise<TrafficDistribution> {
    // Vercel doesn't expose traffic split via public API in a simple way.
    // We report 100% to the current production deployment.
    const current = await this.getCurrentDeployment();
    return {
      entries: [{ target: current.sha.slice(0, 8), percentage: 100 }],
    };
  }

  async getHealthEndpoints(): Promise<EndpointHealth[]> {
    const urls = this.config.healthEndpoints ?? [];
    if (urls.length === 0) return [];

    const results = await Promise.allSettled(
      urls.map(async (url): Promise<EndpointHealth> => {
        const start = Date.now();
        try {
          const res = await fetch(url, {
            signal: AbortSignal.timeout(this.timeoutMs),
          });
          const latencyMs = Date.now() - start;
          const status: EndpointHealth['status'] =
            res.ok ? 'healthy' : res.status >= 500 ? 'down' : 'degraded';
          return { url, status, latencyMs, errorRate: res.ok ? 0 : 100 };
        } catch {
          return { url, status: 'down', latencyMs: Date.now() - start, errorRate: 100 };
        }
      }),
    );

    return results.map((r) =>
      r.status === 'fulfilled'
        ? r.value
        : { url: 'unknown', status: 'down' as const, latencyMs: 0, errorRate: 100 },
    );
  }

  async getRollbackTarget(): Promise<DeploymentInfo | null> {
    const deploys = await this.listRecentDeploys(10);
    // Find the most recent successful deployment that isn't the current one
    const current = deploys[0];
    for (let i = 1; i < deploys.length; i++) {
      if (deploys[i].status === 'succeeded' && deploys[i].sha !== current?.sha) {
        return deploys[i];
      }
    }
    return null;
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'api_call') {
      throw new Error(`Unsupported deploy live client command type: ${command.type}`);
    }

    switch (command.operation) {
      case 'deploy_status':
        return {
          current: await this.getCurrentDeployment(),
          traffic: await this.getTrafficDistribution(),
          endpoints: await this.getHealthEndpoints(),
        };
      case 'health_check':
        return { endpoints: await this.getHealthEndpoints() };
      case 'full_rollback': {
        const target = await this.getRollbackTarget();
        if (!target) {
          throw new Error('No rollback target available');
        }
        // Vercel rollback: create a new deployment from the target commit
        // This is a promote-to-production action via the Vercel API
        const data = await this.fetch<{ uid: string }>(
          `/v13/deployments/${target.sha}/promote`,
        );
        return { rolledBack: true, deploymentId: data.uid, target };
      }
      default:
        throw new Error(`Unknown deploy operation: ${command.operation}`);
    }
  }

  async evaluateCheck(check: CheckExpression): Promise<boolean> {
    const stmt = check.statement ?? '';

    if (stmt === 'deploy_health') {
      const endpoints = await this.getHealthEndpoints();
      if (endpoints.length === 0) return true;
      const maxErrorRate = Math.max(...endpoints.map((e) => e.errorRate));
      return this.compare(maxErrorRate, check.expect.operator, check.expect.value);
    }

    if (stmt === 'error_rate') {
      const endpoints = await this.getHealthEndpoints();
      if (endpoints.length === 0) return true;
      const avgErrorRate =
        endpoints.reduce((sum, e) => sum + e.errorRate, 0) / endpoints.length;
      return this.compare(avgErrorRate, check.expect.operator, check.expect.value);
    }

    return true;
  }

  listCapabilityProviders(): CapabilityProviderDescriptor[] {
    return [
      {
        id: 'vercel-deploy-live',
        kind: 'capability_provider',
        name: 'Vercel Deploy Live Provider',
        maturity: 'live_validated',
        capabilities: [
          'deploy.status.read',
          'deploy.history.read',
          'deploy.rollback',
        ],
        executionContexts: ['deploy_read', 'deploy_write'],
        targetKinds: ['application'],
        commandTypes: ['api_call'],
        supportsDryRun: true,
        supportsExecute: true,
      },
    ];
  }

  transition(_to: string): void {
    // No-op for live client — state changes happen via real API calls.
  }

  async close(): Promise<void> {
    // No persistent connections to clean up — uses fetch per request.
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
