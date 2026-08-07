// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RemediationGuide } from '../../../types/remediation-guide.js';

/**
 * OpenAI Platform remediation paths, keyed to the llm-provider agent's
 * checkIds. Console paths must be re-verified by a human before verifiedOn
 * is updated — see CONTRIBUTING.md.
 */
export const openaiGuides: RemediationGuide[] = [
  {
    id: 'openai-rotate-key',
    platform: 'openai-platform',
    title: 'Rotate your OpenAI API key',
    applicableFindingTypes: ['llm-provider.key_valid'],
    url: 'https://platform.openai.com/api-keys',
    consoleSteps: [
      'Open the OpenAI platform API keys page, and check the organization and project selector at the top matches the one your app bills to.',
      'Choose Create new secret key, scope it to the project your app uses, and name it after the app and environment.',
      'Copy the key immediately — the platform shows the full value only once.',
      'Set OPENAI_API_KEY to the new value everywhere the app runs (hosting provider environment variables, local .env, CI secrets), then redeploy.',
      'Return to the API keys page and revoke the old key only after the new one is live.',
    ],
    cliEquivalent: 'curl -s https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY"',
    expectedAfter: 'The key check passes on the next `crisismode scan`, and API calls stop returning 401.',
    caution:
      'Revoking a key takes effect immediately — anything still using it starts failing. Deploy the new key everywhere first.',
    verifiedOn: '2026-08-05',
  },
  {
    id: 'openai-usage-limits',
    platform: 'openai-platform',
    title: 'Check OpenAI usage tier and rate limits',
    applicableFindingTypes: ['llm-provider.rate_limit_headroom', 'llm-provider.quota_billing'],
    url: 'https://platform.openai.com/settings/organization/limits',
    consoleSteps: [
      'Open Settings → Organization → Limits to see your usage tier and the per-model requests-per-minute and tokens-per-minute limits.',
      'Distinguish the two 429 causes: an `insufficient_quota` error means the organization is out of credit (see the billing guide), while a plain rate-limit 429 means you are sending too fast.',
      'Make the app wait for the retry-after header on 429 responses rather than retrying immediately.',
      'Raise the monthly budget or usage limit on the same page if the ceiling is a budget cap rather than a tier limit.',
    ],
    cliEquivalent:
      'curl -s -D - -o /dev/null https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY" | grep -i x-ratelimit',
    expectedAfter: 'Rate-limit headroom stays above 20% during peak traffic and 429 responses stop.',
    verifiedOn: '2026-08-05',
  },
  {
    id: 'openai-billing',
    platform: 'openai-platform',
    title: 'Restore OpenAI billing or credit balance',
    applicableFindingTypes: ['llm-provider.quota_billing'],
    url: 'https://platform.openai.com/settings/organization/billing/overview',
    consoleSteps: [
      'Open Settings → Organization → Billing → Overview and check the credit balance and payment method.',
      'Add to the credit balance, then enable auto-recharge so the balance cannot reach zero mid-incident.',
      'Check that the project your key belongs to has not hit its own budget limit under Settings → Project → Limits.',
      'Re-run `crisismode scan` to confirm the quota/billing check has cleared.',
    ],
    expectedAfter: 'Calls stop failing with `insufficient_quota`, and the quota/billing check reports healthy.',
    verifiedOn: '2026-08-05',
  },
];
