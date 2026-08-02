// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Pure helpers for the RDS live client's control-plane reads.
 * Kept free of AWS SDK types so they're unit-testable without AWS.
 */

/**
 * Approximate memory (in GiB) per RDS instance class, used to derive the
 * documented default `max_connections` formula. Not exhaustive — unknown
 * classes return null rather than guessing.
 */
const INSTANCE_CLASS_MEMORY_GIB: Record<string, number> = {
  'db.t3.micro': 1,
  'db.t3.small': 2,
  'db.t3.medium': 4,
  'db.t3.large': 8,
  'db.t4g.micro': 1,
  'db.t4g.small': 2,
  'db.t4g.medium': 4,
  'db.t4g.large': 8,
  'db.m5.large': 8,
  'db.m5.xlarge': 16,
  'db.m5.2xlarge': 32,
  'db.m6g.large': 8,
  'db.m6g.xlarge': 16,
  'db.r5.large': 16,
  'db.r5.xlarge': 32,
  'db.r6g.large': 16,
  'db.r6g.xlarge': 32,
};

/**
 * Approximate max_connections using the RDS default formula:
 * LEAST(memBytes / 9531392, 5000). This is an approximation — actual
 * values depend on the parameter group and engine. Returns null for
 * instance classes not in the static memory map.
 */
export function approxMaxConnections(instanceClass: string): number | null {
  const gib = INSTANCE_CLASS_MEMORY_GIB[instanceClass];
  if (gib === undefined) return null;
  return Math.min(Math.floor((gib * 1024 ** 3) / 9531392), 5000);
}

export interface SgPermission {
  FromPort?: number | undefined;
  ToPort?: number | undefined;
  IpProtocol?: string | undefined;
  IpRanges?: Array<{ CidrIp?: string | undefined }> | undefined;
  UserIdGroupPairs?: Array<{ GroupId?: string | undefined }> | undefined;
}

/**
 * Collects CIDRs and security-group ids whose rule covers dbPort
 * (protocol 'tcp' with a matching range, or all-protocol '-1').
 */
export function summarizeSgRules(dbPort: number, permissions: SgPermission[]): string[] {
  const out: string[] = [];
  for (const perm of permissions) {
    const isAllProtocol = perm.IpProtocol === '-1';
    const isTcpInRange = perm.IpProtocol === 'tcp'
      && perm.FromPort !== undefined
      && perm.ToPort !== undefined
      && dbPort >= perm.FromPort
      && dbPort <= perm.ToPort;
    if (!isAllProtocol && !isTcpInRange) continue;

    for (const range of perm.IpRanges ?? []) {
      if (range.CidrIp) out.push(range.CidrIp);
    }
    for (const pair of perm.UserIdGroupPairs ?? []) {
      if (pair.GroupId) out.push(pair.GroupId);
    }
  }
  return out;
}

/**
 * Detects the AWS access-denied error family across services: AccessDenied,
 * AccessDeniedException (IAM-gated APIs), UnauthorizedOperation (EC2-style),
 * and the "is not authorized to perform" message some services emit.
 */
export function isAccessDeniedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = err.name ?? '';
  if (name === 'AccessDenied' || name === 'AccessDeniedException' || name === 'UnauthorizedOperation') {
    return true;
  }
  return /is not authorized to perform/i.test(err.message ?? '');
}
