// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { iamBlockedEntries } from '../cli/commands/scan.js';

describe('iamBlockedEntries', () => {
  it('maps rds_iam_permissions signals to blocked entries with hints', () => {
    const entries = iamBlockedEntries([
      { service: 'aws-rds (rds-mydb)', signals: [
        { source: 'rds_iam_permissions', detail: 'AWS check skipped — missing cloudwatch:GetMetricData' },
        { source: 'rds_instance_status', detail: 'available' },
      ]},
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.detail).toContain('cloudwatch:GetMetricData');
    expect(entries[0]!.hint).toBeTruthy();
  });

  it('dedupes identical permission gaps across findings and returns empty when none', () => {
    const sig = { source: 'rds_iam_permissions', detail: 'AWS check skipped — missing rds:DescribeEvents' };
    expect(iamBlockedEntries([
      { service: 'a', signals: [sig] }, { service: 'b', signals: [sig] },
    ])).toHaveLength(1);
    expect(iamBlockedEntries([{ service: 'a', signals: [{ source: 'pg_connection', detail: 'x' }] }])).toHaveLength(0);
  });

  it('maps iac_iam_permissions signals to blocked entries with hints', () => {
    const entries = iamBlockedEntries([
      { service: 'iac-drift', signals: [
        { source: 'iac_iam_permissions', detail: 'cannot verify aws_db_instance prod-db: IAM action rds:DescribeDBInstances not allowed' },
      ]},
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.label).toBe('iac-drift permissions');
    expect(entries[0]!.detail).toContain('IAM action rds:DescribeDBInstances not allowed');
    expect(entries[0]!.hint).toBeTruthy();
  });

  it('maps unreadable iac_state signals to blocked entries with hints', () => {
    const entries = iamBlockedEntries([
      { service: 'iac-drift', signals: [
        { source: 'iac_state', detail: 'could not read terraform state: access denied' },
      ]},
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.label).toBe('iac-drift (state unreadable)');
    expect(entries[0]!.detail).toContain('could not read');
    expect(entries[0]!.hint).toBeTruthy();
  });

  it('ignores iac_state signals whose detail is not about unreadable state', () => {
    expect(iamBlockedEntries([
      { service: 'iac-drift', signals: [{ source: 'iac_state', detail: 'state read ok, serial 42' }] },
    ])).toHaveLength(0);
  });
});
