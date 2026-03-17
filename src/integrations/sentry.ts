// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Sentry integration — fetches error events, detects error spikes,
 * and enriches diagnosis with error context from Sentry's API.
 *
 * Requires: SENTRY_DSN environment variable (or constructor option).
 * Optional: SENTRY_AUTH_TOKEN for the Sentry Web API.
 *
 * DSN format: https://<key>@<org>.ingest.sentry.io/<project-id>
 */

import type { ErrorTrackingIntegration, ErrorEvent, ErrorSpikeInfo } from './index.js';

// ── Types ──

export interface SentryConfig {
  dsn?: string;
  authToken?: string;
  /** Base URL for Sentry API — override for self-hosted. */
  apiBaseUrl?: string;
  /** Organization slug. */
  organization?: string;
  /** Project slug. */
  project?: string;
}

export interface SentryEnrichment {
  recentErrors: ErrorEvent[];
  errorSpike: ErrorSpikeInfo | null;
  summary: string;
}

interface SentryIssue {
  id: string;
  title: string;
  count: string;
  firstSeen: string;
  lastSeen: string;
  metadata?: { value?: string };
  stats?: { '24h'?: Array<[number, number]> };
  shortId?: string;
  project?: { slug?: string };
}

interface ParsedDSN {
  key: string;
  host: string;
  projectId: string;
  organization: string;
}

// ── Sentry Integration ──

export class SentryIntegration implements ErrorTrackingIntegration {
  name = 'sentry';
  connected = false;

  private dsn: string | undefined;
  private authToken: string | undefined;
  private apiBaseUrl: string;
  private organization: string | undefined;
  private project: string | undefined;
  private parsedDSN: ParsedDSN | null = null;

  constructor(options?: SentryConfig) {
    this.dsn = options?.dsn ?? process.env.SENTRY_DSN;
    this.authToken = options?.authToken ?? process.env.SENTRY_AUTH_TOKEN;
    this.apiBaseUrl = options?.apiBaseUrl ?? 'https://sentry.io/api/0';
    this.organization = options?.organization ?? process.env.SENTRY_ORG;
    this.project = options?.project ?? process.env.SENTRY_PROJECT;
  }

  async connect(): Promise<void> {
    if (!this.dsn && !this.authToken) {
      throw new Error(
        'SENTRY_DSN or SENTRY_AUTH_TOKEN required. Set environment variables or pass options to the constructor.',
      );
    }

    if (this.dsn) {
      this.parsedDSN = parseDSN(this.dsn);
      if (!this.organization) {
        this.organization = this.parsedDSN.organization;
      }
    }

    // Validate connectivity if we have an auth token
    if (this.authToken && this.organization) {
      const response = await this.apiCall(
        `/organizations/${this.organization}/`,
        'GET',
      );
      if (!response.ok) {
        throw new Error(`Sentry API authentication failed: HTTP ${response.status}`);
      }
    }

    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  /** Fetch recent error events from Sentry. */
  async getRecentErrors(since: string, limit: number): Promise<ErrorEvent[]> {
    this.assertConnected();

    if (!this.authToken || !this.organization) {
      return [];
    }

    const sinceDate = new Date(since);
    const query = `lastSeen:>${sinceDate.toISOString()}`;

    const projectParam = this.project ? `&project=${this.project}` : '';
    const url = `/organizations/${this.organization}/issues/?query=${encodeURIComponent(query)}&limit=${limit}&sort=date${projectParam}`;

    const response = await this.apiCall(url, 'GET');
    if (!response.ok) return [];

    const issues = await response.json() as SentryIssue[];

    return issues.map((issue) => ({
      id: issue.id,
      title: issue.title,
      count: parseInt(issue.count, 10) || 0,
      firstSeen: issue.firstSeen,
      lastSeen: issue.lastSeen,
      release: issue.metadata?.value,
    }));
  }

  /** Detect error rate spikes by comparing recent vs baseline rates. */
  async getErrorSpike(): Promise<ErrorSpikeInfo | null> {
    this.assertConnected();

    if (!this.authToken || !this.organization) {
      return null;
    }

    // Fetch issues sorted by frequency
    const projectParam = this.project ? `&project=${this.project}` : '';
    const url = `/organizations/${this.organization}/issues/?sort=freq&limit=10&query=is:unresolved${projectParam}&statsPeriod=24h`;

    const response = await this.apiCall(url, 'GET');
    if (!response.ok) return null;

    const issues = await response.json() as SentryIssue[];
    if (issues.length === 0) return null;

    // Calculate rates from 24h stats
    const topErrors: ErrorEvent[] = issues.slice(0, 5).map((issue) => ({
      id: issue.id,
      title: issue.title,
      count: parseInt(issue.count, 10) || 0,
      firstSeen: issue.firstSeen,
      lastSeen: issue.lastSeen,
    }));

    const totalCount = topErrors.reduce((sum, e) => sum + e.count, 0);

    // Simple spike detection: if total errors in top 5 > 100, consider it a spike
    // Real implementation would compare against a rolling baseline
    const currentRate = totalCount / 24; // errors per hour
    const baselineRate = currentRate * 0.3; // rough baseline estimate
    const spikeMultiplier = baselineRate > 0 ? currentRate / baselineRate : 1;

    if (spikeMultiplier < 2) return null;

    return {
      currentRate,
      baselineRate,
      spikeMultiplier: Math.round(spikeMultiplier * 10) / 10,
      topErrors,
    };
  }

  /**
   * Enrich a diagnosis with Sentry error context.
   * Returns recent errors and spike info formatted for AI consumption.
   */
  async enrich(lookbackMinutes = 30): Promise<SentryEnrichment> {
    const since = new Date(Date.now() - lookbackMinutes * 60 * 1000).toISOString();

    const [recentErrors, errorSpike] = await Promise.all([
      this.getRecentErrors(since, 20).catch(() => [] as ErrorEvent[]),
      this.getErrorSpike().catch(() => null),
    ]);

    const summaryParts: string[] = [];

    if (recentErrors.length > 0) {
      summaryParts.push(`${recentErrors.length} recent error(s) in the last ${lookbackMinutes} minutes.`);
      const topThree = recentErrors.slice(0, 3);
      for (const err of topThree) {
        summaryParts.push(`  - ${err.title} (${err.count} occurrences)`);
      }
    } else {
      summaryParts.push('No recent errors in Sentry.');
    }

    if (errorSpike) {
      summaryParts.push(
        `Error spike detected: ${errorSpike.spikeMultiplier}x above baseline (${errorSpike.currentRate.toFixed(1)} errors/hour).`,
      );
    }

    return {
      recentErrors,
      errorSpike,
      summary: summaryParts.join('\n'),
    };
  }

  /**
   * Format Sentry context as text for AI prompt enrichment.
   */
  formatForAI(enrichment: SentryEnrichment): string {
    const parts: string[] = [];
    parts.push('\nSentry Error Context:');
    parts.push(enrichment.summary);

    if (enrichment.recentErrors.length > 0) {
      parts.push('\nRecent Errors:');
      for (const err of enrichment.recentErrors.slice(0, 10)) {
        parts.push(`  [${err.count}x] ${err.title} (first: ${err.firstSeen}, last: ${err.lastSeen})`);
      }
    }

    if (enrichment.errorSpike) {
      parts.push(`\nError Spike: ${enrichment.errorSpike.spikeMultiplier}x above baseline`);
      parts.push(`  Current rate: ${enrichment.errorSpike.currentRate.toFixed(1)} errors/hour`);
      parts.push(`  Baseline rate: ${enrichment.errorSpike.baselineRate.toFixed(1)} errors/hour`);
    }

    return parts.join('\n');
  }

  // ── Internal ──

  private assertConnected(): void {
    if (!this.connected) {
      throw new Error('SentryIntegration is not connected. Call connect() first.');
    }
  }

  private async apiCall(path: string, method: string): Promise<Response> {
    const url = `${this.apiBaseUrl}${path}`;
    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };

    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }

    return fetch(url, { method, headers });
  }
}

// ── DSN Parser ──

export function parseDSN(dsn: string): ParsedDSN {
  try {
    const url = new URL(dsn);
    const key = url.username;
    const host = url.host;
    const projectId = url.pathname.replace(/\//g, '');
    // Extract org from host: <org>.ingest.sentry.io
    const orgMatch = host.match(/^([^.]+)\.ingest/);
    const organization = orgMatch?.[1] ?? '';

    return { key, host, projectId, organization };
  } catch {
    throw new Error(`Invalid Sentry DSN: ${dsn}`);
  }
}
