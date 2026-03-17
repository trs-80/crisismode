// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GitHubActionsIntegration } from '../integrations/github-actions.js';
import type { NotificationContext } from '../framework/notification-formatters.js';
import type { HealthAssessment } from '../types/health.js';

// ── Helpers ──

function makeHealth(): HealthAssessment {
  return {
    status: 'unhealthy',
    confidence: 0.87,
    summary: 'PostgreSQL replication lag exceeds threshold',
    observedAt: '2026-03-17T12:00:00.000Z',
    signals: [
      { source: 'replication', status: 'critical', detail: 'Lag: 45s', observedAt: '2026-03-17T12:00:00.000Z' },
    ],
    recommendedActions: ['Check replication status'],
  };
}

function makeCtx(): NotificationContext {
  return {
    health: makeHealth(),
    diagnosis: {
      status: 'identified',
      scenario: 'replication_lag',
      confidence: 0.92,
      findings: [
        { source: 'pg', observation: 'Replication lag detected', severity: 'critical' },
      ],
      diagnosticPlanNeeded: false,
    },
  };
}

function mockFetch(responses: Array<{ ok: boolean; status?: number; body: unknown }>) {
  let callIndex = 0;
  const fetchMock = vi.fn(async (_url: string, _opts?: RequestInit) => {
    const resp = responses[callIndex] ?? { ok: true, status: 200, body: {} };
    callIndex++;
    return {
      ok: resp.ok,
      status: resp.status ?? (resp.ok ? 200 : 400),
      json: async () => resp.body,
    } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

// ── Tests ──

describe('GitHubActionsIntegration', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
      GITHUB_EVENT_NAME: process.env.GITHUB_EVENT_NAME,
      GITHUB_SHA: process.env.GITHUB_SHA,
      GITHUB_REF: process.env.GITHUB_REF,
    };
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    vi.restoreAllMocks();
  });

  describe('commentOnPR', () => {
    it('creates a new comment when none exists', async () => {
      const fetchMock = mockFetch([
        { ok: true, body: [] },                                    // findExistingComment
        { ok: true, body: { id: 42, html_url: 'https://github.com/comment/42' } }, // createPRComment
      ]);

      const gh = new GitHubActionsIntegration({
        token: 'ghp-test',
        owner: 'test-org',
        repo: 'test-repo',
        apiBaseUrl: 'https://api.test.github.com',
      });

      const result = await gh.commentOnPR(123, makeCtx());
      expect(result.ok).toBe(true);
      expect(result.id).toBe(42);
      expect(result.url).toBe('https://github.com/comment/42');

      // Verify correct API calls
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [listUrl] = fetchMock.mock.calls[0];
      expect(listUrl).toContain('/issues/123/comments');
      const [createUrl] = fetchMock.mock.calls[1];
      expect(createUrl).toContain('/issues/123/comments');
    });

    it('updates existing comment', async () => {
      const fetchMock = mockFetch([
        { ok: true, body: [{ id: 99, body: 'old report\n<!-- crisismode-diagnosis-comment -->' }] },
        { ok: true, body: { id: 99, html_url: 'https://github.com/comment/99' } },
      ]);

      const gh = new GitHubActionsIntegration({
        token: 'ghp-test',
        owner: 'test-org',
        repo: 'test-repo',
        apiBaseUrl: 'https://api.test.github.com',
      });

      const result = await gh.commentOnPR(123, makeCtx());
      expect(result.ok).toBe(true);
      expect(result.id).toBe(99);

      // Should use PATCH for update
      const [updateUrl, updateOpts] = fetchMock.mock.calls[1];
      expect(updateUrl).toContain('/issues/comments/99');
      expect(updateOpts!.method).toBe('PATCH');
    });

    it('throws without token', async () => {
      const gh = new GitHubActionsIntegration({
        owner: 'test-org',
        repo: 'test-repo',
      });

      await expect(gh.commentOnPR(123, makeCtx())).rejects.toThrow('GITHUB_TOKEN required');
    });

    it('returns error on API failure', async () => {
      mockFetch([
        { ok: true, body: [] },
        { ok: false, status: 403, body: { message: 'Forbidden' } },
      ]);

      const gh = new GitHubActionsIntegration({
        token: 'ghp-test',
        owner: 'test-org',
        repo: 'test-repo',
        apiBaseUrl: 'https://api.test.github.com',
      });

      const result = await gh.commentOnPR(123, makeCtx());
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Forbidden');
    });
  });

  describe('commentOnCommit', () => {
    it('posts a comment on a commit', async () => {
      const fetchMock = mockFetch([
        { ok: true, body: { id: 55, html_url: 'https://github.com/commit-comment/55' } },
      ]);

      const gh = new GitHubActionsIntegration({
        token: 'ghp-test',
        owner: 'test-org',
        repo: 'test-repo',
        apiBaseUrl: 'https://api.test.github.com',
      });

      const result = await gh.commentOnCommit('abc123', makeCtx());
      expect(result.ok).toBe(true);
      expect(result.id).toBe(55);

      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain('/commits/abc123/comments');
    });

    it('handles network errors', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => {
        throw new Error('Network error');
      }));

      const gh = new GitHubActionsIntegration({
        token: 'ghp-test',
        owner: 'test-org',
        repo: 'test-repo',
      });

      const result = await gh.commentOnCommit('abc123', makeCtx());
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Network error');
    });
  });

  describe('createIssue', () => {
    it('creates an issue with correct labels', async () => {
      const fetchMock = mockFetch([
        { ok: true, body: { number: 7, html_url: 'https://github.com/issues/7' } },
      ]);

      const gh = new GitHubActionsIntegration({
        token: 'ghp-test',
        owner: 'test-org',
        repo: 'test-repo',
        apiBaseUrl: 'https://api.test.github.com',
      });

      const result = await gh.createIssue(makeCtx());
      expect(result.ok).toBe(true);
      expect(result.id).toBe(7);

      const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
      expect(body.title).toContain('CrisisMode');
      expect(body.labels).toContain('crisismode');
      expect(body.labels).toContain('health:unhealthy');
    });
  });

  describe('parseEnvironment', () => {
    it('parses PR context', () => {
      process.env.GITHUB_REPOSITORY = 'test-org/test-repo';
      process.env.GITHUB_EVENT_NAME = 'pull_request';
      process.env.GITHUB_SHA = 'abc123';
      process.env.GITHUB_REF = 'refs/pull/42/merge';

      const env = GitHubActionsIntegration.parseEnvironment();
      expect(env.eventName).toBe('pull_request');
      expect(env.sha).toBe('abc123');
      expect(env.prNumber).toBe(42);
      expect(env.owner).toBe('test-org');
      expect(env.repo).toBe('test-repo');
    });

    it('parses push context (no PR)', () => {
      process.env.GITHUB_REPOSITORY = 'test-org/test-repo';
      process.env.GITHUB_EVENT_NAME = 'push';
      process.env.GITHUB_SHA = 'def456';
      process.env.GITHUB_REF = 'refs/heads/main';

      const env = GitHubActionsIntegration.parseEnvironment();
      expect(env.eventName).toBe('push');
      expect(env.prNumber).toBeNull();
    });

    it('handles missing environment variables', () => {
      delete process.env.GITHUB_REPOSITORY;
      delete process.env.GITHUB_EVENT_NAME;
      delete process.env.GITHUB_SHA;
      delete process.env.GITHUB_REF;

      const env = GitHubActionsIntegration.parseEnvironment();
      expect(env.owner).toBe('');
      expect(env.repo).toBe('');
      expect(env.eventName).toBe('');
      expect(env.prNumber).toBeNull();
    });
  });

  describe('API call details', () => {
    it('sends correct headers', async () => {
      const fetchMock = mockFetch([
        { ok: true, body: [] },
        { ok: true, body: { id: 1 } },
      ]);

      const gh = new GitHubActionsIntegration({
        token: 'ghp-secret',
        owner: 'test-org',
        repo: 'test-repo',
        apiBaseUrl: 'https://api.test.github.com',
      });

      await gh.commentOnPR(1, makeCtx());

      const headers = fetchMock.mock.calls[0][1]!.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer ghp-secret');
      expect(headers.Accept).toBe('application/vnd.github+json');
      expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    });

    it('includes comment body with crisismode marker', async () => {
      const fetchMock = mockFetch([
        { ok: true, body: [] },
        { ok: true, body: { id: 1 } },
      ]);

      const gh = new GitHubActionsIntegration({
        token: 'ghp-test',
        owner: 'test-org',
        repo: 'test-repo',
        apiBaseUrl: 'https://api.test.github.com',
      });

      await gh.commentOnPR(1, makeCtx());

      const body = JSON.parse(fetchMock.mock.calls[1][1]!.body as string);
      expect(body.body).toContain('crisismode-diagnosis-comment');
      expect(body.body).toContain('Health Assessment');
    });

    it('reads token from env when not provided', async () => {
      process.env.GITHUB_TOKEN = 'ghp-from-env';
      const fetchMock = mockFetch([
        { ok: true, body: [] },
        { ok: true, body: { id: 1 } },
      ]);

      const gh = new GitHubActionsIntegration({
        owner: 'test-org',
        repo: 'test-repo',
        apiBaseUrl: 'https://api.test.github.com',
      });

      await gh.commentOnPR(1, makeCtx());

      const headers = fetchMock.mock.calls[0][1]!.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer ghp-from-env');
    });
  });
});
