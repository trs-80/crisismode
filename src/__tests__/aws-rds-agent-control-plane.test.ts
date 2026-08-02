// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { AwsRdsRecoveryAgent } from '../agent/aws-rds/agent.js';
import { RdsRecoverySimulator } from '../agent/aws-rds/simulator.js';
import { assembleContext } from '../framework/context.js';
import type { AgentContext } from '../types/agent-context.js';

function rdsContext(agent: AwsRdsRecoveryAgent): AgentContext {
  return assembleContext(
    {
      type: 'alert',
      source: 'prometheus',
      payload: { alertname: 'RdsControlPlaneCheck', instance_id: 'prod-db-01' },
      receivedAt: new Date().toISOString(),
    },
    agent.manifest,
  );
}

function makeAgent(scenario?: string) {
  const sim = new RdsRecoverySimulator();
  if (scenario) sim.transition!(scenario);
  const agent = new AwsRdsRecoveryAgent(sim);
  return { agent, sim, context: rdsContext(agent) };
}

describe('aws-rds control-plane diagnosis', () => {
  it('healthy scenario yields a healthy assessment with an rds_instance_status signal', async () => {
    const { agent, context } = makeAgent();
    const health = await agent.assessHealth(context);
    expect(health.signals.some((s) => s.source === 'rds_instance_status')).toBe(true);
  });

  it('storage_full yields an unhealthy assessment whose detail says full', async () => {
    const { agent, context } = makeAgent('storage_full');
    const health = await agent.assessHealth(context);
    expect(health.status).not.toBe('healthy');
    const sig = health.signals.find((s) => s.source === 'rds_storage');
    expect(sig).toBeDefined();
    expect(sig!.status).toBe('critical');
    expect(sig!.detail.toLowerCase()).toContain('full');
  });

  it('connection_saturation flags rds_connection_saturation with connection wording', async () => {
    const { agent, context } = makeAgent('connection_saturation');
    const health = await agent.assessHealth(context);
    const sig = health.signals.find((s) => s.source === 'rds_connection_saturation');
    expect(sig).toBeDefined();
    expect(sig!.detail.toLowerCase()).toContain('connection');
  });

  it('sg_blocked produces an rds_security_group finding mentioning connections', async () => {
    const { agent, context } = makeAgent('sg_blocked');
    const diagnosis = await agent.diagnose(context);
    const f = diagnosis.findings.find((x) => x.source === 'rds_security_group');
    expect(f).toBeDefined();
    expect(f!.observation.toLowerCase()).toMatch(/connect/);
  });

  it('iam_denied surfaces rds_iam_permissions signals naming the action, without failing health', async () => {
    const { agent, context } = makeAgent('iam_denied');
    const health = await agent.assessHealth(context);
    const iam = health.signals.filter((s) => s.source === 'rds_iam_permissions');
    expect(iam.length).toBeGreaterThan(0);
    expect(iam[0]!.detail).toMatch(/rds:|cloudwatch:|ec2:/);
    // permission problems are 'unknown', not failures of the database itself
    expect(iam[0]!.status).toBe('unknown');
  });

  it('plans stay at suggestion level: no system_action steps from control-plane findings', async () => {
    const { agent, context } = makeAgent('storage_full');
    const diagnosis = await agent.diagnose(context);
    const plan = await agent.plan(context, diagnosis);
    expect(plan.steps.some((s) => s.type === 'system_action')).toBe(false);
    const text = JSON.stringify(plan.steps);
    expect(text).toContain('RDS console'); // console path present
    expect(text).toContain('aws rds'); // CLI equivalent present
  });

  it('instance_unavailable (e.g. a stopped instance) still yields a suggestion plan, not an empty one', async () => {
    const { agent, context } = makeAgent('instance_stopped');
    const diagnosis = await agent.diagnose(context);
    expect(diagnosis.scenario).toBe('instance_unavailable');

    const plan = await agent.plan(context, diagnosis);
    expect(plan.steps.some((s) => s.type === 'system_action')).toBe(false);
    const notifications = plan.steps.filter((s) => s.type === 'human_notification');
    expect(notifications.length).toBeGreaterThan(0);
    const text = JSON.stringify(notifications);
    expect(text.toLowerCase()).toContain('stopped');
  });
});
