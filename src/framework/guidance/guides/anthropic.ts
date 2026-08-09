// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RemediationGuide } from '../../../types/remediation-guide.js';

/**
 * Anthropic Console remediation paths, keyed to the llm-provider agent's
 * checkIds. Console paths must be re-verified by a human before verifiedOn
 * is updated — see CONTRIBUTING.md.
 */
export const anthropicGuides: RemediationGuide[] = [
  {
    id: 'anthropic-rotate-key',
    platform: 'anthropic-console',
    title: 'Rotate your Anthropic API key',
    applicableFindingTypes: ['llm-provider.key_valid'],
    url: 'https://platform.claude.com/settings/keys',
    consoleSteps: [
      'Open the Claude Console (platform.claude.com — formerly console.anthropic.com) and sign in to the workspace your app uses.',
      'Go to Settings → API keys → Create Key, and name it after the app and environment (e.g. "myapp-production").',
      'Copy the key immediately — the console shows the full value only once.',
      'Set ANTHROPIC_API_KEY to the new value everywhere the app runs (hosting provider environment variables, local .env, CI secrets), then redeploy.',
      'Return to Settings → API keys and delete the old key only after the new one is live.',
    ],
    cliEquivalent:
      'curl -s https://api.anthropic.com/v1/models -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01"',
    expectedAfter:
      'The key check passes on the next `crisismode scan`, and API calls stop returning 401 authentication_error.',
    caution:
      'Deleting the old key takes effect immediately — anything still using it starts failing. Deploy the new key everywhere first.',
    verifiedOn: '2026-08-05',
  },
  {
    id: 'anthropic-rate-limits',
    platform: 'anthropic-console',
    title: 'Check and raise your Anthropic rate limits',
    applicableFindingTypes: ['llm-provider.rate_limit_headroom'],
    url: 'https://platform.claude.com/settings/limits',
    consoleSteps: [
      'Open the Claude Console (platform.claude.com) → Settings → Limits to see your usage tier and the per-model requests-per-minute and tokens-per-minute limits.',
      'Compare those limits against the headroom CrisisMode reported — the limit that runs out first is the one to act on.',
      'Make the app handle 429 responses by waiting for the number of seconds in the retry-after header instead of retrying immediately.',
      'To raise the limits, advance your usage tier by adding credits in Settings → Billing; for sustained higher limits, contact Anthropic sales from the same page.',
    ],
    cliEquivalent:
      'curl -s -D - -o /dev/null https://api.anthropic.com/v1/models -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" | grep -i anthropic-ratelimit',
    expectedAfter:
      'Rate-limit headroom stays above 20% during peak traffic and 429 responses stop appearing in application logs.',
    verifiedOn: '2026-08-05',
  },
  {
    id: 'anthropic-billing-credits',
    platform: 'anthropic-console',
    title: 'Restore Anthropic billing or credit balance',
    applicableFindingTypes: ['llm-provider.quota_billing'],
    url: 'https://platform.claude.com/settings/billing',
    consoleSteps: [
      'Open the Claude Console (platform.claude.com) → Settings → Billing and check the current credit balance.',
      'Confirm the workspace has a valid payment method attached.',
      'Buy credits, then enable auto-reload so the balance cannot reach zero mid-incident.',
      'Re-run `crisismode scan` to confirm the quota/billing check has cleared.',
    ],
    expectedAfter:
      'API calls stop failing with billing or credit errors, and the quota/billing check reports healthy.',
    verifiedOn: '2026-08-05',
  },
];
