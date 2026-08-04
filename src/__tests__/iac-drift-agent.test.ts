// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { IacDriftRecoveryAgent } from '../agent/iac-drift/agent.js';
import { IacDriftSimulator } from '../agent/iac-drift/simulator.js';
import type {
  IacDriftBackend,
  IacStateStatus,
  ResourceExistence,
} from '../agent/iac-drift/backend.js';
import type { IacResource } from '../agent/iac-drift/state-parser.js';
import type { DriftComparison } from '../agent/iac-drift/drift-compare.js';
import type { PermissionMissing } from '../agent/aws-common.js';
import type { CheckExpression, Command } from '../types/common.js';
import { assembleContext } from '../framework/context.js';
import type { AgentContext } from '../types/agent-context.js';

function iacContext(agent: IacDriftRecoveryAgent): AgentContext {
  return assembleContext(
    { type: 'health_check', source: 'test', payload: {}, receivedAt: new Date().toISOString() },
    agent.manifest,
  );
}

const PROD_DB: IacResource = {
  type: 'aws_db_instance',
  name: 'main',
  id: 'prod-db',
  attributes: {},
};

/** A backend whose existence AND drift checks are both IAM-permission-gated —
 *  the simulator never returns PermissionMissing, so diagnose()'s "stay silent
 *  on permission-missing resources" behavior needs a fake backend to exercise. */
class PermissionMissingBackend implements IacDriftBackend {
  async getStateStatus(): Promise<IacStateStatus> {
    return { source: 'local', detail: 'terraform.tfstate', readable: true, serial: 1, resourceCounts: { aws_db_instance: 1 } };
  }
  async listManagedResources(): Promise<IacResource[]> {
    return [PROD_DB];
  }
  async checkResourceExistence(): Promise<ResourceExistence | PermissionMissing> {
    return { permissionMissing: 'rds:DescribeDBInstances' };
  }
  async getResourceDrift(): Promise<DriftComparison | PermissionMissing | null> {
    return { permissionMissing: 'rds:DescribeDBInstances' };
  }
  async executeCommand(_command: Command): Promise<unknown> {
    return {};
  }
  async evaluateCheck(_check: CheckExpression): Promise<boolean> {
    return true;
  }
  async close(): Promise<void> {}
}

/** A backend reporting a stale (>30 day) state with a missing resource — the
 *  simulator never sets staleDays, so a fake backend is needed to exercise
 *  the staleness cap on diagnose()'s iac_resource_missing finding. */
class StaleMissingBackend implements IacDriftBackend {
  async getStateStatus(): Promise<IacStateStatus> {
    return { source: 'local', detail: 'terraform.tfstate', readable: true, serial: 1, staleDays: 45, resourceCounts: { aws_s3_bucket: 1 } };
  }
  async listManagedResources(): Promise<IacResource[]> {
    return [{ type: 'aws_s3_bucket', name: 'uploads', id: 'user-uploads', attributes: {} }];
  }
  async checkResourceExistence(): Promise<ResourceExistence | PermissionMissing> {
    return { existence: 'missing' };
  }
  async getResourceDrift(): Promise<DriftComparison | PermissionMissing | null> {
    throw new Error('must not be called — resource is missing, drift is not independently checked');
  }
  async executeCommand(_command: Command): Promise<unknown> {
    return {};
  }
  async evaluateCheck(_check: CheckExpression): Promise<boolean> {
    return true;
  }
  async close(): Promise<void> {}
}

/** A backend whose existence check comes back 'unknown' (non-permission) for
 *  every resource — e.g. AWS SDKs absent, or a state full of types with no
 *  existence check yet. Exercises the "nothing could be verified" honesty
 *  override: assessHealth must not report a clean match when it verified
 *  nothing. */
class AllUnknownBackend implements IacDriftBackend {
  async getStateStatus(): Promise<IacStateStatus> {
    return { source: 'local', detail: 'terraform.tfstate', readable: true, serial: 1, resourceCounts: { aws_db_instance: 1, aws_s3_bucket: 1 } };
  }
  async listManagedResources(): Promise<IacResource[]> {
    return [
      PROD_DB,
      { type: 'aws_s3_bucket', name: 'uploads', id: 'user-uploads', attributes: {} },
    ];
  }
  async checkResourceExistence(): Promise<ResourceExistence | PermissionMissing> {
    return { existence: 'unknown', reason: '@aws-sdk/client-rds is not installed' };
  }
  async getResourceDrift(): Promise<DriftComparison | PermissionMissing | null> {
    return null;
  }
  async executeCommand(_command: Command): Promise<unknown> {
    return {};
  }
  async evaluateCheck(_check: CheckExpression): Promise<boolean> {
    return true;
  }
  async close(): Promise<void> {}
}

/** One resource verified ('exists'), one resource's existence unknown —
 *  exercises the partial-coverage disclosure appended to the summary. */
class PartiallyVerifiedBackend implements IacDriftBackend {
  async getStateStatus(): Promise<IacStateStatus> {
    return { source: 'local', detail: 'terraform.tfstate', readable: true, serial: 1, resourceCounts: { aws_db_instance: 1, aws_elasticache_cluster: 1 } };
  }
  async listManagedResources(): Promise<IacResource[]> {
    return [
      PROD_DB,
      { type: 'aws_elasticache_cluster', name: 'cache', id: 'app-cache', attributes: {} },
    ];
  }
  async checkResourceExistence(resource: IacResource): Promise<ResourceExistence | PermissionMissing> {
    if (resource.type === 'aws_db_instance') return { existence: 'exists' };
    return { existence: 'unknown', reason: 'no existence check for aws_elasticache_cluster yet' };
  }
  async getResourceDrift(): Promise<DriftComparison | PermissionMissing | null> {
    return null;
  }
  async executeCommand(_command: Command): Promise<unknown> {
    return {};
  }
  async evaluateCheck(_check: CheckExpression): Promise<boolean> {
    return true;
  }
  async close(): Promise<void> {}
}

/** Existence succeeds for both resources, but drift is IAM-denied for one —
 *  models a real asymmetric IAM policy (e.g. s3:ListBucket allowed but
 *  s3:GetBucketVersioning/GetBucketLifecycleConfiguration denied, or
 *  dynamodb:DescribeTable allowed but dynamodb:DescribeContinuousBackups
 *  denied). The drift-denied resource's existence WAS verified, but its
 *  drift status was not — it must still count toward the coverage
 *  disclosure, not read as a silently-clean resource. */
class DriftDeniedBackend implements IacDriftBackend {
  async getStateStatus(): Promise<IacStateStatus> {
    return { source: 'local', detail: 'terraform.tfstate', readable: true, serial: 1, resourceCounts: { aws_db_instance: 1, aws_s3_bucket: 1 } };
  }
  async listManagedResources(): Promise<IacResource[]> {
    return [
      PROD_DB,
      { type: 'aws_s3_bucket', name: 'uploads', id: 'user-uploads', attributes: {} },
    ];
  }
  async checkResourceExistence(): Promise<ResourceExistence | PermissionMissing> {
    return { existence: 'exists' };
  }
  async getResourceDrift(resource: IacResource): Promise<DriftComparison | PermissionMissing | null> {
    if (resource.type === 'aws_db_instance') return { permissionMissing: 'rds:DescribeDBInstances' };
    return null;
  }
  async executeCommand(_command: Command): Promise<unknown> {
    return {};
  }
  async evaluateCheck(_check: CheckExpression): Promise<boolean> {
    return true;
  }
  async close(): Promise<void> {}
}

describe('IacDriftRecoveryAgent.assessHealth', () => {
  it('drifted: unhealthy, with entityIds on resource signals', async () => {
    const agent = new IacDriftRecoveryAgent(new IacDriftSimulator('drifted'));
    const health = await agent.assessHealth(iacContext(agent));
    expect(health.status).toBe('unhealthy'); // a Terraform-managed bucket is GONE
    const missing = health.signals.find((s) => s.source === 'iac_resource_missing');
    expect(missing).toMatchObject({ status: 'critical', entityId: 'user-uploads' });
    const drift = health.signals.find((s) => s.source === 'iac_attribute_drift');
    expect(drift).toMatchObject({ status: 'warning', entityId: 'prod-db' });
    expect(drift!.detail).toContain('instance_class');
    expect(drift!.detail).toContain('db.t3.large');
  });

  it('aligned: healthy', async () => {
    const agent = new IacDriftRecoveryAgent(new IacDriftSimulator('aligned'));
    expect((await agent.assessHealth(iacContext(agent))).status).toBe('healthy');
  });

  it('state_unreadable: unknown, never a guess', async () => {
    const agent = new IacDriftRecoveryAgent(new IacDriftSimulator('state_unreadable'));
    const health = await agent.assessHealth(iacContext(agent));
    expect(health.status).toBe('unknown');
    expect(health.signals.find((s) => s.source === 'iac_state')!.detail).toContain('could not');
  });

  it('all-unknown existence: unknown status, honest "could not be verified" summary — never a false clean claim', async () => {
    const agent = new IacDriftRecoveryAgent(new AllUnknownBackend());
    const health = await agent.assessHealth(iacContext(agent));
    expect(health.status).toBe('unknown');
    expect(health.summary).toContain('none could be verified');
    expect(health.summary).not.toContain('matches observed AWS infrastructure');
    expect(health.confidence).toBeLessThan(0.9);
  });

  it('fully IAM-blocked: unknown status, never claims "0 resource(s) drifted" (implies verified-no-drift)', async () => {
    const agent = new IacDriftRecoveryAgent(new PermissionMissingBackend());
    const health = await agent.assessHealth(iacContext(agent));
    expect(health.status).toBe('unknown');
    expect(health.summary).toContain('none could be verified');
    expect(health.summary).not.toContain('0 resource(s) drifted');
  });

  it('partial verification: summary discloses how many resources could not be verified', async () => {
    const agent = new IacDriftRecoveryAgent(new PartiallyVerifiedBackend());
    const health = await agent.assessHealth(iacContext(agent));
    expect(health.status).not.toBe('unknown'); // one resource WAS verified
    expect(health.summary).toContain('1 of 2 resource(s) could not be verified');
  });

  it('drift permission denied on an otherwise-verified resource still counts toward the unverified disclosure', async () => {
    const agent = new IacDriftRecoveryAgent(new DriftDeniedBackend());
    const health = await agent.assessHealth(iacContext(agent));
    expect(health.status).not.toBe('unknown'); // the bucket WAS fully verified
    expect(health.confidence).toBeLessThan(0.9);
    expect(health.summary).toContain('1 of 2 resource(s) could not be verified');
    // The original bug: a drift-permission-missing resource read as
    // "0 resource(s) drifted" with no hint that drift was never actually
    // checked. If that phrase appears, the disclosure MUST appear with it.
    if (health.summary.includes('0 resource(s) drifted')) {
      expect(health.summary).toContain('could not be verified');
    }
  });
});

describe('IacDriftRecoveryAgent.diagnose', () => {
  it('drifted: emits missing + drift findings with resource data', async () => {
    const agent = new IacDriftRecoveryAgent(new IacDriftSimulator('drifted'));
    const d = await agent.diagnose(iacContext(agent));
    expect(d.scenario).toBe('resource_missing'); // missing outranks drift
    const missing = d.findings.find((f) => f.source === 'iac_resource_missing')!;
    expect(missing.severity).toBe('critical');
    expect(missing.data).toMatchObject({ resourceType: 'aws_s3_bucket', resourceId: 'user-uploads' });
    const drift = d.findings.find((f) => f.source === 'iac_attribute_drift')!;
    expect(drift.severity).toBe('warning');
    expect(drift.observation).toContain('terraform apply'); // names the direction of danger
    expect(drift.data).toMatchObject({ resourceId: 'prod-db' });
  });

  it('state_unreadable: single iac_state_unreadable finding, no partial output', async () => {
    const agent = new IacDriftRecoveryAgent(new IacDriftSimulator('state_unreadable'));
    const d = await agent.diagnose(iacContext(agent));
    expect(d.findings.map((f) => f.source)).toEqual(['iac_state_unreadable']);
  });

  it('permission-missing existence/drift produces no finding — health-signal-only, never a guess', async () => {
    const agent = new IacDriftRecoveryAgent(new PermissionMissingBackend());
    const d = await agent.diagnose(iacContext(agent));
    expect(d.findings).toEqual([]);
    // the same condition IS visible via the health assessment's iac_iam_permissions signal
    const health = await agent.assessHealth(iacContext(agent));
    expect(health.signals.some((s) => s.source === 'iac_iam_permissions')).toBe(true);
  });

  it('stale state: downgraded iac_resource_missing finding carries the staleness caveat', async () => {
    const agent = new IacDriftRecoveryAgent(new StaleMissingBackend());
    const d = await agent.diagnose(iacContext(agent));
    const missing = d.findings.find((f) => f.source === 'iac_resource_missing')!;
    expect(missing.severity).toBe('warning'); // downgraded from critical by staleness
    expect(missing.observation).toContain('state may be stale — re-run after terraform refresh');
  });
});
