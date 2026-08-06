// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Node implementations of the triage probes — the only code in the triage
 * path that touches the real machine. Node built-ins only, everything
 * read-only, every failure returned as data rather than thrown.
 */

import { readFileSync } from 'node:fs';
import type { ObserverContextResult } from './triage.js';

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
