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
});
