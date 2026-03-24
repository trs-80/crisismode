// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

export type ConnectivityStatus = 'available' | 'unavailable' | 'degraded' | 'unknown';

export interface ProbeResult {
  target: string;
  reachable: boolean;
  latencyMs: number;
  error?: string;
}

export interface NetworkLayer {
  status: ConnectivityStatus;
  probes: ProbeResult[];
  checkedAt: string;
}

export interface NetworkProfile {
  /** Can we reach external internet APIs? */
  internet: NetworkLayer;
  /** Can we reach the CrisisMode hub? */
  hub: NetworkLayer;
  /** Can we reach configured infrastructure targets? */
  targets: NetworkLayer;
  /** DNS resolution working? */
  dns: { available: boolean; latencyMs: number };
  /** Overall operating mode inferred from the profile */
  mode: NetworkMode;
  /** When this profile was created */
  profiledAt: string;
}

export type NetworkMode =
  | 'full'           // Internet + private network available
  | 'private_only'   // Private network reachable, no internet
  | 'isolated'       // No network connectivity at all
  | 'unknown';       // Probes haven't run yet
