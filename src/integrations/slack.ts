// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Slack integration — post recovery proposals, health alerts, and
 * approval requests to Slack channels via the Slack Web API.
 *
 * Supports:
 * - Posting health notifications with interactive approval buttons
 * - Updating messages (e.g., after approval/rejection)
 * - Receiving approval/rejection via action payloads
 * - Channel configuration via env var or constructor
 *
 * Requires: SLACK_BOT_TOKEN and SLACK_CHANNEL env vars (or constructor opts).
 */

import type { Integration } from './index.js';
import {
  formatSlackNotification,
} from '../framework/notification-formatters.js';
import type { NotificationContext, SlackBlock } from '../framework/notification-formatters.js';

// ── Types ──

export interface SlackConfig {
  botToken?: string;
  channel?: string;
  /** Base URL for Slack API — override for testing. */
  apiBaseUrl?: string;
}

export interface SlackPostResult {
  ok: boolean;
  channel: string;
  ts: string;
  error?: string;
}

export interface SlackUpdateResult {
  ok: boolean;
  ts: string;
  error?: string;
}

export interface SlackActionPayload {
  type: 'block_actions';
  trigger_id: string;
  user: { id: string; username: string };
  actions: Array<{
    action_id: string;
    value: string;
    type: string;
  }>;
  message: { ts: string };
  channel: { id: string };
}

export interface ApprovalDecision {
  action: 'approve' | 'reject' | 'details';
  planId: string;
  userId: string;
  username: string;
  messageTs: string;
  channelId: string;
}

// ── Slack Integration ──

export class SlackIntegration implements Integration {
  name = 'slack';
  connected = false;

  private botToken: string | undefined;
  private channel: string | undefined;
  private apiBaseUrl: string;

  constructor(config?: SlackConfig) {
    this.botToken = config?.botToken ?? process.env.SLACK_BOT_TOKEN;
    this.channel = config?.channel ?? process.env.SLACK_CHANNEL;
    this.apiBaseUrl = config?.apiBaseUrl ?? 'https://slack.com/api';
  }

  async connect(): Promise<void> {
    if (!this.botToken) {
      throw new Error(
        'SLACK_BOT_TOKEN required. Set the SLACK_BOT_TOKEN environment variable or pass botToken to the constructor.',
      );
    }
    if (!this.channel) {
      throw new Error(
        'SLACK_CHANNEL required. Set the SLACK_CHANNEL environment variable or pass channel to the constructor.',
      );
    }

    // Validate token by calling auth.test
    const response = await this.apiCall('auth.test', {});
    if (!response.ok) {
      throw new Error(`Slack auth failed: ${response.error ?? 'unknown error'}`);
    }

    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  /** Post a health notification to the configured channel. */
  async postNotification(ctx: NotificationContext): Promise<SlackPostResult> {
    this.assertConnected();

    const notification = formatSlackNotification(ctx);

    const result = await this.apiCall('chat.postMessage', {
      channel: this.channel!,
      text: notification.text,
      blocks: notification.blocks,
    });

    return {
      ok: Boolean(result.ok),
      channel: String(result.channel ?? this.channel!),
      ts: String(result.ts ?? ''),
      error: result.error as string | undefined,
    };
  }

  /** Update an existing message (e.g., to mark as approved/rejected). */
  async updateMessage(
    ts: string,
    text: string,
    blocks?: SlackBlock[],
    channelOverride?: string,
  ): Promise<SlackUpdateResult> {
    this.assertConnected();

    const result = await this.apiCall('chat.update', {
      channel: channelOverride ?? this.channel!,
      ts,
      text,
      blocks: blocks ?? [],
    });

    return {
      ok: Boolean(result.ok),
      ts: String(result.ts ?? ts),
      error: result.error as string | undefined,
    };
  }

  /** Post a simple text message. */
  async postMessage(text: string, channelOverride?: string): Promise<SlackPostResult> {
    this.assertConnected();

    const result = await this.apiCall('chat.postMessage', {
      channel: channelOverride ?? this.channel!,
      text,
    });

    return {
      ok: Boolean(result.ok),
      channel: String(result.channel ?? channelOverride ?? this.channel!),
      ts: String(result.ts ?? ''),
      error: result.error as string | undefined,
    };
  }

  /** Parse an incoming Slack action payload into an approval decision. */
  parseActionPayload(payload: SlackActionPayload): ApprovalDecision | null {
    if (payload.type !== 'block_actions') return null;

    const action = payload.actions[0];
    if (!action) return null;

    const actionMap: Record<string, 'approve' | 'reject' | 'details'> = {
      crisismode_approve: 'approve',
      crisismode_reject: 'reject',
      crisismode_details: 'details',
    };

    const decision = actionMap[action.action_id];
    if (!decision) return null;

    return {
      action: decision,
      planId: action.value,
      userId: payload.user.id,
      username: payload.user.username,
      messageTs: payload.message.ts,
      channelId: payload.channel.id,
    };
  }

  /** Handle an approval decision — update the original message with outcome. */
  async handleApproval(decision: ApprovalDecision): Promise<SlackUpdateResult> {
    this.assertConnected();

    const emoji = decision.action === 'approve' ? ':white_check_mark:' : ':x:';
    const verb = decision.action === 'approve' ? 'approved' : 'rejected';

    const blocks: SlackBlock[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${emoji} Recovery plan \`${decision.planId}\` was *${verb}* by <@${decision.userId}> (${decision.username})`,
        },
      },
    ];

    return this.updateMessage(decision.messageTs, `Plan ${verb}`, blocks, decision.channelId);
  }

  // ── Internal ──

  private assertConnected(): void {
    if (!this.connected) {
      throw new Error('SlackIntegration is not connected. Call connect() first.');
    }
  }

  private async apiCall(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = `${this.apiBaseUrl}/${method}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.botToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Slack API HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json() as Record<string, unknown>;
  }
}
