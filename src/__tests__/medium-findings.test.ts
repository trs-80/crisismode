// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the Anthropic SDK so agent.ts can be imported without the dependency.
vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }));

import {
  registerActionTemplate,
  resetActionTemplateRegistry,
} from '../framework/action-template-registry.js';
import type { ActionTemplate } from '../types/action-template.js';
import { S3RecoverySimulator } from '../agent/aws-s3/simulator.js';
import { AwsDynamoDbRecoveryAgent } from '../agent/aws-dynamodb/agent.js';
import { DynamoDbRecoverySimulator } from '../agent/aws-dynamodb/simulator.js';
import { AwsRdsRecoveryAgent } from '../agent/aws-rds/agent.js';
import { RdsRecoverySimulator } from '../agent/aws-rds/simulator.js';
import { assembleContext } from '../framework/context.js';
import type { AgentContext } from '../types/agent-context.js';

// ── action-template-registry: risk-based state-capture guard ──

const baseElevatedTemplate: ActionTemplate = {
  action_id: 'test_elevated_action',
  display_name: 'Test elevated action',
  description: 'An elevated-risk mutation for testing the registry guard.',
  skill_domain: 'service',
  action_class: 1, // below the class >= 2 threshold on purpose
  mutation_type: 'state_mutation',
  step_type: 'system_action',
  target_kinds: ['service'],
  required_capabilities: ['svc.restart'],
  execution_context: 'service_write',
  default_timeout: 'PT30S',
  risk_level: 'elevated',
  blast_radius: {
    directComponents: ['svc'],
    indirectComponents: [],
    maxImpact: 'restart',
    cascadeRisk: 'low',
  },
};

describe('action-template-registry — elevated+ requires state captures', () => {
  beforeEach(() => resetActionTemplateRegistry());

  it('rejects an elevated system_action (action_class 1) without state_captures_before', () => {
    expect(() => registerActionTemplate(baseElevatedTemplate)).toThrow(
      /elevated risk requires state_captures_before/,
    );
  });

  it('accepts the same template once before-captures are supplied', () => {
    expect(() =>
      registerActionTemplate({
        ...baseElevatedTemplate,
        state_captures_before: [
          {
            name: 'svc_state',
            captureType: 'command_output',
            statement: 'systemctl status svc',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      }),
    ).not.toThrow();
  });

  it('still allows a routine system_action without captures', () => {
    expect(() =>
      registerActionTemplate({
        ...baseElevatedTemplate,
        action_id: 'test_routine_action',
        risk_level: 'routine',
      }),
    ).not.toThrow();
  });
});

// ── aws-s3 simulator: validated transition ──

describe('AWS simulators — validated transition', () => {
  it('S3 throws on an unknown target state instead of corrupting internal state', () => {
    const sim = new S3RecoverySimulator();
    expect(() => sim.transition('bogus')).toThrow(/Invalid S3 simulator state/);
    expect(() => sim.transition('recovering')).not.toThrow();
    expect(() => sim.transition('recovered')).not.toThrow();
    expect(() => sim.transition('degraded')).not.toThrow();
  });

  it('RDS throws on an unknown target state', () => {
    const sim = new RdsRecoverySimulator();
    expect(() => sim.transition('bogus')).toThrow(/Invalid RDS simulator state/);
    expect(() => sim.transition('recovering')).not.toThrow();
    expect(() => sim.transition('recovered')).not.toThrow();
    expect(() => sim.transition('degraded')).not.toThrow();
  });

  it('DynamoDB throws on an unknown target state (incl. the unsupported "recovering")', () => {
    const sim = new DynamoDbRecoverySimulator();
    expect(() => sim.transition('bogus')).toThrow(/Invalid DynamoDB simulator state/);
    // DynamoDB only models degraded/recovered — guarding here also prevents a
    // transition into a state getTableBackupConfig() can't resolve.
    expect(() => sim.transition('recovering')).toThrow(/Invalid DynamoDB simulator state/);
    expect(() => sim.transition('recovered')).not.toThrow();
    expect(() => sim.transition('degraded')).not.toThrow();
  });
});

// ── aws-dynamodb agent: healthy diagnosis yields a no-op plan ──

function dynamoContext(agent: AwsDynamoDbRecoveryAgent, table?: string): AgentContext {
  return assembleContext(
    {
      type: 'alert',
      source: 'prometheus',
      payload: table ? { table } : {},
      receivedAt: new Date().toISOString(),
    },
    agent.manifest,
  );
}

describe('AwsDynamoDbRecoveryAgent.plan — healthy short-circuit', () => {
  it('returns an empty no-op plan when PITR is already enabled', async () => {
    const sim = new DynamoDbRecoverySimulator();
    sim.transition('recovered'); // pitrEnabled true → scenario 'healthy'
    const agent = new AwsDynamoDbRecoveryAgent(sim);
    const context = dynamoContext(agent);

    const diagnosis = await agent.diagnose(context);
    expect(diagnosis.scenario).toBe('healthy');

    const plan = await agent.plan(context, diagnosis);
    expect(plan.steps).toEqual([]);
    expect(plan.metadata.scenario).toBe('healthy');
    expect(plan.rollbackStrategy.type).toBe('none');
  });

  it('still builds the full workflow when PITR is disabled', async () => {
    const agent = new AwsDynamoDbRecoveryAgent(new DynamoDbRecoverySimulator()); // degraded
    const context = dynamoContext(agent);
    const diagnosis = await agent.diagnose(context);
    const plan = await agent.plan(context, diagnosis);

    expect(diagnosis.scenario).toBe('pitr_disabled');
    expect(plan.steps.length).toBeGreaterThan(0);
  });

  it('targets the diagnosed table when the trigger omits it', async () => {
    const agent = new AwsDynamoDbRecoveryAgent(new DynamoDbRecoverySimulator());
    const context = dynamoContext(agent); // no table in payload
    const diagnosis = await agent.diagnose(context);
    const plan = await agent.plan(context, diagnosis);

    expect(plan.impact.affectedSystems[0].identifier).toBe('orders-production');
  });
});

// ── aws-rds agent: plan targets the diagnosed instance ──

describe('AwsRdsRecoveryAgent.plan — instance fallback', () => {
  it('targets the diagnosed instance id when the trigger omits instance_id', async () => {
    const agent = new AwsRdsRecoveryAgent(new RdsRecoverySimulator()); // degraded: prod-db-01
    const context = assembleContext(
      { type: 'alert', source: 'prometheus', payload: {}, receivedAt: new Date().toISOString() },
      agent.manifest,
    );

    const diagnosis = await agent.diagnose(context);
    const plan = await agent.plan(context, diagnosis);

    expect(plan.impact.affectedSystems[0].identifier).toBe('prod-db-01');
    expect(plan.impact.affectedSystems[0].identifier).not.toBe('unknown-instance');
  });
});
