// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Aaron Johnson

/**
 * Every entry below has passed Task 9 live validation: its `statusUrl` fetch
 * returns a body `parseStatuspageSummary` can classify, and its `probeHost`
 * is DNS-resolvable (`src/__tests__/service-status-live.test.ts`, run with
 * CRISISMODE_LIVE_TESTS=1). Do not add an entry without running that suite
 * against it first — three of the original 15 candidates looked correct but
 * turned out to be non-Statuspage-v2 endpoints; see the removal note below.
 */

import type { CatalogEntry, ServiceTarget } from './types.js';

/** Map of known aliases to canonical ids. */
export const CATALOG_ALIASES: Record<string, string> = {
  flyio: 'fly',
  'fly.io': 'fly',
};

/**
 * Curated catalog of well-known services with known probe hosts and status
 * endpoints. Three candidates from the original 15 were removed after Task 9
 * live validation — their `statusUrl` fetches succeed, but the body is not a
 * Statuspage-v2 summary, so `parseStatuspageSummary` can never classify it:
 *
 * - `neon`: neonstatus.com is hosted on status.io (a different vendor, whose
 *   API is pageId/RSS-based, not `/api/v2/summary.json`). Confirmed
 *   `/api/v2/summary.json` 404s; no Statuspage-format endpoint exists there.
 * - `resend`: resend-status.com is hosted on incident.io (confirmed via its
 *   CSP header and page footer), whose `/api/v2/summary.json` omits the
 *   `incidents` key entirely when there are no active incidents instead of
 *   returning `[]`, so it never parses as Statuspage v2.
 * - `planetscale`: www.planetscalestatus.com is also hosted on incident.io,
 *   same schema mismatch as `resend`.
 *
 * All three of these were flagged in advance as likely to fail (task-9-brief),
 * and did. Re-adding any of them requires either a genuinely Statuspage-v2
 * endpoint for that provider, or a second `statusFormat` this catalog and
 * `checker.ts` don't support today.
 */
export const SERVICE_CATALOG: readonly CatalogEntry[] = [
  {
    id: 'github',
    label: 'GitHub',
    probeHost: 'api.github.com',
    probePort: 443,
    statusUrl: 'https://www.githubstatus.com/api/v2/summary.json',
    statusFormat: 'statuspage_v2',
  },
  {
    id: 'stripe',
    label: 'Stripe',
    probeHost: 'api.stripe.com',
    probePort: 443,
    statusUrl: 'https://www.stripestatus.com/api/v2/summary.json',
    statusFormat: 'statuspage_v2',
  },
  {
    id: 'vercel',
    label: 'Vercel',
    probeHost: 'vercel.com',
    probePort: 443,
    statusUrl: 'https://www.vercel-status.com/api/v2/summary.json',
    statusFormat: 'statuspage_v2',
  },
  {
    id: 'netlify',
    label: 'Netlify',
    probeHost: 'api.netlify.com',
    probePort: 443,
    statusUrl: 'https://www.netlifystatus.com/api/v2/summary.json',
    statusFormat: 'statuspage_v2',
  },
  {
    id: 'supabase',
    label: 'Supabase',
    probeHost: 'supabase.com',
    probePort: 443,
    statusUrl: 'https://status.supabase.com/api/v2/summary.json',
    statusFormat: 'statuspage_v2',
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare',
    probeHost: 'api.cloudflare.com',
    probePort: 443,
    statusUrl: 'https://www.cloudflarestatus.com/api/v2/summary.json',
    statusFormat: 'statuspage_v2',
  },
  {
    id: 'npm',
    label: 'npm',
    probeHost: 'registry.npmjs.org',
    probePort: 443,
    statusUrl: 'https://status.npmjs.org/api/v2/summary.json',
    statusFormat: 'statuspage_v2',
  },
  {
    id: 'twilio',
    label: 'Twilio',
    probeHost: 'api.twilio.com',
    probePort: 443,
    statusUrl: 'https://status.twilio.com/api/v2/summary.json',
    statusFormat: 'statuspage_v2',
  },
  {
    id: 'sendgrid',
    label: 'SendGrid',
    probeHost: 'api.sendgrid.com',
    probePort: 443,
    statusUrl: 'https://status.sendgrid.com/api/v2/summary.json',
    statusFormat: 'statuspage_v2',
  },
  {
    id: 'render',
    label: 'Render',
    probeHost: 'api.render.com',
    probePort: 443,
    statusUrl: 'https://status.render.com/api/v2/summary.json',
    statusFormat: 'statuspage_v2',
  },
  {
    id: 'fly',
    label: 'Fly.io',
    probeHost: 'api.fly.io',
    probePort: 443,
    statusUrl: 'https://status.flyio.net/api/v2/summary.json',
    statusFormat: 'statuspage_v2',
  },
  {
    id: 'upstash',
    label: 'Upstash',
    probeHost: 'api.upstash.com',
    probePort: 443,
    statusUrl: 'https://status.upstash.com/api/v2/summary.json',
    statusFormat: 'statuspage_v2',
  },
];

/**
 * Resolve a catalog entry by id or alias, case-insensitively.
 * Returns undefined if not found.
 */
export function resolveCatalogEntry(
  idOrAlias: string,
): CatalogEntry | undefined {
  const normalized = idOrAlias.toLowerCase();

  // Check aliases first
  if (normalized in CATALOG_ALIASES) {
    const canonicalId = CATALOG_ALIASES[normalized];
    return SERVICE_CATALOG.find((e) => e.id === canonicalId);
  }

  // Check direct id match
  return SERVICE_CATALOG.find((e) => e.id === normalized);
}

/**
 * Resolve a raw config entry (catalog id/alias, or an explicit host) into a
 * ServiceTarget. String input checks the catalog first; a miss is treated as
 * a raw domain to probe (port 443, no status source). Object input is never
 * catalog-checked — it is an explicit host/port pair.
 *
 * Lives here (pure, dependency-free) rather than in checker.ts so callers
 * that only need to resolve a name — the config loader, and the scan/watch
 * target synthesis — don't have to pull in checker.ts's runtime graph
 * (node:dns/promises, triage) just to reach this function. checker.ts
 * re-exports it for existing callers that already need the heavier module.
 */
export function resolveTarget(
  input: string | { host: string; port?: number },
): ServiceTarget {
  if (typeof input === 'string') {
    const entry = resolveCatalogEntry(input);
    if (entry) return { id: entry.id, entry };
    return { id: input, host: input, port: 443 };
  }
  return { id: input.host, host: input.host, port: input.port ?? 443 };
}
