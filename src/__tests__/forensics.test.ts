// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { ForensicRecorder } from '../framework/forensics.js';
import { executeCapture } from '../framework/safety.js';
import { assembleContext } from '../framework/context.js';
import { pgReplicationManifest } from '../agent/pg-replication/manifest.js';
import type { DiagnosisResult } from '../types/diagnosis-result.js';
import type { StepResult } from '../types/execution-state.js';

function makeDiagnosis(): DiagnosisResult {
  return {
    status: 'identified',
    scenario: 'replication_lag_cascade',
    confidence: 0.9,
    findings: [],
    diagnosticPlanNeeded: false,
  };
}

function makeRecorder(): ForensicRecorder {
  const recorder = new ForensicRecorder();
  recorder.setContext(assembleContext({
    type: 'alert',
    source: 'prometheus',
    payload: {
      alertname: 'PostgresReplicationLagCritical',
      instance: 'pg-primary-us-east-1',
      severity: 'critical',
    },
    receivedAt: new Date().toISOString(),
  }, pgReplicationManifest));
  recorder.setDiagnosis(makeDiagnosis());
  return recorder;
}

describe('ForensicRecorder', () => {
  it('preserves the original capture type in forensic records', () => {
    const recorder = makeRecorder();
    recorder.addCapture(executeCapture({
      name: 'node_state_snapshot',
      captureType: 'command_output',
      statement: 'kubectl get nodes -o json',
      captureCost: 'negligible',
      capturePolicy: 'required',
    }));

    const record = recorder.buildRecord();
    expect(record.captures[0]?.captureType).toBe('command_output');
  });

  it('marks the record as aborted when execution is skipped at a human approval gate', () => {
    const recorder = makeRecorder();
    const result: StepResult = {
      stepId: 'step-007',
      step: {
        stepId: 'step-007',
        type: 'human_approval',
        name: 'Approve resynchronization',
        approvers: [{ role: 'on_call_dba', required: true }],
        requiredApprovals: 1,
        presentation: {
          summary: 'Approve the next phase',
          detail: 'The next step resynchronizes the replica.',
          proposedActions: ['Run resynchronization'],
          alternatives: [
            { action: 'skip', description: 'Leave the replica degraded.' },
            { action: 'abort', description: 'Abort the plan.' },
          ],
        },
        timeout: 'PT15M',
        timeoutAction: 'skip',
      },
      status: 'skipped',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 10,
    };
    recorder.addStepResult(result);

    const record = recorder.buildRecord();
    expect(record.summary.outcome).toBe('aborted');
  });
});
