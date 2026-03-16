// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { HumanApprovalStep } from '../types/step-types.js';

export type ApprovalDecision = 'approved' | 'skipped' | 'rejected';

/**
 * Interface for resolving human approval decisions.
 * Implementations abstract the approval transport (stdin, hub API, webhook).
 */
export interface ApprovalHandler {
  /**
   * Request a human decision for the given approval step.
   * The implementation may block (stdin), call an API (hub), or
   * register a callback (webhook) depending on the transport.
   */
  requestApproval(
    step: HumanApprovalStep,
    catalogCovered: boolean,
  ): Promise<ApprovalDecision>;
}

/**
 * Stdin-based approval handler — matches the existing requestApproval behavior.
 * Used in CLI/demo mode.
 */
export class StdinApprovalHandler implements ApprovalHandler {
  async requestApproval(
    step: HumanApprovalStep,
    catalogCovered: boolean,
  ): Promise<ApprovalDecision> {
    if (catalogCovered) {
      return 'approved';
    }

    // Dynamic import to avoid pulling readline into spoke bundles
    const { createInterface } = await import('node:readline/promises');
    const { stdin, stdout } = await import('node:process');

    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const answer = await rl.question(
        '\n    Enter your decision (approve/skip/reject): ',
      );
      const normalized = answer.trim().toLowerCase();
      if (normalized === 'approve' || normalized === 'a' || normalized === 'yes' || normalized === 'y') {
        return 'approved';
      }
      if (normalized === 'skip' || normalized === 's') {
        return 'skipped';
      }
      return 'rejected';
    } finally {
      rl.close();
    }
  }
}

/**
 * Hub-based approval handler — delegates to the hub's approval routing.
 * The hub sends the request to Slack/PagerDuty/etc. and waits for a callback.
 */
export class HubApprovalHandler implements ApprovalHandler {
  constructor(
    private hubEndpoint: string,
    private spokeId: string,
  ) {}

  async requestApproval(
    step: HumanApprovalStep,
    catalogCovered: boolean,
  ): Promise<ApprovalDecision> {
    if (catalogCovered) {
      return 'approved';
    }

    const response = await fetch(`${this.hubEndpoint}/api/v1/approvals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        spokeId: this.spokeId,
        stepId: step.stepId,
        presentation: step.presentation,
        approvers: step.approvers,
        requiredApprovals: step.requiredApprovals,
        timeout: step.timeout,
        timeoutAction: step.timeoutAction,
      }),
    });

    if (!response.ok) {
      throw new Error(`Hub approval request failed: ${response.status} ${response.statusText}`);
    }

    const result = await response.json() as { decision: ApprovalDecision };
    return result.decision;
  }
}

/**
 * Webhook-based approval handler — receives decisions via HTTP callback.
 * Used when the spoke runs an HTTP server that listens for approval callbacks.
 */
export class WebhookApprovalHandler implements ApprovalHandler {
  private pendingResolvers = new Map<string, (decision: ApprovalDecision) => void>();

  async requestApproval(
    step: HumanApprovalStep,
    catalogCovered: boolean,
  ): Promise<ApprovalDecision> {
    if (catalogCovered) {
      return 'approved';
    }

    return new Promise<ApprovalDecision>((resolve) => {
      this.pendingResolvers.set(step.stepId, resolve);
    });
  }

  /**
   * Called by the webhook HTTP handler when a decision arrives.
   */
  resolveApproval(stepId: string, decision: ApprovalDecision): void {
    const resolver = this.pendingResolvers.get(stepId);
    if (resolver) {
      resolver(decision);
      this.pendingResolvers.delete(stepId);
    }
  }
}
