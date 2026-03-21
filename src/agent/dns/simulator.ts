// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type {
  DnsBackend,
  ResolverConfig,
  ResolverProbe,
  ResolutionResult,
} from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';
import { compareCheckValue } from '../../framework/check-helpers.js';

export type SimulatorState = 'resolver_degraded' | 'recovering' | 'healthy';

export class DnsSimulator implements DnsBackend {
  private state: SimulatorState = 'resolver_degraded';

  transition(to: string): void {
    this.state = to as SimulatorState;
  }

  async getResolvConf(): Promise<ResolverConfig> {
    return {
      nameservers: ['10.0.0.2', '8.8.8.8', '1.1.1.1'],
      searchDomains: ['internal.example.com', 'example.com'],
      source: 'resolv.conf',
    };
  }

  async probeResolvers(_testHostname: string): Promise<ResolverProbe[]> {
    switch (this.state) {
      case 'resolver_degraded':
        return [
          { nameserver: '10.0.0.2', reachable: false, latencyMs: -1, status: 'timeout', errorDetail: 'Connection timed out after 3000ms' },
          { nameserver: '8.8.8.8', reachable: true, latencyMs: 850, status: 'servfail', errorDetail: 'SERVFAIL on 35% of queries' },
          { nameserver: '1.1.1.1', reachable: true, latencyMs: 45, status: 'ok', errorDetail: null },
        ];
      case 'recovering':
        return [
          { nameserver: '10.0.0.2', reachable: false, latencyMs: -1, status: 'timeout', errorDetail: 'Connection timed out after 3000ms' },
          { nameserver: '8.8.8.8', reachable: true, latencyMs: 120, status: 'ok', errorDetail: null },
          { nameserver: '1.1.1.1', reachable: true, latencyMs: 42, status: 'ok', errorDetail: null },
        ];
      case 'healthy':
        return [
          { nameserver: '10.0.0.2', reachable: true, latencyMs: 12, status: 'ok', errorDetail: null },
          { nameserver: '8.8.8.8', reachable: true, latencyMs: 35, status: 'ok', errorDetail: null },
          { nameserver: '1.1.1.1', reachable: true, latencyMs: 28, status: 'ok', errorDetail: null },
        ];
    }
  }

  async resolveHostnames(hostnames: string[]): Promise<ResolutionResult[]> {
    const results: ResolutionResult[] = [];

    for (const hostname of hostnames) {
      switch (this.state) {
        case 'resolver_degraded':
          results.push(
            { hostname, resolver: '10.0.0.2', answers: [], latencyMs: -1, nxdomain: false, servfail: false, timedOut: true, dnssecValid: null, error: 'ETIMEOUT' },
            { hostname, resolver: '8.8.8.8', answers: [], latencyMs: 920, nxdomain: false, servfail: true, timedOut: false, dnssecValid: null, error: 'ESERVFAIL' },
            { hostname, resolver: '1.1.1.1', answers: ['93.184.216.34'], latencyMs: 48, nxdomain: false, servfail: false, timedOut: false, dnssecValid: true, error: null },
          );
          break;
        case 'recovering':
          results.push(
            { hostname, resolver: '10.0.0.2', answers: [], latencyMs: -1, nxdomain: false, servfail: false, timedOut: true, dnssecValid: null, error: 'ETIMEOUT' },
            { hostname, resolver: '8.8.8.8', answers: ['93.184.216.34'], latencyMs: 110, nxdomain: false, servfail: false, timedOut: false, dnssecValid: true, error: null },
            { hostname, resolver: '1.1.1.1', answers: ['93.184.216.34'], latencyMs: 38, nxdomain: false, servfail: false, timedOut: false, dnssecValid: true, error: null },
          );
          break;
        case 'healthy':
          results.push(
            { hostname, resolver: '10.0.0.2', answers: ['93.184.216.34'], latencyMs: 15, nxdomain: false, servfail: false, timedOut: false, dnssecValid: true, error: null },
            { hostname, resolver: '8.8.8.8', answers: ['93.184.216.34'], latencyMs: 32, nxdomain: false, servfail: false, timedOut: false, dnssecValid: true, error: null },
            { hostname, resolver: '1.1.1.1', answers: ['93.184.216.34'], latencyMs: 25, nxdomain: false, servfail: false, timedOut: false, dnssecValid: true, error: null },
          );
          break;
      }
    }

    return results;
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'api_call') {
      throw new Error(`Unsupported DNS simulator command type: ${command.type}`);
    }

    switch (command.operation) {
      case 'probe_resolvers':
        return {
          config: await this.getResolvConf(),
          probes: await this.probeResolvers(String(command.parameters?.testHostname ?? 'google.com')),
        };
      case 'check_resolv_conf':
        return { config: await this.getResolvConf() };
      case 'flush_cache':
        if (this.state === 'resolver_degraded') {
          this.transition('recovering');
        }
        return { flushed: true, platform: 'simulator' };
      case 'update_resolv_conf':
        this.transition('recovering');
        return { updated: true, nameservers: command.parameters?.nameservers };
      case 'verify_resolution':
        return {
          results: await this.resolveHostnames(
            (command.parameters?.hostnames as string[]) ?? ['google.com'],
          ),
        };
      default:
        return { simulated: true, operation: command.operation, parameters: command.parameters };
    }
  }

  async evaluateCheck(check: CheckExpression): Promise<boolean> {
    const stmt = check.statement ?? '';

    if (stmt === 'resolver_reachable') {
      const probes = await this.probeResolvers('google.com');
      const reachableCount = probes.filter((p) => p.reachable).length;
      return compareCheckValue(reachableCount, check.expect.operator, check.expect.value);
    }

    if (stmt.includes('servfail_rate')) {
      const probes = await this.probeResolvers('google.com');
      const servfailCount = probes.filter((p) => p.status === 'servfail').length;
      const rate = probes.length > 0 ? servfailCount / probes.length : 0;
      return compareCheckValue(rate, check.expect.operator, check.expect.value);
    }

    if (stmt.includes('timeout_rate')) {
      const probes = await this.probeResolvers('google.com');
      const timeoutCount = probes.filter((p) => p.status === 'timeout').length;
      const rate = probes.length > 0 ? timeoutCount / probes.length : 0;
      return compareCheckValue(rate, check.expect.operator, check.expect.value);
    }

    if (stmt.includes('resolution_healthy')) {
      const results = await this.resolveHostnames(['google.com']);
      const successCount = results.filter((r) => r.answers.length > 0 && !r.servfail && !r.timedOut).length;
      return compareCheckValue(successCount, check.expect.operator, check.expect.value);
    }

    if (stmt.includes('split_brain')) {
      const results = await this.resolveHostnames(['google.com']);
      const answerSets = results.filter((r) => r.answers.length > 0).map((r) => [...r.answers].sort().join(','));
      const unique = new Set(answerSets);
      const detected = unique.size > 1;
      return compareCheckValue(detected, check.expect.operator, check.expect.value);
    }

    return true;
  }

  listCapabilityProviders(): CapabilityProviderDescriptor[] {
    return [
      {
        id: 'dns-simulator-read',
        kind: 'capability_provider',
        name: 'DNS Simulator Read Provider',
        maturity: 'simulator_only',
        capabilities: ['dns.resolver.probe', 'dns.resolution.verify', 'dns.resolv_conf.read'],
        executionContexts: ['dns_read'],
        targetKinds: ['dns'],
        commandTypes: ['api_call'],
        supportsDryRun: true,
        supportsExecute: true,
      },
      {
        id: 'dns-simulator-write',
        kind: 'capability_provider',
        name: 'DNS Simulator Write Provider',
        maturity: 'simulator_only',
        capabilities: ['dns.cache.flush', 'dns.resolv_conf.write'],
        executionContexts: ['dns_write'],
        targetKinds: ['dns'],
        commandTypes: ['api_call'],
        supportsDryRun: true,
        supportsExecute: true,
      },
    ];
  }

  async close(): Promise<void> {}
}
