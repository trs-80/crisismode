// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Stable check identifiers for the aws-rds control-plane checks. Names track
 * the diagnosis finding `source` values one-to-one so a reader can move
 * between a finding and its guidance without a translation table.
 */
export const AWS_RDS_CHECK_IDS = {
  storageFull: 'aws-rds.storage_full',
  connectionSaturation: 'aws-rds.connection_saturation',
  securityGroup: 'aws-rds.security_group',
  instanceStatus: 'aws-rds.instance_status',
} as const;

const BY_SOURCE: Record<string, string> = {
  rds_storage: AWS_RDS_CHECK_IDS.storageFull,
  rds_connection_saturation: AWS_RDS_CHECK_IDS.connectionSaturation,
  rds_security_group: AWS_RDS_CHECK_IDS.securityGroup,
  rds_instance_status: AWS_RDS_CHECK_IDS.instanceStatus,
};

/**
 * The checkId for a control-plane finding source, or undefined for sources
 * with no guidance anchor (backup/snapshot/IAM findings are diagnosed but not
 * remediated through a console guide).
 */
export function checkIdForRdsSource(source: string): string | undefined {
  return BY_SOURCE[source];
}
