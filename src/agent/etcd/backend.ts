// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * EtcdBackend — interface for querying etcd cluster state.
 * Both the simulator and live client implement this.
 */

import type { ExecutionBackend } from '../../framework/backend.js';

export interface EtcdMemberInfo {
  id: string;
  name: string;
  peerURLs: string[];
  clientURLs: string[];
  isLearner: boolean;
}

export interface EtcdEndpointStatus {
  endpoint: string;
  dbSize: number;
  dbSizeInUse: number;
  leader: string;
  raftIndex: number;
  raftTerm: number;
  raftAppliedIndex: number;
  errors: string[];
}

export interface EtcdAlarm {
  memberID: string;
  alarm: 'NOSPACE' | 'CORRUPT';
}

export interface EtcdClusterHealth {
  healthy: boolean;
  members: number;
  leader: string;
  raftTerm: number;
}

export interface EtcdBackend extends ExecutionBackend {
  /** Get overall cluster health summary */
  getClusterHealth(): Promise<EtcdClusterHealth>;

  /** Get list of all cluster members */
  getMemberList(): Promise<EtcdMemberInfo[]>;

  /** Get active alarms (NOSPACE, CORRUPT) */
  getAlarmList(): Promise<EtcdAlarm[]>;

  /** Get per-endpoint status including DB size and raft state */
  getEndpointStatus(): Promise<EtcdEndpointStatus[]>;

  /** Optional simulator-only state transitions */
  transition?(to: string): void;
}
