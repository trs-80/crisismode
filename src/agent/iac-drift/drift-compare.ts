// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Intended-vs-observed drift comparison for Terraform-managed AWS resources.
 *
 * Pure by contract: no I/O, no AWS SDK calls. Callers supply the state-recorded
 * intent (`IacResource`) and the live-observed facts; this module only compares.
 *
 * Honesty over guessing: when the state records no intent for an attribute
 * (undefined/null), the comparator skips it rather than inventing intent.
 * `comparedAttributes` discloses exactly what was checked so callers can
 * report e.g. "compared 8 of 42 recorded attributes".
 */

import type { IacResource } from './state-parser.js';

export interface AttributeDrift {
  attribute: string;
  intended: string;
  observed: string;
}

export interface DriftComparison {
  drifts: AttributeDrift[];
  /** Attribute names this comparator actually checked (the honesty disclosure). */
  comparedAttributes: string[];
  /** Total attribute keys recorded in state for this resource — lets output say "compared 8 of 42". */
  intendedAttributeCount: number;
}

export interface ObservedRdsFacts {
  instanceClass: string;
  engine: string;
  engineVersion: string;
  multiAz: boolean;
  backupRetentionPeriod: number;
  deletionProtection: boolean;
  storageType: string;
  allocatedStorageGb: number;
}

export interface ObservedS3Facts {
  versioningEnabled: boolean;
  hasLifecycleRules: boolean;
}

export interface ObservedDynamoFacts {
  billingMode: string;
  pitrEnabled: boolean;
}

interface Pair {
  attribute: string;
  intended: unknown;
  observed: unknown;
  equal?: (i: unknown, o: unknown) => boolean;
}

function compare(pairs: Pair[], intendedAttributeCount: number): DriftComparison {
  const drifts: AttributeDrift[] = [];
  const comparedAttributes: string[] = [];
  for (const p of pairs) {
    if (p.intended === undefined || p.intended === null) continue; // state records no intent — skip, never invent
    comparedAttributes.push(p.attribute);
    const eq = p.equal ?? ((i, o) => String(i) === String(o));
    if (!eq(p.intended, p.observed)) {
      drifts.push({ attribute: p.attribute, intended: String(p.intended), observed: String(p.observed) });
    }
  }
  return { drifts, comparedAttributes, intendedAttributeCount };
}

export function compareRdsInstance(intended: IacResource, observed: ObservedRdsFacts): DriftComparison {
  const a = intended.attributes;
  const pairs: Pair[] = [
    { attribute: 'instance_class', intended: a['instance_class'], observed: observed.instanceClass },
    { attribute: 'engine', intended: a['engine'], observed: observed.engine },
    {
      attribute: 'engine_version',
      intended: a['engine_version'],
      observed: observed.engineVersion,
      // AWS reports a fuller version than Terraform's often-truncated intent
      // (e.g. intended '16.1' vs observed '16.1.3') — but a bare startsWith
      // also matches unrelated versions that share a numeral prefix (intended
      // '16.1' vs observed '16.10'). Only an exact match or a '.'-bounded
      // patch suffix counts as aligned.
      equal: (i, o) => String(o) === String(i) || String(o).startsWith(`${String(i)}.`),
    },
    { attribute: 'multi_az', intended: a['multi_az'], observed: observed.multiAz },
    { attribute: 'backup_retention_period', intended: a['backup_retention_period'], observed: observed.backupRetentionPeriod },
    { attribute: 'deletion_protection', intended: a['deletion_protection'], observed: observed.deletionProtection },
    { attribute: 'storage_type', intended: a['storage_type'], observed: observed.storageType },
    { attribute: 'allocated_storage', intended: a['allocated_storage'], observed: observed.allocatedStorageGb },
  ];
  return compare(pairs, Object.keys(a).length);
}

function s3VersioningIntent(intended: IacResource, allResources: IacResource[]): string | undefined {
  const subResource = allResources.find(
    (r) => r.type === 'aws_s3_bucket_versioning' && r.attributes['bucket'] === intended.id,
  );
  if (subResource) {
    const config = subResource.attributes['versioning_configuration'];
    const status = Array.isArray(config) ? (config[0] as { status?: unknown } | undefined)?.status : undefined;
    if (typeof status === 'string') return status;
    return undefined;
  }
  const legacy = intended.attributes['versioning'];
  const enabled = Array.isArray(legacy) ? (legacy[0] as { enabled?: unknown } | undefined)?.enabled : undefined;
  if (typeof enabled === 'boolean') return enabled ? 'Enabled' : 'Suspended';
  return undefined;
}

function s3LifecycleIntent(intended: IacResource, allResources: IacResource[]): string | undefined {
  const subResource = allResources.find(
    (r) => r.type === 'aws_s3_bucket_lifecycle_configuration' && r.attributes['bucket'] === intended.id,
  );
  if (subResource) return 'true';
  const legacy = intended.attributes['lifecycle_rule'];
  if (Array.isArray(legacy) && legacy.length > 0) return 'true';
  return undefined;
}

export function compareS3Bucket(
  intended: IacResource,
  allResources: IacResource[],
  observed: ObservedS3Facts,
): DriftComparison {
  const versioningIntent = s3VersioningIntent(intended, allResources);
  const versioningObserved = observed.versioningEnabled ? 'Enabled' : 'Suspended';
  const lifecycleIntent = s3LifecycleIntent(intended, allResources);
  const lifecycleObserved = observed.hasLifecycleRules ? 'true' : 'false';
  const pairs: Pair[] = [
    { attribute: 'versioning', intended: versioningIntent, observed: versioningObserved },
    { attribute: 'lifecycle_rule', intended: lifecycleIntent, observed: lifecycleObserved },
  ];
  return compare(pairs, Object.keys(intended.attributes).length);
}

export function compareDynamoTable(intended: IacResource, observed: ObservedDynamoFacts): DriftComparison {
  const a = intended.attributes;
  const pitr = a['point_in_time_recovery'];
  const pitrEnabled = Array.isArray(pitr) ? (pitr[0] as { enabled?: unknown } | undefined)?.enabled : undefined;
  const pairs: Pair[] = [
    { attribute: 'billing_mode', intended: a['billing_mode'], observed: observed.billingMode },
    { attribute: 'point_in_time_recovery', intended: pitrEnabled, observed: observed.pitrEnabled },
  ];
  return compare(pairs, Object.keys(a).length);
}
