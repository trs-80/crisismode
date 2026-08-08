// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Aaron Johnson

/**
 * Candidate URLs are verified against the live endpoints in Task 9; entries that fail
 * live validation are corrected or removed there — do not add entries without live verification.
 */

import type { CatalogEntry, ServiceTarget } from './types.js';

/** Map of known aliases to canonical ids. */
export const CATALOG_ALIASES: Record<string, string> = {
  flyio: 'fly',
  'fly.io': 'fly',
  pscale: 'planetscale',
};

/** Curated catalog of well-known services with known probe hosts and status endpoints. */
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
    id: 'neon',
    label: 'Neon',
    probeHost: 'console.neon.tech',
    probePort: 443,
    statusUrl: 'https://neonstatus.com/api/v2/summary.json',
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
    id: 'resend',
    label: 'Resend',
    probeHost: 'api.resend.com',
    probePort: 443,
    statusUrl: 'https://resend-status.com/api/v2/summary.json',
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
    id: 'planetscale',
    label: 'PlanetScale',
    probeHost: 'api.planetscale.com',
    probePort: 443,
    statusUrl: 'https://www.planetscalestatus.com/api/v2/summary.json',
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
