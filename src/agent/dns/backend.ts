// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * DnsBackend — interface for probing DNS resolvers and resolution health.
 * Both the simulator and live client implement this.
 */

import type { ExecutionBackend } from '../../framework/backend.js';

/** Parsed resolver configuration from the OS */
export interface ResolverConfig {
  nameservers: string[];
  searchDomains: string[];
  source: 'resolv.conf' | 'scutil' | 'config';
}

/** Result of probing a single nameserver */
export interface ResolverProbe {
  nameserver: string;
  reachable: boolean;
  latencyMs: number;
  status: 'ok' | 'timeout' | 'servfail' | 'refused' | 'error';
  errorDetail: string | null;
}

/** Result of resolving a hostname */
export interface ResolutionResult {
  hostname: string;
  resolver: string;
  answers: string[];
  latencyMs: number;
  nxdomain: boolean;
  servfail: boolean;
  timedOut: boolean;
  dnssecValid: boolean | null;
  error: string | null;
}

export interface DnsBackend extends ExecutionBackend {
  /** Read and parse resolver configuration from the OS */
  getResolvConf(): Promise<ResolverConfig>;

  /** Probe each configured nameserver for reachability and latency */
  probeResolvers(testHostname: string): Promise<ResolverProbe[]>;

  /** Resolve hostnames across all configured resolvers */
  resolveHostnames(hostnames: string[]): Promise<ResolutionResult[]>;

  /** Simulator-only state transition hook */
  transition?(to: string): void;
}
