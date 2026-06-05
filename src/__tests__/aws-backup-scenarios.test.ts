// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';

import { AwsS3RecoveryAgent } from '../agent/aws-s3/agent.js';
import { S3RecoverySimulator } from '../agent/aws-s3/simulator.js';
import { AwsRdsRecoveryAgent } from '../agent/aws-rds/agent.js';
import { RdsRecoverySimulator } from '../agent/aws-rds/simulator.js';
import type { InstanceBackupConfig } from '../agent/aws-rds/backend.js';
import { assembleContext } from '../framework/context.js';
import { walkSteps } from '../framework/step-walker.js';
import type { AgentContext } from '../types/agent-context.js';

function s3Context(agent: AwsS3RecoveryAgent): AgentContext {
  return assembleContext(
    {
      type: 'alert',
      source: 'prometheus',
      payload: { alertname: 'S3BackupCheck', bucket: 'prod-backup-bucket' },
      receivedAt: new Date().toISOString(),
    },
    agent.manifest,
  );
}

function rdsContext(agent: AwsRdsRecoveryAgent): AgentContext {
  return assembleContext(
    {
      type: 'alert',
      source: 'prometheus',
      payload: { alertname: 'RdsBackupCheck', instance_id: 'prod-db-01' },
      receivedAt: new Date().toISOString(),
    },
    agent.manifest,
  );
}

describe('AwsS3RecoveryAgent.diagnose — healthy bucket', () => {
  it('does not flag a versioned bucket with lifecycle rules as misconfigured', async () => {
    const simulator = new S3RecoverySimulator();
    simulator.transition('recovered'); // versioning Enabled + lifecycle rules present
    const agent = new AwsS3RecoveryAgent(simulator);

    const diagnosis = await agent.diagnose(s3Context(agent));

    expect(diagnosis.scenario).toBe('healthy');
    expect(diagnosis.status).toBe('inconclusive');
    expect(diagnosis.findings.every((f) => f.severity !== 'critical')).toBe(true);
  });

  it('still flags a suspended bucket without lifecycle rules', async () => {
    const simulator = new S3RecoverySimulator(); // degraded: Suspended + no lifecycle
    const agent = new AwsS3RecoveryAgent(simulator);

    const diagnosis = await agent.diagnose(s3Context(agent));

    expect(diagnosis.scenario).toBe('backup_misconfigured');
    expect(diagnosis.status).toBe('identified');
  });
});

/** Backend returning a healthy-retention instance whose only issue is a stale snapshot. */
class StaleSnapshotRdsSimulator extends RdsRecoverySimulator {
  override async getInstanceBackupConfig(): Promise<InstanceBackupConfig> {
    return {
      instanceId: 'prod-db-01',
      region: 'us-east-1',
      engine: 'postgresql',
      status: 'available',
      backupRetentionPeriod: 14,
      latestSnapshotTime: new Date(Date.now() - 3_000_000_000).toISOString(),
      snapshotCount: 1,
      latestSnapshotAge: 3_000_000, // > 2 * 14 * 86400, so stale
      automatedBackupsEnabled: true,
    };
  }
}

describe('AwsRdsRecoveryAgent.plan — never lowers retention', () => {
  it('diagnoses stale_snapshot for a 14-day-retention instance', async () => {
    const agent = new AwsRdsRecoveryAgent(new StaleSnapshotRdsSimulator());
    const diagnosis = await agent.diagnose(rdsContext(agent));
    expect(diagnosis.scenario).toBe('stale_snapshot');
  });

  it('omits the retention-modify step when retention is already adequate', async () => {
    const agent = new AwsRdsRecoveryAgent(new StaleSnapshotRdsSimulator());
    const context = rdsContext(agent);
    const diagnosis = await agent.diagnose(context);
    const plan = await agent.plan(context, diagnosis);

    // No step should reduce (or even rewrite) the 14-day retention down to 7.
    let modifiesRetention = false;
    walkSteps(plan.steps, (step) => {
      if (
        step.type === 'system_action' &&
        step.command?.operation === 'modify_db_instance'
      ) {
        modifiesRetention = true;
        const target = (step.command.parameters as { backupRetentionPeriod?: number })
          ?.backupRetentionPeriod;
        expect(target ?? 0).toBeGreaterThanOrEqual(14);
      }
    });
    expect(modifiesRetention).toBe(false);

    // The immediate-snapshot recovery step is still present.
    const snapshotStep = plan.steps.find(
      (s) => s.type === 'system_action' && s.command?.operation === 'create_db_snapshot',
    );
    expect(snapshotStep).toBeDefined();
  });

  it('still raises retention from 0 for a backup_disabled instance', async () => {
    const agent = new AwsRdsRecoveryAgent(new RdsRecoverySimulator()); // degraded: retention 0
    const context = rdsContext(agent);
    const diagnosis = await agent.diagnose(context);
    const plan = await agent.plan(context, diagnosis);

    expect(diagnosis.scenario).toBe('backup_disabled');
    const modifyStep = plan.steps.find(
      (s) => s.type === 'system_action' && s.command?.operation === 'modify_db_instance',
    );
    expect(modifyStep).toBeDefined();
    if (modifyStep?.type === 'system_action') {
      const target = (modifyStep.command.parameters as { backupRetentionPeriod?: number })
        ?.backupRetentionPeriod;
      expect(target).toBe(7);
    }
  });
});
