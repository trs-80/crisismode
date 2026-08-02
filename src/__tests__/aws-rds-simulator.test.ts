// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { RdsRecoverySimulator } from '../agent/aws-rds/simulator.js';
import { isPermissionMissing } from '../agent/aws-rds/backend.js';

describe('RdsRecoverySimulator control-plane scenarios', () => {
  it('healthy scenario reports available status and sane metrics', async () => {
    const sim = new RdsRecoverySimulator();
    sim.transition!('healthy');
    const health = await sim.getInstanceHealth();
    expect(isPermissionMissing(health)).toBe(false);
    if (!isPermissionMissing(health)) {
      expect(health.status).toBe('available');
      expect(health.vpcSecurityGroupIds.length).toBeGreaterThan(0);
    }
    const metrics = await sim.getLiveMetrics();
    if (!isPermissionMissing(metrics)) {
      expect(metrics.databaseConnections).not.toBeNull();
      expect(metrics.approxMaxConnections).not.toBeNull();
    }
  });

  it('storage_full scenario reports the status and near-zero free storage', async () => {
    const sim = new RdsRecoverySimulator();
    sim.transition!('storage_full');
    const health = await sim.getInstanceHealth();
    if (!isPermissionMissing(health)) expect(health.status).toBe('storage-full');
    const metrics = await sim.getLiveMetrics();
    if (!isPermissionMissing(metrics)) expect(metrics.freeStorageBytes).toBeLessThan(1024 * 1024 * 1024);
  });

  it('connection_saturation reports connections near the derived max', async () => {
    const sim = new RdsRecoverySimulator();
    sim.transition!('connection_saturation');
    const metrics = await sim.getLiveMetrics();
    if (!isPermissionMissing(metrics)) {
      expect(metrics.databaseConnections! / metrics.approxMaxConnections!).toBeGreaterThan(0.9);
    }
  });

  it('sg_blocked reports the DB port open to nothing relevant', async () => {
    const sim = new RdsRecoverySimulator();
    sim.transition!('sg_blocked');
    const reach = await sim.getPortReachability();
    if (!isPermissionMissing(reach)) expect(reach.openTo).toHaveLength(0);
  });

  it('maintenance_pending surfaces a pending modification and an event', async () => {
    const sim = new RdsRecoverySimulator();
    sim.transition!('maintenance_pending');
    const health = await sim.getInstanceHealth();
    if (!isPermissionMissing(health)) expect(health.pendingModifications.length).toBeGreaterThan(0);
    const events = await sim.getRecentEvents(24);
    if (!isPermissionMissing(events)) expect(events.length).toBeGreaterThan(0);
  });

  it('iam_denied returns typed permission results from every method', async () => {
    const sim = new RdsRecoverySimulator();
    sim.transition!('iam_denied');
    expect(isPermissionMissing(await sim.getInstanceHealth())).toBe(true);
    expect(isPermissionMissing(await sim.getRecentEvents(24))).toBe(true);
    expect(isPermissionMissing(await sim.getLiveMetrics())).toBe(true);
    expect(isPermissionMissing(await sim.getPortReachability())).toBe(true);
  });
});
