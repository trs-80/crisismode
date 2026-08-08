// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RemediationGuide } from '../../../types/remediation-guide.js';
import { SERVICE_STATUS_CHECK_IDS } from '../../../agent/service-status/check-ids.js';

/**
 * Generic dependency-incident response guidance, keyed to the service-status
 * agent's checkIds. Unlike the other guides in this directory, this one has
 * no single vendor console to walk — every third-party dependency has its
 * own status page — so the steps stay provider-agnostic and lean on
 * `<placeholder>` tokens the operator fills in for the service that is
 * actually failing.
 */
export const serviceStatusGuides: RemediationGuide[] = [
  {
    id: 'dependency-incident-response',
    platform: 'status-page',
    title: 'Confirm and respond to a third-party dependency incident',
    applicableFindingTypes: [SERVICE_STATUS_CHECK_IDS.statusPage, SERVICE_STATUS_CHECK_IDS.reachability],
    consoleSteps: [
      'Open the status page for <service> (e.g. https://status.<provider>.com) and confirm it lists an incident matching what CrisisMode observed.',
      'Subscribe to updates on that status page (email, RSS, or a Slack/webhook integration) so the team hears about resolution without polling.',
      "Do not ship debugging changes, redeploys, or config edits against your own systems while the incident is confirmed upstream — nothing in your app or infrastructure caused it, and changes made now are likely to get blamed for the outage's after-effects.",
      "Check your app's error handling for calls to <service>: does it retry with backoff, fail gracefully, and surface a clear error, rather than crashing or hanging the request?",
      'Note the incident-history URL for <service> (e.g. https://status.<provider>.com/history) so a future occurrence can be checked against this one.',
    ],
    expectedAfter:
      "The provider's status page confirms resolution, and CrisisMode's next scan reports the status-page and reachability checks for <service> healthy again.",
    caution:
      'This is the provider\'s incident, not yours to fix — resist the urge to redeploy or roll back your own service while it is open.',
    verifiedOn: '2026-08-08',
  },
];
