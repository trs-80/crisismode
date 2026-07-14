// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Credibility policy tests for the six registrations migrated from silent
 * simulator fallback to createLiveRegistration (see live-registration.ts):
 *
 * - Explicit simulator targets (host === 'simulator') get the simulator.
 * - Live targets get the live backend; failures PROPAGATE so scan reports
 *   an honest "could not connect" finding. We never silently substitute
 *   simulated data for real systems.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ResolvedTarget } from '../config/schema.js';

function target(kind: string, host: string, port = 0): ResolvedTarget {
  return {
    name: `test-${kind}`,
    kind,
    primary: { host, port },
    replicas: [],
    credentials: {},
  } as unknown as ResolvedTarget;
}

describe('dns registration', () => {
  it('uses the simulator for explicit simulator targets', async () => {
    const { dnsRecoveryRegistration } = await import('../agent/dns/registration.js');
    const instance = await dnsRecoveryRegistration.createAgent(target('dns', 'simulator'));
    expect(instance.backend.constructor.name).toBe('DnsSimulator');
    await instance.backend.close();
  });

  it('uses the live client for auto targets (no fallback path exists)', async () => {
    const { dnsRecoveryRegistration } = await import('../agent/dns/registration.js');
    const instance = await dnsRecoveryRegistration.createAgent(target('dns', 'auto', 53));
    expect(instance.backend.constructor.name).toBe('DnsLiveClient');
    await instance.backend.close();
  });

  it('passes an explicit resolver host through to the live client', async () => {
    const { dnsRecoveryRegistration } = await import('../agent/dns/registration.js');
    const instance = await dnsRecoveryRegistration.createAgent(target('dns', '127.0.0.1:5300', 53));
    expect(instance.backend.constructor.name).toBe('DnsLiveClient');
    await instance.backend.close();
  });
});

describe('disk registration', () => {
  it('uses the simulator for explicit simulator targets', async () => {
    const { diskExhaustionRegistration } = await import('../agent/disk/registration.js');
    const instance = await diskExhaustionRegistration.createAgent(target('disk', 'simulator'));
    expect(instance.backend.constructor.name).toBe('DiskSimulator');
    await instance.backend.close();
  });

  it('uses the live client for auto targets', async () => {
    const { diskExhaustionRegistration } = await import('../agent/disk/registration.js');
    const instance = await diskExhaustionRegistration.createAgent(target('disk', 'auto'));
    expect(instance.backend.constructor.name).toBe('DiskLiveClient');
    await instance.backend.close();
  });

  it('uses the live client with parsed mount points for explicit hosts', async () => {
    const { diskExhaustionRegistration } = await import('../agent/disk/registration.js');
    const instance = await diskExhaustionRegistration.createAgent(target('disk', '/, /var'));
    expect(instance.backend.constructor.name).toBe('DiskLiveClient');
    await instance.backend.close();
  });
});

describe('kubernetes registration', () => {
  it('uses the simulator for explicit simulator targets', async () => {
    const { k8sRecoveryRegistration } = await import('../agent/kubernetes/registration.js');
    const instance = await k8sRecoveryRegistration.createAgent(target('kubernetes', 'simulator'));
    expect(instance.backend.constructor.name).toBe('K8sSimulator');
    await instance.backend.close();
  });

  it('rejects (never simulates) when the kubeconfig cannot be loaded', async () => {
    const { k8sRecoveryRegistration } = await import('../agent/kubernetes/registration.js');
    await expect(
      k8sRecoveryRegistration.createAgent(target('kubernetes', '/nonexistent/kubeconfig', 6443)),
    ).rejects.toThrow();
  });
});

describe('tls registration', () => {
  it('uses the simulator for explicit simulator targets', async () => {
    const { tlsRecoveryRegistration } = await import('../agent/tls/registration.js');
    const instance = await tlsRecoveryRegistration.createAgent(target('tls', 'simulator'));
    expect(instance.backend.constructor.name).toBe('TlsSimulator');
    await instance.backend.close();
  });

  it('rejects default/empty hosts with a configuration error instead of simulating', async () => {
    const { tlsRecoveryRegistration } = await import('../agent/tls/registration.js');
    await expect(
      tlsRecoveryRegistration.createAgent(target('tls', 'default', 443)),
    ).rejects.toThrow(/requires an endpoint host/);
    await expect(
      tlsRecoveryRegistration.createAgent(target('tls', '', 443)),
    ).rejects.toThrow(/requires an endpoint host/);
  });

  it('uses the live client for real endpoint hosts', async () => {
    const { tlsRecoveryRegistration } = await import('../agent/tls/registration.js');
    const instance = await tlsRecoveryRegistration.createAgent(target('tls', 'example.com', 443));
    expect(instance.backend.constructor.name).toBe('TlsLiveClient');
    await instance.backend.close();
  });
});

describe('backup registration', () => {
  it('uses the simulator for explicit simulator targets', async () => {
    const { backupVerificationRegistration } = await import('../agent/backup/registration.js');
    const instance = await backupVerificationRegistration.createAgent(target('backup', 'simulator'));
    expect(instance.backend.constructor.name).toBe('BackupSimulator');
    await instance.backend.close();
  });

  it('uses the composite live client for live targets', async () => {
    const { backupVerificationRegistration } = await import('../agent/backup/registration.js');
    const instance = await backupVerificationRegistration.createAgent(target('backup', 'default'));
    expect(instance.backend.constructor.name).toBe('BackupCompositeClient');
    await instance.backend.close();
  });
});

describe('deploy-rollback registration', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const VARS = ['VERCEL_TOKEN', 'VERCEL_PROJECT_ID', 'VERCEL_TEAM_ID', 'VERCEL_HEALTH_ENDPOINTS'];

  beforeEach(() => {
    for (const v of VARS) {
      savedEnv[v] = process.env[v];
      delete process.env[v];
    }
  });

  afterEach(() => {
    for (const v of VARS) {
      if (savedEnv[v] === undefined) delete process.env[v];
      else process.env[v] = savedEnv[v];
    }
  });

  it('uses the simulator for explicit simulator targets even when credentials are set', async () => {
    process.env['VERCEL_TOKEN'] = 'tok';
    process.env['VERCEL_PROJECT_ID'] = 'prj';
    const { deployRollbackRegistration } = await import('../agent/deploy-rollback/registration.js');
    const instance = await deployRollbackRegistration.createAgent(target('application', 'simulator'));
    expect(instance.backend.constructor.name).toBe('DeploySimulator');
    await instance.backend.close();
  });

  it('rejects live targets with a remediation message when credentials are missing', async () => {
    const { deployRollbackRegistration } = await import('../agent/deploy-rollback/registration.js');
    await expect(
      deployRollbackRegistration.createAgent(target('application', 'my-app.vercel.app', 443)),
    ).rejects.toThrow(/VERCEL_TOKEN and VERCEL_PROJECT_ID/);
  });

  it('uses the live client when credentials are present', async () => {
    process.env['VERCEL_TOKEN'] = 'tok';
    process.env['VERCEL_PROJECT_ID'] = 'prj';
    const { deployRollbackRegistration } = await import('../agent/deploy-rollback/registration.js');
    const instance = await deployRollbackRegistration.createAgent(target('application', 'my-app.vercel.app', 443));
    expect(instance.backend.constructor.name).toBe('DeployLiveClient');
    await instance.backend.close();
  });
});
