// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect } from 'vitest';
import { IacDriftSimulator } from '../agent/iac-drift/simulator.js';

describe('IacDriftSimulator', () => {
  it('drifted: RDS attribute drift, missing bucket, aligned table, unknown elasticache', async () => {
    const sim = new IacDriftSimulator('drifted');
    const resources = await sim.listManagedResources();
    const byType = Object.fromEntries(resources.map((r) => [r.type, r]));

    const rdsDrift = await sim.getResourceDrift(byType.aws_db_instance!);
    expect(rdsDrift).toMatchObject({
      drifts: expect.arrayContaining([
        expect.objectContaining({ attribute: 'instance_class', intended: 'db.t3.medium', observed: 'db.t3.large' }),
      ]),
    });

    expect(await sim.checkResourceExistence(byType.aws_s3_bucket!)).toEqual({ existence: 'missing' });
    expect(await sim.checkResourceExistence(byType.aws_dynamodb_table!)).toEqual({ existence: 'exists' });
    expect(await sim.getResourceDrift(byType.aws_dynamodb_table!)).toMatchObject({ drifts: [] });
    expect(await sim.checkResourceExistence(byType.aws_elasticache_cluster!)).toMatchObject({ existence: 'unknown' });
    expect(await sim.getResourceDrift(byType.aws_elasticache_cluster!)).toBeNull();

    const status = await sim.getStateStatus();
    expect(status.readable).toBe(true);
    expect(status.source).toBe('local');
  });

  it('aligned: no drift and nothing missing', async () => {
    const sim = new IacDriftSimulator('aligned');
    const resources = await sim.listManagedResources();
    for (const r of resources.filter((x) => x.type !== 'aws_elasticache_cluster')) {
      expect(await sim.checkResourceExistence(r)).toEqual({ existence: 'exists' });
      const drift = await sim.getResourceDrift(r);
      if (drift) expect(drift).toMatchObject({ drifts: [] });
    }
  });

  it('state_unreadable: status is unreadable and no resources are listed', async () => {
    const sim = new IacDriftSimulator('state_unreadable');
    const status = await sim.getStateStatus();
    expect(status.readable).toBe(false);
    expect(status.reason).toBeTruthy();
    expect(await sim.listManagedResources()).toEqual([]);
  });

  it('supports transition() and evaluateCheck counters', async () => {
    const sim = new IacDriftSimulator('drifted');
    expect(await sim.evaluateCheck({ type: 'structured_command', statement: 'iac_drift_count', expect: { operator: 'gte', value: 1 } })).toBe(true);
    sim.transition('aligned');
    expect(await sim.evaluateCheck({ type: 'structured_command', statement: 'iac_drift_count', expect: { operator: 'eq', value: 0 } })).toBe(true);
  });
});
