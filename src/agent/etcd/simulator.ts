// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type {
  EtcdBackend,
  EtcdClusterHealth,
  EtcdMemberInfo,
  EtcdAlarm,
  EtcdEndpointStatus,
} from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';

export type SimulatorState = 'degraded' | 'recovering' | 'recovered';

export class EtcdSimulator implements EtcdBackend {
  private state: SimulatorState = 'degraded';

  transition(to: string): void {
    this.state = to as SimulatorState;
  }

  async getClusterHealth(): Promise<EtcdClusterHealth> {
    switch (this.state) {
      case 'degraded':
        return { healthy: false, members: 3, leader: 'member-1', raftTerm: 847 };
      case 'recovering':
        return { healthy: false, members: 2, leader: 'member-1', raftTerm: 848 };
      case 'recovered':
        return { healthy: true, members: 3, leader: 'member-1', raftTerm: 849 };
    }
  }

  async getMemberList(): Promise<EtcdMemberInfo[]> {
    const members: EtcdMemberInfo[] = [
      {
        id: 'member-0',
        name: 'etcd-0',
        peerURLs: ['https://etcd-0.etcd:2380'],
        clientURLs: ['https://etcd-0.etcd:2379'],
        isLearner: false,
      },
      {
        id: 'member-1',
        name: 'etcd-1',
        peerURLs: ['https://etcd-1.etcd:2380'],
        clientURLs: ['https://etcd-1.etcd:2379'],
        isLearner: false,
      },
    ];

    if (this.state !== 'recovering') {
      members.push({
        id: 'member-2',
        name: 'etcd-2',
        peerURLs: ['https://etcd-2.etcd:2380'],
        clientURLs: ['https://etcd-2.etcd:2379'],
        isLearner: this.state === 'recovered' ? false : false,
      });
    }

    return members;
  }

  async getAlarmList(): Promise<EtcdAlarm[]> {
    if (this.state === 'degraded') {
      return [{ memberID: 'member-2', alarm: 'NOSPACE' }];
    }
    return [];
  }

  async getEndpointStatus(): Promise<EtcdEndpointStatus[]> {
    switch (this.state) {
      case 'degraded':
        return [
          {
            endpoint: 'https://etcd-0.etcd:2379',
            dbSize: 2_147_483_648,       // ~2GB
            dbSizeInUse: 1_610_612_736,  // ~1.5GB
            leader: 'member-1',
            raftIndex: 54_230,
            raftTerm: 847,
            raftAppliedIndex: 54_228,
            errors: [],
          },
          {
            endpoint: 'https://etcd-1.etcd:2379',
            dbSize: 2_147_483_648,
            dbSizeInUse: 1_610_612_736,
            leader: 'member-1',
            raftIndex: 54_230,
            raftTerm: 847,
            raftAppliedIndex: 54_230,
            errors: [],
          },
          {
            endpoint: 'https://etcd-2.etcd:2379',
            dbSize: 2_147_483_648,       // ~2.1GB
            dbSizeInUse: 858_993_459,    // ~800MB
            leader: 'member-1',
            raftIndex: 54_100,
            raftTerm: 847,
            raftAppliedIndex: 54_098,
            errors: ['apply entries took too long', 'leadership transfer timeout'],
          },
        ];
      case 'recovering':
        return [
          {
            endpoint: 'https://etcd-0.etcd:2379',
            dbSize: 1_610_612_736,       // ~1.5GB
            dbSizeInUse: 1_342_177_280,  // ~1.25GB
            leader: 'member-1',
            raftIndex: 54_240,
            raftTerm: 848,
            raftAppliedIndex: 54_240,
            errors: [],
          },
          {
            endpoint: 'https://etcd-1.etcd:2379',
            dbSize: 1_610_612_736,
            dbSizeInUse: 1_342_177_280,
            leader: 'member-1',
            raftIndex: 54_240,
            raftTerm: 848,
            raftAppliedIndex: 54_240,
            errors: [],
          },
        ];
      case 'recovered':
        return [
          {
            endpoint: 'https://etcd-0.etcd:2379',
            dbSize: 1_342_177_280,       // ~1.25GB
            dbSizeInUse: 1_275_068_416,  // ~1.19GB
            leader: 'member-1',
            raftIndex: 54_260,
            raftTerm: 849,
            raftAppliedIndex: 54_260,
            errors: [],
          },
          {
            endpoint: 'https://etcd-1.etcd:2379',
            dbSize: 1_342_177_280,
            dbSizeInUse: 1_275_068_416,
            leader: 'member-1',
            raftIndex: 54_260,
            raftTerm: 849,
            raftAppliedIndex: 54_260,
            errors: [],
          },
          {
            endpoint: 'https://etcd-2.etcd:2379',
            dbSize: 1_342_177_280,
            dbSizeInUse: 1_275_068_416,
            leader: 'member-1',
            raftIndex: 54_260,
            raftTerm: 849,
            raftAppliedIndex: 54_260,
            errors: [],
          },
        ];
    }
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'structured_command') {
      throw new Error(`Unsupported etcd simulator command type: ${command.type}`);
    }

    switch (command.operation) {
      case 'member_status':
        return {
          health: await this.getClusterHealth(),
          members: await this.getMemberList(),
          alarms: await this.getAlarmList(),
          endpoints: await this.getEndpointStatus(),
        };
      case 'member_remove':
        this.transition('recovering');
        return { removed: true, memberId: command.parameters?.memberId };
      case 'defrag':
        return { defragmented: true, endpoint: command.parameters?.endpoint };
      case 'member_add':
        this.transition('recovered');
        return { added: true, memberId: command.parameters?.memberId };
      case 'alarm_disarm':
        return { disarmed: true, alarm: command.parameters?.alarm };
      default:
        return { simulated: true, operation: command.operation, parameters: command.parameters };
    }
  }

  async evaluateCheck(check: CheckExpression): Promise<boolean> {
    const stmt = check.statement ?? '';

    if (stmt === 'endpoint_health') {
      const health = await this.getClusterHealth();
      return this.compare(health.healthy, check.expect.operator, check.expect.value);
    }

    if (stmt === 'alarm_count') {
      const alarms = await this.getAlarmList();
      return this.compare(alarms.length, check.expect.operator, check.expect.value);
    }

    if (stmt === 'cluster_size') {
      const members = await this.getMemberList();
      return this.compare(members.length, check.expect.operator, check.expect.value);
    }

    return true;
  }

  listCapabilityProviders(): CapabilityProviderDescriptor[] {
    return [
      {
        id: 'etcd-simulator-admin',
        kind: 'capability_provider',
        name: 'Etcd Simulator Admin Provider',
        maturity: 'simulator_only',
        capabilities: [
          'consensus.member.remove',
          'consensus.member.add',
          'consensus.defrag',
          'consensus.snapshot.restore',
          'consensus.alarm.disarm',
        ],
        executionContexts: ['etcd_admin'],
        targetKinds: ['etcd'],
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
