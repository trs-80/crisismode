// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SlackIntegration } from '../integrations/slack.js';
import type { SlackActionPayload } from '../integrations/slack.js';
import type { NotificationContext } from '../framework/notification-formatters.js';
import type { HealthAssessment } from '../types/health.js';

// ── Helpers ──

function makeHealth(status: 'healthy' | 'unhealthy' = 'unhealthy'): HealthAssessment {
  return {
    status,
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
  return { health: makeHealth() };
}

function makeApprovalPayload(actionId = 'crisismode_approve'): SlackActionPayload {
  return {
    type: 'block_actions',
    trigger_id: 'trigger-123',
    user: { id: 'U123', username: 'oncall-sre' },
    actions: [{ action_id: actionId, value: 'plan-repl-001', type: 'button' }],
    message: { ts: '1234567890.123456' },
    channel: { id: 'C123' },
  };
}

// ── Mock fetch ──

function mockFetch(responses: Record<string, unknown>[] = []) {
  let callIndex = 0;
  const fetchMock = vi.fn(async (_url: string, _opts?: RequestInit) => {
    const data = responses[callIndex] ?? { ok: true };
    callIndex++;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => data,
    } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

// ── Tests ──

describe('SlackIntegration', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
      SLACK_CHANNEL: process.env.SLACK_CHANNEL,
    };
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_CHANNEL;
  });

  afterEach(() => {
    process.env.SLACK_BOT_TOKEN = savedEnv.SLACK_BOT_TOKEN;
    process.env.SLACK_CHANNEL = savedEnv.SLACK_CHANNEL;
    vi.restoreAllMocks();
  });

  describe('connect', () => {
    it('throws without bot token', async () => {
      const slack = new SlackIntegration();
      await expect(slack.connect()).rejects.toThrow('SLACK_BOT_TOKEN required');
    });

    it('throws without channel', async () => {
      const slack = new SlackIntegration({ botToken: 'xoxb-test' });
      await expect(slack.connect()).rejects.toThrow('SLACK_CHANNEL required');
    });

    it('connects successfully with valid token', async () => {
      mockFetch([{ ok: true, user_id: 'U123' }]);
      const slack = new SlackIntegration({
        botToken: 'xoxb-test',
        channel: '#alerts',
        apiBaseUrl: 'https://test.slack.com/api',
      });

      await slack.connect();
      expect(slack.connected).toBe(true);
    });

    it('throws on auth failure', async () => {
      mockFetch([{ ok: false, error: 'invalid_auth' }]);
      const slack = new SlackIntegration({
        botToken: 'xoxb-bad',
        channel: '#alerts',
        apiBaseUrl: 'https://test.slack.com/api',
      });

      await expect(slack.connect()).rejects.toThrow('Slack auth failed');
    });

    it('reads token from env vars', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-from-env';
      process.env.SLACK_CHANNEL = '#env-channel';
      mockFetch([{ ok: true }]);

      const slack = new SlackIntegration({ apiBaseUrl: 'https://test.slack.com/api' });
      await slack.connect();
      expect(slack.connected).toBe(true);
    });
  });

  describe('disconnect', () => {
    it('sets connected to false', async () => {
      mockFetch([{ ok: true }]);
      const slack = new SlackIntegration({
        botToken: 'xoxb-test',
        channel: '#alerts',
        apiBaseUrl: 'https://test.slack.com/api',
      });
      await slack.connect();
      expect(slack.connected).toBe(true);

      await slack.disconnect();
      expect(slack.connected).toBe(false);
    });
  });

  describe('postNotification', () => {
    it('throws when not connected', async () => {
      const slack = new SlackIntegration({ botToken: 'xoxb-test', channel: '#alerts' });
      await expect(slack.postNotification(makeCtx())).rejects.toThrow('not connected');
    });

    it('posts notification with blocks', async () => {
      const fetchMock = mockFetch([
        { ok: true },
        { ok: true, channel: 'C123', ts: '123.456' },
      ]);

      const slack = new SlackIntegration({
        botToken: 'xoxb-test',
        channel: '#alerts',
        apiBaseUrl: 'https://test.slack.com/api',
      });
      await slack.connect();

      const result = await slack.postNotification(makeCtx());
      expect(result.ok).toBe(true);
      expect(result.ts).toBe('123.456');

      // Verify the API call was made with blocks
      const postCall = fetchMock.mock.calls[1];
      const body = JSON.parse(postCall[1]!.body as string);
      expect(body.channel).toBe('#alerts');
      expect(body.blocks).toBeDefined();
      expect(body.blocks.length).toBeGreaterThan(0);
      expect(body.text).toContain('Unhealthy');
    });

    it('returns error from Slack API', async () => {
      mockFetch([
        { ok: true },
        { ok: false, error: 'channel_not_found' },
      ]);

      const slack = new SlackIntegration({
        botToken: 'xoxb-test',
        channel: '#nonexistent',
        apiBaseUrl: 'https://test.slack.com/api',
      });
      await slack.connect();

      const result = await slack.postNotification(makeCtx());
      expect(result.ok).toBe(false);
      expect(result.error).toBe('channel_not_found');
    });
  });

  describe('postMessage', () => {
    it('posts a simple text message', async () => {
      const fetchMock = mockFetch([
        { ok: true },
        { ok: true, channel: 'C123', ts: '789.012' },
      ]);

      const slack = new SlackIntegration({
        botToken: 'xoxb-test',
        channel: '#alerts',
        apiBaseUrl: 'https://test.slack.com/api',
      });
      await slack.connect();

      const result = await slack.postMessage('Test message');
      expect(result.ok).toBe(true);

      const body = JSON.parse(fetchMock.mock.calls[1][1]!.body as string);
      expect(body.text).toBe('Test message');
    });

    it('allows channel override', async () => {
      const fetchMock = mockFetch([
        { ok: true },
        { ok: true, channel: 'C456', ts: '111.222' },
      ]);

      const slack = new SlackIntegration({
        botToken: 'xoxb-test',
        channel: '#alerts',
        apiBaseUrl: 'https://test.slack.com/api',
      });
      await slack.connect();

      await slack.postMessage('Override test', '#other-channel');
      const body = JSON.parse(fetchMock.mock.calls[1][1]!.body as string);
      expect(body.channel).toBe('#other-channel');
    });
  });

  describe('updateMessage', () => {
    it('updates an existing message', async () => {
      const fetchMock = mockFetch([
        { ok: true },
        { ok: true, ts: '123.456' },
      ]);

      const slack = new SlackIntegration({
        botToken: 'xoxb-test',
        channel: '#alerts',
        apiBaseUrl: 'https://test.slack.com/api',
      });
      await slack.connect();

      const result = await slack.updateMessage('123.456', 'Updated text');
      expect(result.ok).toBe(true);
      expect(result.ts).toBe('123.456');

      const body = JSON.parse(fetchMock.mock.calls[1][1]!.body as string);
      expect(body.ts).toBe('123.456');
      expect(body.text).toBe('Updated text');
    });
  });

  describe('parseActionPayload', () => {
    it('parses approve action', () => {
      const payload = makeApprovalPayload('crisismode_approve');
      const slack = new SlackIntegration();
      const decision = slack.parseActionPayload(payload);

      expect(decision).not.toBeNull();
      expect(decision!.action).toBe('approve');
      expect(decision!.planId).toBe('plan-repl-001');
      expect(decision!.userId).toBe('U123');
      expect(decision!.username).toBe('oncall-sre');
      expect(decision!.messageTs).toBe('1234567890.123456');
      expect(decision!.channelId).toBe('C123');
    });

    it('parses reject action', () => {
      const slack = new SlackIntegration();
      const decision = slack.parseActionPayload(makeApprovalPayload('crisismode_reject'));
      expect(decision!.action).toBe('reject');
    });

    it('parses details action', () => {
      const slack = new SlackIntegration();
      const decision = slack.parseActionPayload(makeApprovalPayload('crisismode_details'));
      expect(decision!.action).toBe('details');
    });

    it('returns null for unknown action', () => {
      const slack = new SlackIntegration();
      const decision = slack.parseActionPayload(makeApprovalPayload('unknown_action'));
      expect(decision).toBeNull();
    });

    it('returns null for non-block_actions type', () => {
      const slack = new SlackIntegration();
      const payload = { ...makeApprovalPayload(), type: 'message_action' as const };
      const decision = slack.parseActionPayload(payload as unknown as SlackActionPayload);
      expect(decision).toBeNull();
    });

    it('returns null for empty actions array', () => {
      const slack = new SlackIntegration();
      const payload = { ...makeApprovalPayload(), actions: [] };
      const decision = slack.parseActionPayload(payload);
      expect(decision).toBeNull();
    });
  });

  describe('handleApproval', () => {
    it('updates message with approval confirmation', async () => {
      const fetchMock = mockFetch([
        { ok: true },
        { ok: true, ts: '1234567890.123456' },
      ]);

      const slack = new SlackIntegration({
        botToken: 'xoxb-test',
        channel: '#alerts',
        apiBaseUrl: 'https://test.slack.com/api',
      });
      await slack.connect();

      const decision = slack.parseActionPayload(makeApprovalPayload())!;
      const result = await slack.handleApproval(decision);
      expect(result.ok).toBe(true);

      const body = JSON.parse(fetchMock.mock.calls[1][1]!.body as string);
      expect(body.text).toContain('approved');
    });

    it('updates message with rejection', async () => {
      const fetchMock = mockFetch([
        { ok: true },
        { ok: true, ts: '1234567890.123456' },
      ]);

      const slack = new SlackIntegration({
        botToken: 'xoxb-test',
        channel: '#alerts',
        apiBaseUrl: 'https://test.slack.com/api',
      });
      await slack.connect();

      const decision = slack.parseActionPayload(makeApprovalPayload('crisismode_reject'))!;
      const result = await slack.handleApproval(decision);
      expect(result.ok).toBe(true);

      const body = JSON.parse(fetchMock.mock.calls[1][1]!.body as string);
      expect(body.text).toContain('rejected');
    });
  });

  describe('API call handling', () => {
    it('sends correct authorization header', async () => {
      const fetchMock = mockFetch([{ ok: true }]);
      const slack = new SlackIntegration({
        botToken: 'xoxb-secret-token',
        channel: '#alerts',
        apiBaseUrl: 'https://test.slack.com/api',
      });
      await slack.connect();

      const headers = fetchMock.mock.calls[0][1]!.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer xoxb-secret-token');
    });

    it('throws on HTTP error', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      })));

      const slack = new SlackIntegration({
        botToken: 'xoxb-test',
        channel: '#alerts',
        apiBaseUrl: 'https://test.slack.com/api',
      });

      await expect(slack.connect()).rejects.toThrow('Slack API HTTP 500');
    });
  });
});
