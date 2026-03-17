// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * External integration interfaces.
 *
 * Defines contracts for integrating CrisisMode with the tools operators
 * already use: deploy platforms, error trackers, source control, and
 * AI provider status pages.
 *
 * Each interface is implemented by a concrete adapter (e.g., GitHubIntegration,
 * SentryIntegration). Adapters are registered with the IntegrationRegistry
 * so agents and the framework can discover available integrations at runtime.
 */

// ── Base interface ──

/** Base interface for all external integrations. */
export interface Integration {
  name: string;
  connected: boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

// ── Deploy platform integration ──

/** Deploy platform integration — Vercel, Fly, Render, Cloudflare, etc. */
export interface DeployPlatformIntegration extends Integration {
  listRecentDeploys(limit: number): Promise<DeployInfo[]>;
  getDeployStatus(deployId: string): Promise<DeployInfo>;
  triggerRollback(deployId: string): Promise<RollbackResult>;
}

export interface DeployInfo {
  id: string;
  sha: string;
  status: 'building' | 'deploying' | 'ready' | 'failed' | 'cancelled';
  createdAt: string;
  url?: string;
  author?: string;
  message?: string;
}

export interface RollbackResult {
  success: boolean;
  deployId: string;
  message: string;
}

// ── Error tracking integration ──

/** Error tracking integration — Sentry, Datadog, etc. */
export interface ErrorTrackingIntegration extends Integration {
  getRecentErrors(since: string, limit: number): Promise<ErrorEvent[]>;
  getErrorSpike(): Promise<ErrorSpikeInfo | null>;
}

export interface ErrorEvent {
  id: string;
  title: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  release?: string;
}

export interface ErrorSpikeInfo {
  currentRate: number;
  baselineRate: number;
  spikeMultiplier: number;
  topErrors: ErrorEvent[];
}

// ── Source control integration ──

/** Source control integration — GitHub, GitLab, etc. */
export interface SourceControlIntegration extends Integration {
  getRecentCommits(limit: number): Promise<CommitInfo[]>;
  getDeployHistory(limit: number): Promise<DeployInfo[]>;
  getCIStatus(sha: string): Promise<CIStatus>;
}

export interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  timestamp: string;
}

export interface CIStatus {
  status: 'pending' | 'success' | 'failure' | 'cancelled';
  checks: Array<{ name: string; status: string; url?: string }>;
}

// ── AI provider status integration ──

/** AI provider status integration — monitors API availability. */
export interface AiProviderStatusIntegration extends Integration {
  getProviderStatus(): Promise<AiProviderStatusInfo>;
}

export interface AiProviderStatusInfo {
  provider: string;
  status: 'operational' | 'degraded' | 'outage';
  incidents: Array<{ title: string; status: string; updatedAt: string }>;
  latencyMs?: number;
}

// ── Integration registry ──

/**
 * Registry for managing external integrations.
 * Agents and framework components query this to discover what
 * external tools are available and connected.
 */
export class IntegrationRegistry {
  private integrations = new Map<string, Integration>();

  /** Register an integration by name. */
  register(integration: Integration): void {
    this.integrations.set(integration.name, integration);
  }

  /** Retrieve a typed integration by name, or undefined if not registered. */
  get<T extends Integration>(name: string): T | undefined {
    return this.integrations.get(name) as T | undefined;
  }

  /** List all integrations that are currently connected. */
  listConnected(): Integration[] {
    return [...this.integrations.values()].filter((i) => i.connected);
  }

  /** List all registered integrations regardless of connection state. */
  listAll(): Integration[] {
    return [...this.integrations.values()];
  }

  /** Connect all registered integrations. Logs errors but does not throw. */
  async connectAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.integrations.values()].map((i) => i.connect()),
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('Integration connect failed:', result.reason);
      }
    }
  }

  /** Disconnect all registered integrations. */
  async disconnectAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.integrations.values()].map((i) => i.disconnect()),
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('Integration disconnect failed:', result.reason);
      }
    }
  }
}
