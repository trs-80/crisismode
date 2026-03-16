// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Zero-config service detection — probes localhost for common
 * infrastructure services using TCP connect checks.
 */

import { createConnection } from 'node:net';

export interface DetectedService {
  kind: string;
  host: string;
  port: number;
  detected: boolean;
}

const DEFAULT_PROBES: Array<{ kind: string; port: number }> = [
  { kind: 'postgresql', port: 5432 },
  { kind: 'redis', port: 6379 },
  { kind: 'etcd', port: 2379 },
  { kind: 'kafka', port: 9092 },
];

const PROBE_TIMEOUT_MS = 2000;

/**
 * Probe a single host:port via TCP connect.
 * Returns true if the connection succeeds within the timeout.
 */
function probePort(host: string, port: number, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });

    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);

    socket.on('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });

    socket.on('error', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Detect services running on localhost by probing common ports.
 * All probes run in parallel with a 2s timeout per port.
 */
export async function detectServices(
  host: string = 'localhost',
  probes: Array<{ kind: string; port: number }> = DEFAULT_PROBES,
): Promise<DetectedService[]> {
  const results = await Promise.all(
    probes.map(async (probe) => ({
      kind: probe.kind,
      host,
      port: probe.port,
      detected: await probePort(host, probe.port),
    })),
  );

  return results;
}
