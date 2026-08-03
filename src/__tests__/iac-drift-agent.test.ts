// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { IacDriftRecoveryAgent } from '../agent/iac-drift/agent.js';
import { IacDriftSimulator } from '../agent/iac-drift/simulator.js';
import { assembleContext } from '../framework/context.js';
import type { AgentContext } from '../types/agent-context.js';

function iacContext(agent: IacDriftRecoveryAgent): AgentContext {
  return assembleContext(
    { type: 'health_check', source: 'test', payload: {}, receivedAt: new Date().toISOString() },
    agent.manifest,
  );
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
});
