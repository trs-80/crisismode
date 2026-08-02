// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * RDS endpoint recognition. Pure string parsing — a host that doesn't match
 * simply returns null; there are no throw paths.
 *
 * Endpoint shapes (aws partition only; .amazonaws.com.cn is out of scope):
 *   instance: <identifier>.<hash>.<region>.rds.amazonaws.com
 *   cluster:  <name>.cluster-<hash>.<region>.rds.amazonaws.com  (also cluster-ro-, cluster-custom-)
 *   proxy:    <name>.proxy-<hash>.<region>.rds.amazonaws.com
 */

export interface RdsEndpointInfo {
  type: 'instance' | 'cluster' | 'proxy';
  /** DB instance identifier (first hostname label) — instance type only */
  instanceId?: string;
  region: string;
  host: string;
}

const RDS_HOST = /^([a-z0-9-]+)\.([a-z0-9-]+)\.([a-z]{2}(?:-[a-z]+)+-\d)\.rds\.amazonaws\.com$/i;

export function parseRdsEndpoint(host: string): RdsEndpointInfo | null {
  // DNS is case-insensitive; normalize for consistent type discrimination.
  // Return normalized lowercase host for consistency.
  const normalized = host.toLowerCase();
  const m = RDS_HOST.exec(normalized);
  if (!m) return null;
  const [, first, second, region] = m;

  if (second!.startsWith('cluster-')) return { type: 'cluster', region: region!, host: normalized };
  if (second!.startsWith('proxy-')) return { type: 'proxy', region: region!, host: normalized };
  return { type: 'instance', instanceId: first!, region: region!, host: normalized };
}
