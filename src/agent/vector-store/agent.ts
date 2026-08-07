// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { defaultReplan } from '../interface.js';
import type { RecoveryAgent } from '../interface.js';
import type { AgentContext } from '../../types/agent-context.js';
import type { DiagnosisFinding, DiagnosisResult } from '../../types/diagnosis-result.js';
import type { HealthAssessment, HealthSignal, HealthStatus } from '../../types/health.js';
import type { RecoveryPlan } from '../../types/recovery-plan.js';
import type { RecoveryStep } from '../../types/step-types.js';
import { buildHealthAssessment } from '../../framework/health-helpers.js';
import { createPlanEnvelope } from '../../framework/plan-helpers.js';
import { vectorStoreManifest } from './manifest.js';
import type { VectorStoreBackend, VectorStoreCheck, VectorStoreReport } from './backend.js';
import { VECTOR_STORE_CHECK_IDS, type VectorStoreCheckId } from './check-ids.js';
import { VectorStoreSimulator } from './simulator.js';
import { defaultOfflineGate, type OfflineGate } from '../llm-provider/offline-gate.js';

/**
 * Signal source names — the knowledge map (signal-explanations.ts) and the
 * correlation layer key on these. They are mirrored in
 * explanation-coverage.test.ts's REPRESENTATIVE_SOURCES; changing one without
 * the other fails that test.
 */
const SIGNAL_SOURCE: Record<VectorStoreCheckId, string> = {
  [VECTOR_STORE_CHECK_IDS.reachable]: 'vector_store_reachable',
  [VECTOR_STORE_CHECK_IDS.authValid]: 'vector_store_auth',
  [VECTOR_STORE_CHECK_IDS.indexStatus]: 'vector_store_index',
};

/** Check order in emitted signals — stable, so dominantCheckId is predictable. */
const CHECK_ORDER: VectorStoreCheckId[] = [
  VECTOR_STORE_CHECK_IDS.reachable,
  VECTOR_STORE_CHECK_IDS.authValid,
  VECTOR_STORE_CHECK_IDS.indexStatus,
];

/** Total over the check ids, so lookups need no fallback branch. */
const FIX_HINT: Record<VectorStoreCheckId, string> = {
  [VECTOR_STORE_CHECK_IDS.reachable]:
    'Confirm the provider is up on its status page, then re-run. If only this store is unreachable, the outage is on the provider side.',
  [VECTOR_STORE_CHECK_IDS.authValid]:
    'Rotate or re-issue the API key in the provider console and update the environment variable — a rejected key takes retrieval down entirely.',
  [VECTOR_STORE_CHECK_IDS.indexStatus]:
    'Open the provider console: an index that is missing or still initializing means every retrieval query returns nothing.',
};

/** A check that is absent was never run — that is not a failure. */
function failed(check: VectorStoreCheck | undefined): boolean {
  return check?.status === 'fail';
}

function checkOf(report: VectorStoreReport, checkId: string): VectorStoreCheck | undefined {
  return report.checks.find((c) => c.checkId === checkId);
}

export class VectorStoreAgent implements RecoveryAgent {
  manifest = vectorStoreManifest;
  backend: VectorStoreBackend;
  private readonly offlineGate: OfflineGate;

  constructor(backend?: VectorStoreBackend, offlineGate: OfflineGate = defaultOfflineGate) {
    this.backend = backend ?? new VectorStoreSimulator();
    this.offlineGate = offlineGate;
  }

  async assessHealth(_context: AgentContext): Promise<HealthAssessment> {
    const observedAt = new Date().toISOString();

    // Every check this agent runs is a network check, so a localised offline
    // verdict makes all of them unanswerable. Report that honestly and skip
    // the probe rather than blaming the provider for the operator's wifi.
    // The gate reads PR 2's CACHED triage report — it never probes.
    const offline = await this.offlineGate();
    if (offline) {
      // Built directly rather than via buildHealthAssessment: that helper keys
      // its summary/actions maps on healthy|recovering|unhealthy and has no
      // 'unknown' arm, so routing through it would yield "Status: unknown".
      const detail =
        `cannot verify while offline — ${offline.explanation}. ` +
        'Run `crisismode triage` for the full localization.';
      return {
        status: 'unknown',
        confidence: 0,
        summary:
          `Vector stores could not be checked: the ${offline.verdict === 'local' ? 'machine' : 'network'} ` +
          `is offline. ${offline.explanation}.`,
        observedAt,
        signals: CHECK_ORDER.map((checkId) => ({
          source: SIGNAL_SOURCE[checkId],
          checkId,
          status: 'unknown' as const,
          detail,
          observedAt,
        })),
        recommendedActions: [
          'Fix the connectivity problem triage identified, then re-run — the vector stores were never contacted.',
        ],
      };
    }

    const reports = await this.backend.queryVectorStores();

    const signals: HealthSignal[] = [];
    for (const report of reports) {
      for (const check of report.checks) {
        signals.push({
          source: SIGNAL_SOURCE[check.checkId],
          checkId: check.checkId,
          status: check.status === 'pass' ? 'healthy' : check.status === 'fail' ? 'critical' : 'unknown',
          detail: `${report.provider}: ${check.detail}`,
          observedAt,
          entityId: report.provider,
        });
      }
    }

    const down = reports.filter(
      (r) => failed(checkOf(r, VECTOR_STORE_CHECK_IDS.reachable)) || failed(checkOf(r, VECTOR_STORE_CHECK_IDS.authValid)),
    );
    const degraded = reports.filter((r) => failed(checkOf(r, VECTOR_STORE_CHECK_IDS.indexStatus)));
    const allUnknown = signals.length > 0 && signals.every((s) => s.status === 'unknown');

    let status: HealthStatus;
    if (reports.length === 0 || allUnknown) status = 'unknown';
    else if (down.length > 0) status = 'unhealthy';
    else if (degraded.length > 0) status = 'recovering';
    else status = 'healthy';

    const names = reports.map((r) => r.provider).join(', ');
    return buildHealthAssessment({
      status,
      signals,
      confidence: status === 'unknown' ? 0.2 : 0.9,
      summary: {
        healthy: `Vector stores reachable and authenticated: ${names}.`,
        recovering: `Vector store index not ready: ${degraded.map((r) => r.provider).join(', ')}.`,
        unhealthy: `Vector store unavailable: ${down.map((r) => r.provider).join(', ')} — retrieval is failing.`,
      },
      actions: {
        healthy: ['No action required. Continue monitoring vector-store reachability and index readiness.'],
        recovering: ['Check the index state in the provider console; retrieval returns nothing until it is ready.'],
        unhealthy: ['Verify the API key and the provider status page — RAG features are down while this persists.'],
      },
    });
  }

  async diagnose(_context: AgentContext): Promise<DiagnosisResult> {
    const reports = await this.backend.queryVectorStores();
    const findings: DiagnosisFinding[] = [];
    let scenario: string | null = null;

    for (const report of reports) {
      for (const check of report.checks) {
        const severity = check.status === 'fail' ? 'critical' : check.status === 'unknown' ? 'warning' : 'info';
        findings.push({
          source: SIGNAL_SOURCE[check.checkId],
          observation: `${report.provider} (${report.keyFingerprint}): ${check.detail}`,
          severity,
          data: { provider: report.provider, checkId: check.checkId, status: check.status },
          explanation: FIX_HINT[check.checkId],
        });
      }
      if (scenario === null) {
        if (failed(checkOf(report, VECTOR_STORE_CHECK_IDS.reachable))) {
          scenario = 'unreachable';
        } else if (failed(checkOf(report, VECTOR_STORE_CHECK_IDS.authValid))) {
          scenario = 'auth_rejected';
        } else if (failed(checkOf(report, VECTOR_STORE_CHECK_IDS.indexStatus))) {
          scenario = report.indexes.length === 0 ? 'no_indexes' : 'index_not_ready';
        }
      }
    }

    return {
      status: scenario === null ? 'inconclusive' : 'identified',
      scenario,
      confidence: scenario === null ? 0.6 : 0.9,
      findings,
      diagnosticPlanNeeded: false,
    };
  }

  async plan(_context: AgentContext, diagnosis: DiagnosisResult): Promise<RecoveryPlan> {
    const steps: RecoveryStep[] = [
      {
        stepId: 'step-001',
        type: 'diagnosis_action',
        name: 'Capture current vector-store state',
        executionContext: 'vector_store_read',
        target: 'vector-store',
        command: { type: 'structured_command', operation: 'query_vector_stores', parameters: {} },
        outputCapture: {
          name: 'current_vector_store_state',
          format: 'structured',
          availableTo: 'subsequent_steps',
        },
        timeout: 'PT30S',
      },
    ];

    let sequence = 2;
    for (const finding of diagnosis.findings) {
      if (finding.severity !== 'critical') continue;
      const checkId = String(finding.data?.['checkId'] ?? '') as VectorStoreCheckId;
      steps.push({
        stepId: `step-${String(sequence).padStart(3, '0')}`,
        type: 'human_notification',
        name: `Vector store needs attention: ${String(finding.data?.['provider'] ?? 'unknown')}`,
        recipients: [{ role: 'on_call_engineer', urgency: 'high' }],
        message: {
          summary: finding.observation,
          detail: FIX_HINT[checkId] ?? 'Review the vector store in the provider console.',
          contextReferences: ['current_vector_store_state'],
          actionRequired: true,
        },
        channel: 'auto',
      });
      sequence += 1;
    }

    return {
      ...createPlanEnvelope({
        planIdSuffix: 'vector-store',
        agentName: 'vector-store-diagnosis',
        agentVersion: '1.0.0',
        scenario: diagnosis.scenario ?? 'healthy',
        estimatedDuration: 'PT5M',
        summary:
          `Vector-store findings: ${diagnosis.scenario ?? 'no issues detected'}. ` +
          'No mutations performed — operator action required.',
      }),
      impact: {
        affectedSystems: [],
        affectedServices: ['retrieval'],
        estimatedUserImpact: 'No action is taken by CrisisMode — suggestions only.',
        dataLossRisk: 'none',
      },
      steps,
      rollbackStrategy: {
        type: 'stepwise',
        description:
          'Read-only plan: CrisisMode executes nothing that needs rolling back. Every remediation is operator-run in the provider console.',
      },
    };
  }

  replan = defaultReplan;
}
