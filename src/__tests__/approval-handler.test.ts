// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  StdinApprovalHandler,
  HubApprovalHandler,
  WebhookApprovalHandler,
} from '../framework/approval-handler.js';
import type { HumanApprovalStep } from '../types/step-types.js';

function makeApprovalStep(stepId = 'step-approval-1'): HumanApprovalStep {
  return {
    stepId,
    type: 'human_approval',
    name: 'Test approval',
    approvers: [{ role: 'database_owner', required: true }],
    requiredApprovals: 1,
    presentation: {
      summary: 'Test summary',
      detail: 'Test detail',
      proposedActions: ['Action 1'],
      alternatives: [{ action: 'skip', description: 'Skip it' }],
    },
    timeout: 'PT15M',
    timeoutAction: 'escalate',
  };
}

describe('approval-handler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('StdinApprovalHandler', () => {
    it('returns approved when catalogCovered is true', async () => {
      const handler = new StdinApprovalHandler();
      const result = await handler.requestApproval(makeApprovalStep(), true);
      expect(result).toBe('approved');
    });
  });

  describe('HubApprovalHandler', () => {
    it('returns approved when catalogCovered is true', async () => {
      const handler = new HubApprovalHandler('https://hub.example.com', 'spoke-1');
      const result = await handler.requestApproval(makeApprovalStep(), true);
      expect(result).toBe('approved');
    });

    it('calls fetch with correct URL when not catalog-covered', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ decision: 'approved' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const handler = new HubApprovalHandler('https://hub.example.com', 'spoke-1');
      const step = makeApprovalStep();
      const result = await handler.requestApproval(step, false);

      expect(result).toBe('approved');
      expect(mockFetch).toHaveBeenCalledOnce();
      expect(mockFetch).toHaveBeenCalledWith(
        'https://hub.example.com/api/v1/approvals',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      // Verify the body contains expected fields
      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.spokeId).toBe('spoke-1');
      expect(callBody.stepId).toBe(step.stepId);
    });
  });

  describe('WebhookApprovalHandler', () => {
    it('returns approved when catalogCovered is true', async () => {
      const handler = new WebhookApprovalHandler();
      const result = await handler.requestApproval(makeApprovalStep(), true);
      expect(result).toBe('approved');
    });

    it('resolveApproval resolves the pending promise', async () => {
      const handler = new WebhookApprovalHandler();
      const step = makeApprovalStep('step-webhook-1');

      // Start the approval request (will block until resolved)
      const approvalPromise = handler.requestApproval(step, false);

      // Resolve it via the callback
      handler.resolveApproval('step-webhook-1', 'approved');

      const result = await approvalPromise;
      expect(result).toBe('approved');
    });
  });
});
