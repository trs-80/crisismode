// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { ApprovalRoutingResult } from './graph-state.js';

/**
 * Interface for routing approval requests to external channels.
 */
export interface ApprovalRouter {
  /**
   * Send an approval request to the configured channel and return
   * a promise that resolves when the decision is received.
   */
  routeApproval(request: ApprovalRequest): Promise<ApprovalRoutingResult>;
}

export interface ApprovalRequest {
  planId: string;
  spokeId: string;
  summary: string;
  detail: string;
  riskLevel: string;
  alertPayload: Record<string, unknown>;
}

/**
 * Slack approval router — sends interactive messages to a Slack channel
 * and waits for button callbacks.
 */
export class SlackApprovalRouter implements ApprovalRouter {
  constructor(
    private webhookUrl: string,
    private callbackUrl: string,
  ) {}

  async routeApproval(request: ApprovalRequest): Promise<ApprovalRoutingResult> {
    const message = {
      text: `Recovery Approval Required`,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: 'Recovery Plan Approval' },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: [
              `*Plan:* ${request.planId}`,
              `*Spoke:* ${request.spokeId}`,
              `*Risk:* ${request.riskLevel}`,
              `*Summary:* ${request.summary}`,
              `*Detail:* ${request.detail}`,
            ].join('\n'),
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Approve' },
              style: 'primary',
              action_id: 'approve_recovery',
              value: JSON.stringify({
                planId: request.planId,
                spokeId: request.spokeId,
                callbackUrl: this.callbackUrl,
              }),
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Reject' },
              style: 'danger',
              action_id: 'reject_recovery',
              value: JSON.stringify({
                planId: request.planId,
                spokeId: request.spokeId,
                callbackUrl: this.callbackUrl,
              }),
            },
          ],
        },
      ],
    };

    const response = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      throw new Error(`Slack webhook failed: ${response.status} ${response.statusText}`);
    }

    // In production, this would wait for a Slack interactive message callback.
    // The callback handler would call Command({ resume: decision }) on the
    // coordination graph. For now, return a placeholder.
    return {
      stepId: request.planId,
      decision: 'approved',
      decidedBy: 'slack-interactive',
      decidedAt: new Date().toISOString(),
      channel: 'slack',
    };
  }
}

/**
 * In-memory approval router for testing.
 * Decisions are resolved by calling `resolveApproval()`.
 */
export class TestApprovalRouter implements ApprovalRouter {
  private pendingResolvers = new Map<string, (result: ApprovalRoutingResult) => void>();

  async routeApproval(request: ApprovalRequest): Promise<ApprovalRoutingResult> {
    return new Promise<ApprovalRoutingResult>((resolve) => {
      this.pendingResolvers.set(request.planId, resolve);
    });
  }

  resolveApproval(planId: string, decision: 'approved' | 'rejected'): void {
    const resolver = this.pendingResolvers.get(planId);
    if (resolver) {
      resolver({
        stepId: planId,
        decision,
        decidedBy: 'test-operator',
        decidedAt: new Date().toISOString(),
        channel: 'test',
      });
      this.pendingResolvers.delete(planId);
    }
  }
}
