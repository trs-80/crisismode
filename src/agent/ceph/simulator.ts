// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type {
  CephBackend,
  CephClusterStatus,
  CephOSDInfo,
  CephPGStatus,
  CephPoolStats,
  CephHealthDetail,
} from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';

export type SimulatorState = 'degraded' | 'recovering' | 'recovered';

export class CephSimulator implements CephBackend {
  private state: SimulatorState = 'degraded';

  transition(to: string): void {
    this.state = to as SimulatorState;
  }

  async getClusterStatus(): Promise<CephClusterStatus> {
    switch (this.state) {
      case 'degraded':
        return {
          health: 'HEALTH_ERR',
          monCount: 3,
          osdCount: 6,
          osdUp: 4,
          osdIn: 4,
          pgCount: 256,
          pgHealthy: 200,
          pgDegraded: 48,
          pgRecovering: 8,
          usedBytes: 914_760_908_800,   // ~852GB
          totalBytes: 1_076_189_306_880, // ~1003GB
          usagePercent: 85.0,
        };
      case 'recovering':
        return {
          health: 'HEALTH_WARN',
          monCount: 3,
          osdCount: 6,
          osdUp: 5,
          osdIn: 5,
          pgCount: 256,
          pgHealthy: 206,
          pgDegraded: 20,
          pgRecovering: 30,
          usedBytes: 807_142_318_080,   // ~752GB
          totalBytes: 1_076_189_306_880,
          usagePercent: 75.0,
        };
      case 'recovered':
        return {
          health: 'HEALTH_OK',
          monCount: 3,
          osdCount: 5,
          osdUp: 5,
          osdIn: 5,
          pgCount: 256,
          pgHealthy: 256,
          pgDegraded: 0,
          pgRecovering: 0,
          usedBytes: 699_523_049_472,   // ~651GB
          totalBytes: 1_076_189_306_880,
          usagePercent: 65.0,
        };
    }
  }

  async getOSDTree(): Promise<CephOSDInfo[]> {
    const baseOSDs: CephOSDInfo[] = [
      { id: 0, name: 'osd.0', host: 'ceph-node-01', status: 'up', inCluster: true, weight: 1.0, reweight: 1.0, usedBytes: 171_798_691_840, totalBytes: 214_748_364_800, utilization: 80.0 },
      { id: 1, name: 'osd.1', host: 'ceph-node-01', status: 'up', inCluster: true, weight: 1.0, reweight: 1.0, usedBytes: 161_061_273_600, totalBytes: 214_748_364_800, utilization: 75.0 },
      { id: 2, name: 'osd.2', host: 'ceph-node-02', status: 'up', inCluster: true, weight: 1.0, reweight: 1.0, usedBytes: 182_536_110_080, totalBytes: 214_748_364_800, utilization: 85.0 },
      { id: 3, name: 'osd.3', host: 'ceph-node-02', status: 'down', inCluster: false, weight: 1.0, reweight: 0.0, usedBytes: 0, totalBytes: 214_748_364_800, utilization: 0 },
      { id: 4, name: 'osd.4', host: 'ceph-node-03', status: 'up', inCluster: true, weight: 1.0, reweight: 1.0, usedBytes: 193_273_528_320, totalBytes: 214_748_364_800, utilization: 90.0 },
      { id: 5, name: 'osd.5', host: 'ceph-node-03', status: 'down', inCluster: false, weight: 1.0, reweight: 0.0, usedBytes: 0, totalBytes: 214_748_364_800, utilization: 0 },
    ];

    switch (this.state) {
      case 'degraded':
        return baseOSDs;
      case 'recovering':
        return baseOSDs.map((osd) => {
          if (osd.id === 3) {
            return { ...osd, status: 'up' as const, inCluster: true, reweight: 0.5, usedBytes: 64_424_509_440, utilization: 30.0 };
          }
          if (osd.id === 5) {
            return osd; // still down
          }
          return { ...osd, utilization: osd.utilization * 0.9, usedBytes: Math.round(osd.usedBytes * 0.9) };
        });
      case 'recovered':
        return baseOSDs
          .filter((osd) => osd.id !== 5) // osd.5 removed
          .map((osd) => {
            if (osd.id === 3) {
              return { ...osd, status: 'up' as const, inCluster: true, reweight: 1.0, usedBytes: 139_886_637_056, utilization: 65.1 };
            }
            return { ...osd, status: 'up' as const, inCluster: true, utilization: 65.0, usedBytes: 139_586_437_120 };
          });
    }
  }

  async getPGStatus(): Promise<CephPGStatus[]> {
    switch (this.state) {
      case 'degraded':
        return [
          { pgId: '1.0', state: 'active+clean', up: [0, 1, 2], acting: [0, 1, 2], objectCount: 1200 },
          { pgId: '1.1', state: 'active+degraded+undersized', up: [0, 2], acting: [0, 2], objectCount: 980 },
          { pgId: '1.2', state: 'active+degraded+undersized', up: [1, 4], acting: [1, 4], objectCount: 1100 },
          { pgId: '1.3', state: 'active+clean', up: [0, 1, 4], acting: [0, 1, 4], objectCount: 870 },
          { pgId: '2.0', state: 'active+degraded+undersized', up: [2, 4], acting: [2, 4], objectCount: 760 },
          { pgId: '2.1', state: 'active+clean', up: [0, 2, 4], acting: [0, 2, 4], objectCount: 1050 },
        ];
      case 'recovering':
        return [
          { pgId: '1.0', state: 'active+clean', up: [0, 1, 2], acting: [0, 1, 2], objectCount: 1200 },
          { pgId: '1.1', state: 'active+recovering', up: [0, 2, 3], acting: [0, 2, 3], objectCount: 980 },
          { pgId: '1.2', state: 'active+recovering', up: [1, 3, 4], acting: [1, 3, 4], objectCount: 1100 },
          { pgId: '1.3', state: 'active+clean', up: [0, 1, 4], acting: [0, 1, 4], objectCount: 870 },
          { pgId: '2.0', state: 'active+degraded+undersized', up: [2, 4], acting: [2, 4], objectCount: 760 },
          { pgId: '2.1', state: 'active+clean', up: [0, 2, 4], acting: [0, 2, 4], objectCount: 1050 },
        ];
      case 'recovered':
        return [
          { pgId: '1.0', state: 'active+clean', up: [0, 1, 2], acting: [0, 1, 2], objectCount: 1200 },
          { pgId: '1.1', state: 'active+clean', up: [0, 2, 3], acting: [0, 2, 3], objectCount: 980 },
          { pgId: '1.2', state: 'active+clean', up: [1, 3, 4], acting: [1, 3, 4], objectCount: 1100 },
          { pgId: '1.3', state: 'active+clean', up: [0, 1, 4], acting: [0, 1, 4], objectCount: 870 },
          { pgId: '2.0', state: 'active+clean', up: [0, 2, 4], acting: [0, 2, 4], objectCount: 760 },
          { pgId: '2.1', state: 'active+clean', up: [0, 2, 4], acting: [0, 2, 4], objectCount: 1050 },
        ];
    }
  }

  async getPoolStats(): Promise<CephPoolStats[]> {
    switch (this.state) {
      case 'degraded':
        return [
          { name: 'rbd', id: 1, size: 3, minSize: 2, pgCount: 128, usedBytes: 601_295_421_440, maxBytes: 691_201_744_896, percentUsed: 87.0 },
          { name: 'cephfs_data', id: 2, size: 3, minSize: 2, pgCount: 128, usedBytes: 313_465_487_360, maxBytes: 482_344_304_640, percentUsed: 65.0 },
        ];
      case 'recovering':
        return [
          { name: 'rbd', id: 1, size: 3, minSize: 2, pgCount: 128, usedBytes: 528_482_304_000, maxBytes: 691_201_744_896, percentUsed: 76.5 },
          { name: 'cephfs_data', id: 2, size: 3, minSize: 2, pgCount: 128, usedBytes: 278_660_014_080, maxBytes: 482_344_304_640, percentUsed: 57.8 },
        ];
      case 'recovered':
        return [
          { name: 'rbd', id: 1, size: 3, minSize: 2, pgCount: 128, usedBytes: 449_181_949_952, maxBytes: 691_201_744_896, percentUsed: 65.0 },
          { name: 'cephfs_data', id: 2, size: 3, minSize: 2, pgCount: 128, usedBytes: 241_172_152_320, maxBytes: 482_344_304_640, percentUsed: 50.0 },
        ];
    }
  }

  async getHealthDetail(): Promise<CephHealthDetail> {
    switch (this.state) {
      case 'degraded':
        return {
          checks: [
            { type: 'OSD_DOWN', severity: 'HEALTH_ERR', summary: '2 osds down', detail: 'osd.3 (ceph-node-02), osd.5 (ceph-node-03) are down' },
            { type: 'PG_DEGRADED', severity: 'HEALTH_ERR', summary: '48 pgs degraded', detail: '48 placement groups are active+degraded+undersized due to missing OSD replicas' },
            { type: 'POOL_NEAR_FULL', severity: 'HEALTH_WARN', summary: 'pool rbd is near full', detail: 'Pool rbd usage is at 87.0%, above the near-full threshold of 85%' },
          ],
        };
      case 'recovering':
        return {
          checks: [
            { type: 'OSD_DOWN', severity: 'HEALTH_WARN', summary: '1 osd down', detail: 'osd.5 (ceph-node-03) is down' },
            { type: 'PG_DEGRADED', severity: 'HEALTH_WARN', summary: '20 pgs degraded', detail: '20 placement groups are still degraded, 30 recovering' },
          ],
        };
      case 'recovered':
        return { checks: [] };
    }
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'structured_command') {
      throw new Error(`Unsupported Ceph simulator command type: ${command.type}`);
    }

    switch (command.operation) {
      case 'cluster_status':
        return {
          clusterStatus: await this.getClusterStatus(),
          osdTree: await this.getOSDTree(),
          pgStatus: await this.getPGStatus(),
          poolStats: await this.getPoolStats(),
          healthDetail: await this.getHealthDetail(),
        };
      case 'osd_reweight':
        this.transition('recovering');
        return { reweighted: true, osd: command.parameters?.osd, weight: command.parameters?.weight };
      case 'osd_remove':
        return { removed: true, osd: command.parameters?.osd };
      case 'pg_repair':
        this.transition('recovered');
        return { repaired: true, pgCount: command.parameters?.pgCount };
      case 'pool_quota_set':
        return { quotaSet: true, pool: command.parameters?.pool, maxBytes: command.parameters?.maxBytes };
      default:
        return { simulated: true, operation: command.operation, parameters: command.parameters };
    }
  }

  async evaluateCheck(check: CheckExpression): Promise<boolean> {
    const stmt = check.statement ?? '';

    if (stmt === 'cluster_health') {
      const status = await this.getClusterStatus();
      return this.compare(status.health, check.expect.operator, check.expect.value);
    }

    if (stmt === 'osd_up_count') {
      const status = await this.getClusterStatus();
      return this.compare(status.osdUp, check.expect.operator, check.expect.value);
    }

    if (stmt === 'pg_degraded_count') {
      const status = await this.getClusterStatus();
      return this.compare(status.pgDegraded, check.expect.operator, check.expect.value);
    }

    if (stmt === 'usage_percent') {
      const status = await this.getClusterStatus();
      return this.compare(status.usagePercent, check.expect.operator, check.expect.value);
    }

    return true;
  }

  listCapabilityProviders(): CapabilityProviderDescriptor[] {
    return [
      {
        id: 'ceph-simulator-admin',
        kind: 'capability_provider',
        name: 'Ceph Simulator Admin Provider',
        maturity: 'simulator_only',
        capabilities: ['storage.osd.reweight', 'storage.osd.remove', 'storage.pg.repair', 'storage.pool.quota.set'],
        executionContexts: ['ceph_admin'],
        targetKinds: ['ceph'],
        commandTypes: ['structured_command'],
        supportsDryRun: true,
        supportsExecute: true,
      },
    ];
  }

  async close(): Promise<void> {}

  private compare(actual: unknown, operator: string, expected: unknown): boolean {
    const a = Number(actual);
    const e = Number(expected);

    if (Number.isNaN(a) || Number.isNaN(e)) {
      const sa = String(actual);
      const se = String(expected);
      switch (operator) {
        case 'eq': return sa === se;
        case 'neq': return sa !== se;
        default: return false;
      }
    }

    switch (operator) {
      case 'eq': return a === e;
      case 'neq': return a !== e;
      case 'gt': return a > e;
      case 'gte': return a >= e;
      case 'lt': return a < e;
      case 'lte': return a <= e;
      default: return false;
    }
  }
}
