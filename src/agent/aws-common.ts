// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Shared AWS utilities for all AWS agents.
 *
 * Handles dynamic SDK imports (graceful when not installed) and
 * credential validation via STS GetCallerIdentity.
 */

import type * as StsSdkModule from '@aws-sdk/client-sts';
import type { ResolvedTarget } from '../config/schema.js';

export interface AwsCredentialResult {
  valid: boolean;
  accountId: string;
  region: string;
  /** Why validation failed — populated only when valid is false. */
  reason?: string;
}

/** A live-client check that failed because an IAM action is not allowed. */
export interface PermissionMissing {
  permissionMissing: string;
}

export function isPermissionMissing(v: unknown): v is PermissionMissing {
  return typeof v === 'object' && v !== null && 'permissionMissing' in v;
}

/**
 * Dynamically import an AWS SDK package. Returns null if the package
 * is not installed — callers use this to degrade gracefully.
 */
export async function tryImportAws<T>(pkg: string): Promise<T | null> {
  try {
    return await import(pkg) as T;
  } catch {
    return null;
  }
}

/**
 * Validate AWS credentials by calling STS GetCallerIdentity.
 * Returns account/region info on success, or { valid: false } if
 * credentials are missing, expired, or the SDK is not installed.
 */
export async function resolveAwsCredentials(opts?: {
  region?: string | undefined;
  profile?: string | undefined;
}): Promise<AwsCredentialResult> {
  const region = opts?.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
  const invalid = (reason: string): AwsCredentialResult => ({ valid: false, accountId: '', region, reason });

  const sts = await tryImportAws<typeof StsSdkModule>('@aws-sdk/client-sts');
  if (!sts) return invalid('@aws-sdk/client-sts is not installed');

  try {
    const client = new sts.STSClient({
      region,
      ...(opts?.profile ? { profile: opts.profile } : {}),
    });
    const resp = await client.send(new sts.GetCallerIdentityCommand({}));
    return {
      valid: true,
      accountId: resp.Account ?? '',
      region,
    };
  } catch (err) {
    return invalid(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Extract AWS resource identifiers from a resolved target.
 */
export function resolveAwsTarget(target: ResolvedTarget): {
  region: string;
  bucket?: string | undefined;
  table?: string | undefined;
  instanceId?: string | undefined;
  profile?: string | undefined;
} {
  if (target.aws) return target.aws;
  // Fallback: convention-based mapping from primary fields
  return {
    region: target.primary.host,
    bucket: target.primary.database,
    table: target.primary.database,
    instanceId: target.primary.database,
  };
}
