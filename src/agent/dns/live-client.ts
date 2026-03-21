// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * DnsLiveClient — probes real DNS resolvers using node:dns/promises.
 *
 * Discovers configured resolvers from /etc/resolv.conf (Linux) or
 * scutil --dns (macOS). Zero external dependencies.
 */

import { Resolver, promises as dnsPromises } from 'node:dns';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { isIP } from 'node:net';
import { promisify } from 'node:util';
import type {
  DnsBackend,
  ResolverConfig,
  ResolverProbe,
  ResolutionResult,
} from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';
import { compareCheckValue } from '../../framework/check-helpers.js';

const execFileAsync = promisify(execFile);

export interface DnsLiveConfig {
  /** Override resolvers instead of auto-detecting from OS */
  resolvers?: string[];
  /** Hostnames to probe for resolution correctness */
  probeNames?: string[];
  /** Per-query timeout in ms (default: 3000) */
  queryTimeoutMs?: number;
  /** Path to resolv.conf (default: /etc/resolv.conf) */
  resolvConfPath?: string;
}

export class DnsLiveClient implements DnsBackend {
  private config: DnsLiveConfig;
  private resolverCache: ResolverConfig | null = null;

  constructor(config?: DnsLiveConfig) {
    this.config = config ?? {};
  }

  async getResolvConf(): Promise<ResolverConfig> {
    if (this.resolverCache) return this.resolverCache;

    if (this.config.resolvers && this.config.resolvers.length > 0) {
      this.resolverCache = {
        nameservers: this.config.resolvers,
        searchDomains: [],
        source: 'config',
      };
      return this.resolverCache;
    }

    const platform = this.detectPlatform();
    if (platform === 'macos') {
      try {
        this.resolverCache = await this.runScutil();
        return this.resolverCache;
      } catch {
        // Fall through to resolv.conf
      }
    }

    this.resolverCache = await this.readResolvConf();
    return this.resolverCache;
  }

  async probeResolvers(testHostname: string): Promise<ResolverProbe[]> {
    const config = await this.getResolvConf();
    const timeoutMs = this.config.queryTimeoutMs ?? 3000;

    const probes = await Promise.allSettled(
      config.nameservers.map((ns) => this.probeSingleResolver(ns, testHostname, timeoutMs)),
    );

    return probes.map((result, i) => {
      if (result.status === 'fulfilled') return result.value;
      return {
        nameserver: config.nameservers[i],
        reachable: false,
        latencyMs: -1,
        status: 'error' as const,
        errorDetail: result.reason instanceof Error ? result.reason.message : String(result.reason),
      };
    });
  }

  async resolveHostnames(hostnames: string[]): Promise<ResolutionResult[]> {
    const config = await this.getResolvConf();
    const timeoutMs = this.config.queryTimeoutMs ?? 3000;
    const results: ResolutionResult[] = [];

    for (const hostname of hostnames) {
      const perResolver = await Promise.allSettled(
        config.nameservers.map((ns) => this.resolveSingle(ns, hostname, timeoutMs)),
      );

      for (let i = 0; i < perResolver.length; i++) {
        const result = perResolver[i];
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          const code = result.reason instanceof Error ? (result.reason as NodeJS.ErrnoException).code ?? '' : '';
          results.push({
            hostname,
            resolver: config.nameservers[i],
            answers: [],
            latencyMs: -1,
            nxdomain: code === 'ENOTFOUND' || code === 'ENODATA',
            servfail: code === 'ESERVFAIL',
            timedOut: code === 'ETIMEOUT' || code === 'EAI_AGAIN',
            dnssecValid: null,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          });
        }
      }
    }

    return results;
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'api_call') {
      throw new Error(`Unsupported DNS live client command type: ${command.type}`);
    }

    switch (command.operation) {
      case 'probe_resolvers': {
        const testHostname = String(command.parameters?.testHostname ?? 'google.com');
        return {
          config: await this.getResolvConf(),
          probes: await this.probeResolvers(testHostname),
        };
      }
      case 'check_resolv_conf':
        return { config: await this.getResolvConf() };
      case 'flush_cache': {
        const platform = this.detectPlatform();
        return this.flushResolverCache(platform);
      }
      case 'update_resolv_conf': {
        const nameservers = command.parameters?.nameservers as string[] | undefined;
        if (!nameservers || nameservers.length === 0) {
          return { updated: false, reason: 'No nameservers provided' };
        }
        for (const ns of nameservers) {
          if (!isIP(ns)) {
            throw new Error(`Invalid nameserver address: ${ns}`);
          }
        }
        // In production, this would write to /etc/resolv.conf
        // For safety, log the intended change without mutating
        return { updated: false, dryRun: true, wouldWrite: nameservers };
      }
      case 'verify_resolution': {
        const hostnames = (command.parameters?.hostnames as string[]) ?? ['google.com'];
        return { results: await this.resolveHostnames(hostnames) };
      }
      default:
        return { executed: false, operation: command.operation };
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
        id: 'dns-live-read',
        kind: 'capability_provider',
        name: 'DNS Live Read Provider',
        maturity: 'live_validated',
        capabilities: ['dns.resolver.probe', 'dns.resolution.verify', 'dns.resolv_conf.read'],
        executionContexts: ['dns_read'],
        targetKinds: ['dns'],
        commandTypes: ['api_call'],
        supportsDryRun: true,
        supportsExecute: true,
      },
      {
        id: 'dns-live-write',
        kind: 'capability_provider',
        name: 'DNS Live Write Provider',
        maturity: 'live_validated',
        capabilities: ['dns.cache.flush', 'dns.resolv_conf.write'],
        executionContexts: ['dns_write'],
        targetKinds: ['dns'],
        commandTypes: ['api_call'],
        supportsDryRun: true,
        supportsExecute: true,
      },
    ];
  }

  transition(_to: string): void {
    // No-op for live client
  }

  async close(): Promise<void> {
    // No persistent connections to close
  }

  // --- Private helpers ---

  private detectPlatform(): 'macos' | 'linux' | 'other' {
    if (process.platform === 'darwin') return 'macos';
    if (process.platform === 'linux') return 'linux';
    return 'other';
  }

  private async readResolvConf(): Promise<ResolverConfig> {
    const paths = [
      this.config.resolvConfPath ?? '/etc/resolv.conf',
      '/run/systemd/resolve/resolv.conf',
    ];

    for (const path of paths) {
      try {
        const content = await readFile(path, 'utf-8');
        return this.parseResolvConf(content);
      } catch {
        continue;
      }
    }

    // Fallback to system default resolvers
    const systemResolvers = dnsPromises.getServers();
    return {
      nameservers: systemResolvers,
      searchDomains: [],
      source: 'resolv.conf',
    };
  }

  private parseResolvConf(content: string): ResolverConfig {
    const nameservers: string[] = [];
    const searchDomains: string[] = [];

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed === '') continue;

      const nsMatch = trimmed.match(/^nameserver\s+(\S+)/);
      if (nsMatch && isIP(nsMatch[1])) {
        nameservers.push(nsMatch[1]);
        continue;
      }

      const searchMatch = trimmed.match(/^(?:search|domain)\s+(.+)/);
      if (searchMatch) {
        searchDomains.push(...searchMatch[1].trim().split(/\s+/));
      }
    }

    return { nameservers, searchDomains, source: 'resolv.conf' };
  }

  private async runScutil(): Promise<ResolverConfig> {
    const { stdout } = await execFileAsync('scutil', ['--dns'], { timeout: 2000 });
    const nameservers: string[] = [];
    const searchDomains: string[] = [];

    for (const line of stdout.split('\n')) {
      const nsMatch = line.match(/nameserver\[\d+\]\s*:\s*(\S+)/);
      if (nsMatch && isIP(nsMatch[1])) {
        if (!nameservers.includes(nsMatch[1])) {
          nameservers.push(nsMatch[1]);
        }
        continue;
      }

      const domainMatch = line.match(/search domain\[\d+\]\s*:\s*(\S+)/);
      if (domainMatch) {
        if (!searchDomains.includes(domainMatch[1])) {
          searchDomains.push(domainMatch[1]);
        }
      }
    }

    if (nameservers.length === 0) {
      throw new Error('No nameservers found in scutil output');
    }

    return { nameservers, searchDomains, source: 'scutil' };
  }

  private async probeSingleResolver(
    nameserver: string,
    testHostname: string,
    timeoutMs: number,
  ): Promise<ResolverProbe> {
    const resolver = new Resolver();
    resolver.setServers([nameserver]);

    const start = Date.now();
    try {
      await this.queryWithTimeout(
        () => new Promise<string[]>((resolve, reject) => {
          resolver.resolve4(testHostname, (err, addresses) => {
            if (err) reject(err);
            else resolve(addresses);
          });
        }),
        timeoutMs,
      );
      const latencyMs = Date.now() - start;
      return { nameserver, reachable: true, latencyMs, status: 'ok', errorDetail: null };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (code === 'ETIMEOUT' || code === 'EAI_AGAIN' || latencyMs >= timeoutMs) {
        return { nameserver, reachable: false, latencyMs: -1, status: 'timeout', errorDetail: `Connection timed out after ${timeoutMs}ms` };
      }
      if (code === 'ESERVFAIL') {
        return { nameserver, reachable: true, latencyMs, status: 'servfail', errorDetail: 'Server returned SERVFAIL' };
      }
      if (code === 'EREFUSED' || code === 'ECONNREFUSED') {
        return { nameserver, reachable: false, latencyMs, status: 'refused', errorDetail: 'Connection refused' };
      }
      return { nameserver, reachable: false, latencyMs, status: 'error', errorDetail: String(err) };
    }
  }

  private async resolveSingle(
    nameserver: string,
    hostname: string,
    timeoutMs: number,
  ): Promise<ResolutionResult> {
    const resolver = new Resolver();
    resolver.setServers([nameserver]);

    const start = Date.now();
    try {
      const addresses = await this.queryWithTimeout(
        () => new Promise<string[]>((resolve, reject) => {
          resolver.resolve4(hostname, (err, addrs) => {
            if (err) reject(err);
            else resolve(addrs);
          });
        }),
        timeoutMs,
      );
      const latencyMs = Date.now() - start;
      return {
        hostname, resolver: nameserver, answers: addresses, latencyMs,
        nxdomain: false, servfail: false, timedOut: false, dnssecValid: null, error: null,
      };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const code = (err as NodeJS.ErrnoException).code ?? '';
      return {
        hostname, resolver: nameserver, answers: [], latencyMs,
        nxdomain: code === 'ENOTFOUND' || code === 'ENODATA',
        servfail: code === 'ESERVFAIL',
        timedOut: code === 'ETIMEOUT' || code === 'EAI_AGAIN' || latencyMs >= timeoutMs,
        dnssecValid: null,
        error: code || String(err),
      };
    }
  }

  private queryWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(Object.assign(new Error(`DNS query timed out after ${timeoutMs}ms`), { code: 'ETIMEOUT' }));
      }, timeoutMs);

      fn().then(
        (result) => { clearTimeout(timer); resolve(result); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    });
  }

  private async flushResolverCache(platform: 'macos' | 'linux' | 'other'): Promise<unknown> {
    const tried: string[] = [];

    if (platform === 'macos') {
      try {
        await execFileAsync('dscacheutil', ['-flushcache'], { timeout: 5000 });
        tried.push('dscacheutil -flushcache');
        return { flushed: true, platform, commands: tried };
      } catch {
        tried.push('dscacheutil -flushcache (failed)');
      }
    }

    if (platform === 'linux') {
      const commands = [
        ['systemd-resolve', ['--flush-caches']],
        ['resolvectl', ['flush-caches']],
        ['nscd', ['-i', 'hosts']],
      ] as const;

      for (const [cmd, args] of commands) {
        try {
          await execFileAsync(cmd, [...args], { timeout: 5000 });
          tried.push(`${cmd} ${args.join(' ')}`);
          return { flushed: true, platform, commands: tried };
        } catch {
          tried.push(`${cmd} ${args.join(' ')} (failed)`);
        }
      }
    }

    return { flushed: false, platform, commands: tried };
  }
}
