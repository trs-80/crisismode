// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';

// Mock the Anthropic SDK so agent.ts can be imported without the dependency
vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }));

import { assembleContext } from '../framework/context.js';
import { pgReplicationManifest } from '../agent/pg-replication/manifest.js';
import type { AgentContext } from '../types/agent-context.js';

function makeTrigger(): AgentContext['trigger'] {
  return {
    type: 'alert',
    source: 'prometheus',
    payload: {
      alertname: 'PostgresReplicationLagCritical',
      instance: 'pg-primary-us-east-1',
      severity: 'critical',
    },
    receivedAt: new Date().toISOString(),
  };
}

describe('assembleContext', () => {
  it('returns an object with trigger, topology, frameworkLayers, and trustLevel', () => {
    const trigger = makeTrigger();
    const ctx = assembleContext(trigger, pgReplicationManifest);

    expect(ctx.trigger).toBe(trigger);
    expect(ctx.topology).toBeDefined();
    expect(ctx.frameworkLayers).toBeDefined();
    expect(ctx.trustLevel).toBeDefined();
  });

  it('topology has components and relationships', () => {
    const ctx = assembleContext(makeTrigger(), pgReplicationManifest);

    expect(ctx.topology.components.length).toBeGreaterThan(0);
    expect(ctx.topology.relationships.length).toBeGreaterThan(0);
    // Check a known component
    const primary = ctx.topology.components.find((c) => c.role === 'primary');
    expect(primary).toBeDefined();
    expect(primary!.technology).toBe('postgresql');
  });

  it('frameworkLayers has execution_kernel, safety, coordination, and enrichment', () => {
    const ctx = assembleContext(makeTrigger(), pgReplicationManifest);

    expect(ctx.frameworkLayers).toHaveProperty('execution_kernel');
    expect(ctx.frameworkLayers).toHaveProperty('safety');
    expect(ctx.frameworkLayers).toHaveProperty('coordination');
    expect(ctx.frameworkLayers).toHaveProperty('enrichment');
  });

  it('trustLevel is copilot', () => {
    const ctx = assembleContext(makeTrigger(), pgReplicationManifest);
    expect(ctx.trustLevel).toBe('copilot');
  });

  it('organizationalPolicies has expected fields', () => {
    const ctx = assembleContext(makeTrigger(), pgReplicationManifest);

    expect(ctx.organizationalPolicies).toBeDefined();
    expect(ctx.organizationalPolicies.maxAutonomousRiskLevel).toBe('routine');
    expect(ctx.organizationalPolicies.requireApprovalAbove).toBe('routine');
    expect(typeof ctx.organizationalPolicies.shellCommandsEnabled).toBe('boolean');
    expect(typeof ctx.organizationalPolicies.approvalTimeoutMinutes).toBe('number');
    expect(typeof ctx.organizationalPolicies.escalationDepth).toBe('number');
  });

  it('availableExecutionContexts matches manifest execution contexts', () => {
    const ctx = assembleContext(makeTrigger(), pgReplicationManifest);

    const expectedNames = pgReplicationManifest.spec.executionContexts.map((ec) => ec.name);
    expect(ctx.availableExecutionContexts).toEqual(expectedNames);
  });
});
