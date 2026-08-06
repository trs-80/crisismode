// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Node implementations of the triage probes — the only code in the triage
 * path that touches the real machine. Node built-ins only, everything
 * read-only, every failure returned as data rather than thrown.
 */

import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { Resolver } from 'node:dns/promises';
import { createConnection } from 'node:net';
import { networkInterfaces } from 'node:os';
import { promisify } from 'node:util';
import type { ProbeResult } from '@crisismode/agent-sdk';
import type { ObserverContextResult, DnsProbeResult, GatewayProbeResult, HttpProbeResult, InterfaceProbeResult, TriageProbes } from './triage.js';

const execFileAsync = promisify(execFile);

// ── Observer context ──

/** Vendor strings that mean "this is a cloud/virtual host, not someone's laptop". */
export const CLOUD_DMI_MARKERS = [
  'amazon', 'google', 'microsoft corporation', 'digitalocean', 'alibaba',
  'openstack', 'hetzner', 'linode', 'qemu', 'kvm', 'vmware', 'xen', 'virtualbox',
];

/** Environment variables that only exist in server/CI environments. */
export const SERVER_ENV_MARKERS = [
  'KUBERNETES_SERVICE_HOST',
  'ECS_CONTAINER_METADATA_URI',
  'ECS_CONTAINER_METADATA_URI_V4',
  'AWS_EXECUTION_ENV',
  'WEBSITE_INSTANCE_ID',
  'DYNO',
  'K_SERVICE',
  'FUNCTION_TARGET',
  'CI',
];

const DMI_PATHS = ['/sys/class/dmi/id/sys_vendor', '/sys/class/dmi/id/product_name'];

/**
 * Best-effort laptop-vs-server classification, with no network calls.
 * Pure so it can be table-tested; `detectObserverContext` supplies the inputs.
 */
export function classifyObserverContext(input: {
  platform: string;
  env: Record<string, string | undefined>;
  dmi: string | null;
}): ObserverContextResult {
  const marker = SERVER_ENV_MARKERS.find((key) => {
    const value = input.env[key];
    return value !== undefined && value !== '';
  });
  if (marker !== undefined) {
    return { context: 'server', evidence: `environment variable ${marker} is set (best-effort detection)` };
  }

  if (input.dmi !== null) {
    const dmi = input.dmi.toLowerCase();
    const hit = CLOUD_DMI_MARKERS.find((m) => dmi.includes(m));
    if (hit !== undefined) {
      return { context: 'server', evidence: `DMI vendor string contains "${hit}" (best-effort detection)` };
    }
  }

  if (input.platform === 'darwin') {
    return { context: 'laptop', evidence: 'macOS host with no server markers (assumption, not a measurement)' };
  }

  return { context: 'unknown', evidence: 'no laptop or server markers found — captive-portal checks still apply' };
}

export function detectObserverContext(): ObserverContextResult {
  return classifyObserverContext({
    platform: process.platform,
    env: process.env,
    dmi: readDmi(),
  });
}

function readDmi(): string | null {
  if (process.platform !== 'linux') return null;
  const parts: string[] = [];
  for (const path of DMI_PATHS) {
    try {
      parts.push(readFileSync(path, 'utf-8').trim());
    } catch {
      // Not readable (non-DMI host, container, permissions) — best effort.
    }
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

// ── Real probe implementations ──

/** Max characters of a connectivity-check body we keep. */
const MAX_BODY_CHARS = 256;

/**
 * Read at most `maxChars` characters from a response body, then cancel the
 * stream instead of letting it run to completion.
 *
 * `response.text()` buffers the *entire* body before anything can truncate
 * it — a captive portal or an on-path attacker can return an arbitrarily
 * large body and pressure triage's memory well before the slice ever
 * happens. Reading the stream directly means the cap actually bounds what
 * gets buffered, not just what gets kept.
 */
async function readCappedBody(response: Response, maxChars: number): Promise<string> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (text.length < maxChars) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    // Stop pulling bytes we will never keep — leaving the reader open would
    // let the underlying connection keep streaming the rest of the body.
    await reader.cancel().catch(() => {});
  }
  return text.slice(0, maxChars);
}

/** Parses `ip route show default` (Linux). */
export function parseIpRouteDefault(stdout: string): string | null {
  const match = /^default\s+via\s+(\S+)/m.exec(stdout);
  return match?.[1] ?? null;
}

/** Parses `route -n get default` (macOS/BSD). */
export function parseRouteGetDefault(stdout: string): string | null {
  const match = /^\s*gateway:\s*(\S+)\s*$/m.exec(stdout);
  return match?.[1] ?? null;
}

export type BoundedOutcome<T> =
  | { ok: true; value: T; durationMs: number }
  | { ok: false; error: string; durationMs: number };

/**
 * Run one operation under a hard timeout, returning failure as data.
 *
 * The single implementation of bounded execution in the triage path — used by
 * boundedResolve, by runTriage's outer backstop, and by network-profile.ts.
 * Keeping one copy is the point: an unbounded probe is invisible until an
 * offline machine reports `unknown` instead of a verdict.
 *
 * `onTimeout` is where cancellation goes. Provide it whenever the underlying
 * API can be cancelled — a timed-out promise is still running, and a live
 * c-ares query keeps the event loop alive after the CLI has printed its
 * report. Omit it when the API offers no cancellation (`dns.lookup` runs in
 * the libuv threadpool and cannot be aborted); the bound still holds for the
 * caller, the work merely finishes on its own.
 */
export async function runBounded<T>(
  op: () => Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<BoundedOutcome<T>> {
  // performance.now() (monotonic), not Date.now() (wall clock): an NTP
  // correction or a manual clock change during the run must not stretch a
  // timeout, produce a negative duration, or cut a probe short.
  const start = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(new Error(`timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      op().then(resolve, reject);
    });
    return { ok: true, value, durationMs: performance.now() - start };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), durationMs: performance.now() - start };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * One DNS query, bounded and cancelled on timeout.
 *
 * `servers === null` means "this machine's configured resolvers".
 *
 * This is a *raw resolver query*, deliberately not `lookup()`: triage needs to
 * tell a broken local resolver apart from a broken network, which means asking
 * named servers directly and bypassing `/etc/hosts`. `network-profile.ts` asks
 * the other question and keeps `lookup()` — see Task 13.
 *
 * Its own resolver with `tries: 1` is load-bearing: the process-global
 * resolver behind `dns/promises.resolve4()` retries on c-ares' schedule
 * (seconds), which no outer race can shorten.
 */
export async function boundedResolve(
  hostname: string,
  servers: readonly string[] | null,
  timeoutMs: number,
): Promise<{ ok: boolean; error?: string | undefined }> {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  if (servers !== null) resolver.setServers([...servers]);

  const outcome = await runBounded(
    () => resolver.resolve4(hostname),
    timeoutMs,
    () => resolver.cancel(),
  );
  return outcome.ok
    ? { ok: outcome.value.length > 0 }
    : { ok: false, error: outcome.error };
}

/**
 * The real probe set. `timeoutMs` bounds each probe from the inside
 * (sockets, fetch, resolver, subprocess); `runTriage` bounds it again from
 * the outside so a probe that ignores its own timeout still cannot hang.
 *
 * The only subprocess invocations are the two fixed, argument-free route
 * table reads below — no user-influenced input reaches a shell.
 *
 * `publicResolvers` is a parameter rather than an import so this module needs
 * no runtime import from triage.ts, which imports this one.
 */
export function nodeTriageProbes(timeoutMs: number, publicResolvers: readonly string[]): TriageProbes {
  return {
    async listInterfaces(): Promise<InterfaceProbeResult> {
      const activeInterfaces: string[] = [];
      for (const [name, addresses] of Object.entries(networkInterfaces())) {
        for (const address of addresses ?? []) {
          if (!address.internal && address.address !== '') {
            activeInterfaces.push(name);
            break;
          }
        }
      }
      return { activeInterfaces };
    },

    async findDefaultGateway(): Promise<GatewayProbeResult> {
      try {
        if (process.platform === 'linux') {
          const { stdout } = await execFileAsync('ip', ['route', 'show', 'default'], { timeout: timeoutMs });
          return { address: parseIpRouteDefault(stdout) };
        }
        if (process.platform === 'darwin') {
          const { stdout } = await execFileAsync('route', ['-n', 'get', 'default'], { timeout: timeoutMs });
          return { address: parseRouteGetDefault(stdout) };
        }
        return { address: null };
      } catch {
        // No route tool, no default route, or a timeout — honesty over guessing.
        return { address: null };
      }
    },

    async resolveDns(hostname: string): Promise<DnsProbeResult> {
      // Concurrent, not sequential: run in sequence, a dead system resolver
      // eats the whole probe budget before the public resolver is ever tried,
      // and the layer can never distinguish 'resolver-broken' from
      // 'dns-unreachable'. Each half is bounded independently.
      const [system, direct] = await Promise.all([
        boundedResolve(hostname, null, timeoutMs),
        boundedResolve(hostname, publicResolvers, timeoutMs),
      ]);
      return {
        systemResolved: system.ok,
        publicResolved: direct.ok,
        ...(system.error !== undefined ? { systemError: system.error } : {}),
        ...(direct.error !== undefined ? { publicError: direct.error } : {}),
      };
    },

    async fetchUrl(url: string, method: 'GET' | 'HEAD'): Promise<HttpProbeResult> {
      const start = performance.now();
      try {
        const response = await fetch(url, {
          method,
          // Manual redirects: a portal's 302 must be observed, not followed.
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
          headers: { 'user-agent': 'crisismode-triage' },
        });
        const body = method === 'GET' ? await readCappedBody(response, MAX_BODY_CHARS) : '';
        return {
          status: response.status,
          body,
          redirected: response.status >= 300 && response.status < 400,
          latencyMs: Math.round(performance.now() - start),
        };
      } catch (err) {
        return {
          status: null,
          body: '',
          redirected: false,
          latencyMs: Math.round(performance.now() - start),
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    connectTcp(host: string, port: number, label: string): Promise<ProbeResult> {
      return probeTcpBounded(host, port, label, timeoutMs);
    },
  };
}

/**
 * TCP reachability as a ProbeResult. Shared with network-profile.ts (Task 13)
 * so there is exactly one socket-probe implementation to keep bounded.
 *
 * Deliberately does NOT route through runBounded: the socket owns its own
 * timeout and destroy lifecycle. A socket timeout is a legitimate measurement
 * ("did not answer"), not an error. Wrapping it in runBounded would convert
 * that measurement into an exception, then back to data — unnecessary and
 * error-prone. The socket's native timeout + destroy is the right abstraction.
 */
export function probeTcpBounded(
  host: string,
  port: number,
  label: string,
  timeoutMs: number,
): Promise<ProbeResult> {
  const start = performance.now();
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ target: label, reachable: false, latencyMs: Math.round(performance.now() - start), error: `Timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    socket.on('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ target: label, reachable: true, latencyMs: Math.round(performance.now() - start) });
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ target: label, reachable: false, latencyMs: Math.round(performance.now() - start), error: err.message });
    });
  });
}
