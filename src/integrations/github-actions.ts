// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * GitHub Actions integration — programmatic interface for posting
 * CrisisMode diagnosis results as PR/commit comments via the GitHub API.
 *
 * Used by the `.github/actions/diagnose` composite action and can also
 * be used directly from CI pipelines.
 */

import { formatGitHubIssue } from '../framework/notification-formatters.js';
import type { NotificationContext, GitHubIssueBody } from '../framework/notification-formatters.js';

// ── Types ──

export interface GitHubActionsConfig {
  token?: string;
  owner: string;
  repo: string;
  /** Base URL for GitHub API — override for GitHub Enterprise. */
  apiBaseUrl?: string;
}

export interface CommentResult {
  ok: boolean;
  id?: number;
  url?: string;
  error?: string;
}

export interface DiagnoseActionInputs {
  configPath?: string;
  category?: string[];
  commentOn: 'pr' | 'commit' | 'none';
  failOnUnhealthy: boolean;
  verbose: boolean;
}

// ── GitHub Actions Integration ──

export class GitHubActionsIntegration {
  private token: string | undefined;
  private owner: string;
  private repo: string;
  private apiBaseUrl: string;

  constructor(config: GitHubActionsConfig) {
    this.token = config.token ?? process.env.GITHUB_TOKEN;
    this.owner = config.owner;
    this.repo = config.repo;
    this.apiBaseUrl = config.apiBaseUrl ?? 'https://api.github.com';
  }

  /** Post a diagnosis comment on a pull request. */
  async commentOnPR(prNumber: number, ctx: NotificationContext): Promise<CommentResult> {
    this.assertToken();

    const issue = formatGitHubIssue(ctx);
    const body = this.buildCommentBody(issue);

    // Check for existing CrisisMode comment
    const existingId = await this.findExistingComment(prNumber);

    if (existingId) {
      return this.updateComment(existingId, body);
    }

    return this.createPRComment(prNumber, body);
  }

  /** Post a diagnosis comment on a commit. */
  async commentOnCommit(sha: string, ctx: NotificationContext): Promise<CommentResult> {
    this.assertToken();

    const issue = formatGitHubIssue(ctx);
    const body = this.buildCommentBody(issue);

    const url = `${this.apiBaseUrl}/repos/${this.owner}/${this.repo}/commits/${sha}/comments`;

    try {
      const response = await this.apiCall(url, 'POST', { body });
      const data = await response.json() as Record<string, unknown>;

      return {
        ok: response.ok,
        id: data.id as number | undefined,
        url: data.html_url as string | undefined,
        error: response.ok ? undefined : String(data.message ?? 'Unknown error'),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Create a GitHub issue from a diagnosis. */
  async createIssue(ctx: NotificationContext): Promise<CommentResult> {
    this.assertToken();

    const issue = formatGitHubIssue(ctx);
    const url = `${this.apiBaseUrl}/repos/${this.owner}/${this.repo}/issues`;

    try {
      const response = await this.apiCall(url, 'POST', {
        title: issue.title,
        body: issue.body,
        labels: issue.labels,
      });
      const data = await response.json() as Record<string, unknown>;

      return {
        ok: response.ok,
        id: data.number as number | undefined,
        url: data.html_url as string | undefined,
        error: response.ok ? undefined : String(data.message ?? 'Unknown error'),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Parse GitHub Actions environment to determine context. */
  static parseEnvironment(): {
    eventName: string;
    sha: string;
    ref: string;
    prNumber: number | null;
    owner: string;
    repo: string;
  } {
    const repository = process.env.GITHUB_REPOSITORY ?? '';
    const [owner, repo] = repository.split('/');

    let prNumber: number | null = null;
    const refMatch = process.env.GITHUB_REF?.match(/^refs\/pull\/(\d+)\//);
    if (refMatch) {
      prNumber = parseInt(refMatch[1], 10);
    }

    return {
      eventName: process.env.GITHUB_EVENT_NAME ?? '',
      sha: process.env.GITHUB_SHA ?? '',
      ref: process.env.GITHUB_REF ?? '',
      prNumber,
      owner: owner ?? '',
      repo: repo ?? '',
    };
  }

  // ── Internal ──

  private buildCommentBody(issue: GitHubIssueBody): string {
    return `${issue.body}\n\n<!-- crisismode-diagnosis-comment -->`;
  }

  private async findExistingComment(prNumber: number): Promise<number | null> {
    const url = `${this.apiBaseUrl}/repos/${this.owner}/${this.repo}/issues/${prNumber}/comments?per_page=100`;

    try {
      const response = await this.apiCall(url, 'GET');
      if (!response.ok) return null;

      const comments = await response.json() as Array<{ id: number; body: string }>;
      const existing = comments.find((c) => c.body.includes('crisismode-diagnosis-comment'));
      return existing?.id ?? null;
    } catch {
      return null;
    }
  }

  private async createPRComment(prNumber: number, body: string): Promise<CommentResult> {
    const url = `${this.apiBaseUrl}/repos/${this.owner}/${this.repo}/issues/${prNumber}/comments`;

    try {
      const response = await this.apiCall(url, 'POST', { body });
      const data = await response.json() as Record<string, unknown>;

      return {
        ok: response.ok,
        id: data.id as number | undefined,
        url: data.html_url as string | undefined,
        error: response.ok ? undefined : String(data.message ?? 'Unknown error'),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async updateComment(commentId: number, body: string): Promise<CommentResult> {
    const url = `${this.apiBaseUrl}/repos/${this.owner}/${this.repo}/issues/comments/${commentId}`;

    try {
      const response = await this.apiCall(url, 'PATCH', { body });
      const data = await response.json() as Record<string, unknown>;

      return {
        ok: response.ok,
        id: data.id as number | undefined,
        url: data.html_url as string | undefined,
        error: response.ok ? undefined : String(data.message ?? 'Unknown error'),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private assertToken(): void {
    if (!this.token) {
      throw new Error(
        'GITHUB_TOKEN required. Set the GITHUB_TOKEN environment variable or pass token to the constructor.',
      );
    }
  }

  private async apiCall(url: string, method: string, body?: Record<string, unknown>): Promise<Response> {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };

    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    return fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  }
}
