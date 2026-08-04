// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { compareRdsInstance, compareS3Bucket, compareDynamoTable } from '../agent/iac-drift/drift-compare.js';
import type { IacResource } from '../agent/iac-drift/state-parser.js';

const rds = (attrs: Record<string, unknown>): IacResource => ({
  type: 'aws_db_instance', name: 'main', id: 'prod-db', region: 'us-east-1', attributes: attrs,
});
const RDS_ATTRS = {
  id: 'prod-db', instance_class: 'db.t3.medium', engine: 'postgres', engine_version: '16',
  multi_az: false, backup_retention_period: 7, deletion_protection: true,
  storage_type: 'gp3', allocated_storage: 20, tags: {},
};
const OBSERVED_ALIGNED = {
  instanceClass: 'db.t3.medium', engine: 'postgres', engineVersion: '16.4', multiAz: false,
  backupRetentionPeriod: 7, deletionProtection: true, storageType: 'gp3', allocatedStorageGb: 20,
};

describe('compareRdsInstance', () => {
  it('reports no drift when aligned (engine_version matches by prefix)', () => {
    const r = compareRdsInstance(rds(RDS_ATTRS), OBSERVED_ALIGNED);
    expect(r.drifts).toEqual([]);
    expect(r.comparedAttributes).toContain('instance_class');
    expect(r.intendedAttributeCount).toBe(Object.keys(RDS_ATTRS).length);
  });

  it('reports each drifted attribute with intended and observed values', () => {
    const r = compareRdsInstance(rds(RDS_ATTRS), {
      ...OBSERVED_ALIGNED, instanceClass: 'db.t3.large', deletionProtection: false,
    });
    expect(r.drifts).toEqual([
      { attribute: 'instance_class', intended: 'db.t3.medium', observed: 'db.t3.large' },
      { attribute: 'deletion_protection', intended: 'true', observed: 'false' },
    ]);
  });

  it('skips attributes the state does not record instead of inventing intent', () => {
    const { deletion_protection: _dp, ...rest } = RDS_ATTRS;
    const r = compareRdsInstance(rds(rest), { ...OBSERVED_ALIGNED, deletionProtection: false });
    expect(r.drifts).toEqual([]);
    expect(r.comparedAttributes).not.toContain('deletion_protection');
  });

  it('flags engine_version drift when observed is a different version that merely shares a numeral prefix', () => {
    // '16.10'.startsWith('16.1') is true — a naive prefix check would wrongly
    // call this aligned. Only an exact match or a '.'-bounded patch suffix counts.
    const r = compareRdsInstance(
      rds({ ...RDS_ATTRS, engine_version: '16.1' }),
      { ...OBSERVED_ALIGNED, engineVersion: '16.10' },
    );
    expect(r.drifts).toEqual([
      { attribute: 'engine_version', intended: '16.1', observed: '16.10' },
    ]);
  });

  it('does not flag engine_version drift when observed is a genuine patch-version match', () => {
    const r = compareRdsInstance(
      rds({ ...RDS_ATTRS, engine_version: '16.1' }),
      { ...OBSERVED_ALIGNED, engineVersion: '16.1.3' },
    );
    expect(r.drifts).toEqual([]);
  });
});

describe('compareS3Bucket', () => {
  const bucket: IacResource = {
    type: 'aws_s3_bucket', name: 'uploads', id: 'user-uploads',
    attributes: { id: 'user-uploads', bucket: 'user-uploads' },
  };
  it('folds aws_s3_bucket_versioning (provider v4+) into the bucket intent', () => {
    const versioning: IacResource = {
      type: 'aws_s3_bucket_versioning', name: 'uploads', id: 'user-uploads',
      attributes: { id: 'user-uploads', bucket: 'user-uploads', versioning_configuration: [{ status: 'Enabled' }] },
    };
    const r = compareS3Bucket(bucket, [bucket, versioning], { versioningEnabled: false, hasLifecycleRules: false });
    expect(r.drifts).toEqual([{ attribute: 'versioning', intended: 'Enabled', observed: 'Suspended' }]);
  });
  it('reads legacy inline versioning (provider v3)', () => {
    const legacy: IacResource = { ...bucket, attributes: { ...bucket.attributes, versioning: [{ enabled: true }] } };
    const r = compareS3Bucket(legacy, [legacy], { versioningEnabled: true, hasLifecycleRules: false });
    expect(r.drifts).toEqual([]);
    expect(r.comparedAttributes).toContain('versioning');
  });
  it('skips versioning when neither inline nor sub-resource intent exists', () => {
    const r = compareS3Bucket(bucket, [bucket], { versioningEnabled: false, hasLifecycleRules: false });
    expect(r.drifts).toEqual([]);
    expect(r.comparedAttributes).not.toContain('versioning');
  });
});

describe('compareDynamoTable', () => {
  const table: IacResource = {
    type: 'aws_dynamodb_table', name: 'sessions', id: 'sessions',
    attributes: { id: 'sessions', billing_mode: 'PAY_PER_REQUEST', point_in_time_recovery: [{ enabled: true }] },
  };
  it('detects PITR drift', () => {
    const r = compareDynamoTable(table, { billingMode: 'PAY_PER_REQUEST', pitrEnabled: false });
    expect(r.drifts).toEqual([{ attribute: 'point_in_time_recovery', intended: 'true', observed: 'false' }]);
  });
});
