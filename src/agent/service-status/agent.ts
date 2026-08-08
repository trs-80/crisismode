// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { defaultReplan } from '../interface.js';
import type { RecoveryAgent } from '../interface.js';
import type { AgentContext } from '../../types/agent-context.js';
import type { DiagnosisFinding, DiagnosisResult } from '../../types/diagnosis-result.js';
import type { HealthAssessment, HealthSignal, HealthSignalStatus } from '../../types/health.js';
import type { RecoveryPlan } from '../../types/recovery-plan.js';
import type { RecoveryStep } from '../../types/step-types.js';
import { buildHealthAssessment } from '../../framework/health-helpers.js';
import { createPlanEnvelope } from '../../framework/plan-helpers.js';
import { defaultOfflineGate, type OfflineGate } from '../../framework/offline-gate.js';
import type { ServiceStatusReport } from '../../framework/service-status/types.js';
import type { ServiceVerdict } from '../../framework/service-status/types.js';
import { serviceStatusManifest } from './manifest.js';
import type { ServiceStatusBackend } from './backend.js';
import { SERVICE_STATUS_CHECK_IDS } from './check-ids.js';
import { ServiceStatusSimulator } from './simulator.js';
import { HEALTH_STATUS_BY_VERDICT, SCENARIO_BY_VERDICT, worstVerdict } from './verdict-rank.js';

/**
 * Every finding this agent emits carries enough of the source report for
 * plan() to pick the worst service back out of `diagnosis.findings` without
 * re-querying the backend — plan() only receives the DiagnosisResult, not the
 * raw reports (RecoveryAgent's contract).
 */
function findingData(report: ServiceStatusReport): Record<string, unknown> {
  return { serviceId: report.id, label: report.label, verdict: report.verdict, detail: report.detail };
}

/** Status-page fact wording, shared by assessHealth's signals and diagnose's findings — the honesty split's first half. */
function statusPageObservation(report: ServiceStatusReport): string {
  switch (report.statusAssessment) {
    case 'incident_reported':
      return `status page reports an incident${report.incidents.length > 0 ? `: ${report.incidents.map((i) => i.title).join('; ')}` : ''}.`;
    case 'degraded_reported':
      return `status page reports degraded performance${report.incidents.length > 0 ? `: ${report.incidents.map((i) => i.title).join('; ')}` : ''}.`;
    case 'operational':
      return 'status page reports operational.';
    case 'status_unavailable':
      return 'status page could not be checked.';
    case 'no_status_source':
      return 'has no known status page — reachability only.';
    case 'not_checked':
      return 'status was not checked.';
  }
}

function statusPageSignalStatus(report: ServiceStatusReport): HealthSignalStatus {
  switch (report.statusAssessment) {
    case 'incident_reported': return 'critical';
    case 'degraded_reported': return 'warning';
    case 'operational': return 'healthy';
    case 'status_unavailable': return 'unknown';
    case 'no_status_source': return 'unknown';
    case 'not_checked': return 'unknown';
  }
}

function statusPageSeverity(report: ServiceStatusReport): DiagnosisFinding['severity'] {
  switch (report.statusAssessment) {
    case 'incident_reported': return 'critical';
    case 'degraded_reported': return 'warning';
    case 'operational': return 'info';
    case 'status_unavailable': return 'warning';
    case 'no_status_source': return 'info';
    case 'not_checked': return 'info';
  }
}

/** Reachability fact wording — the honesty split's second half, never blended with the status-page fact. */
function reachabilityObservation(report: ServiceStatusReport): string {
  switch (report.probe) {
    case 'reachable': return 'reachable from this machine.';
    case 'dns_failed': return 'could not be reached from this machine (DNS resolution failed).';
    case 'connect_failed': return 'could not be reached from this machine (connection failed).';
    case 'skipped': return 'reachability was not checked.';
  }
}

function reachabilitySignalStatus(report: ServiceStatusReport): HealthSignalStatus {
  switch (report.probe) {
    case 'reachable': return 'healthy';
    case 'dns_failed':
    case 'connect_failed':
      return 'critical';
    case 'skipped':
      return 'unknown';
  }
}

function reachabilitySeverity(report: ServiceStatusReport): DiagnosisFinding['severity'] {
  switch (report.probe) {
    case 'reachable': return 'info';
    case 'dns_failed':
    case 'connect_failed':
      return 'critical';
    case 'skipped':
      return 'info';
  }
}

export class ServiceStatusAgent implements RecoveryAgent {
  manifest = serviceStatusManifest;
  backend: ServiceStatusBackend;
  private readonly offlineGate: OfflineGate;

  constructor(backend?: ServiceStatusBackend, offlineGate: OfflineGate = defaultOfflineGate) {
    this.backend = backend ?? new ServiceStatusSimulator();
    this.offlineGate = offlineGate;
  }

  async assessHealth(_context: AgentContext): Promise<HealthAssessment> {
    const observedAt = new Date().toISOString();

    // Every check this agent runs is a network check, so a localised offline
    // verdict makes both facts unanswerable. Report that honestly and skip
    // the probe rather than blaming the provider for the operator's wifi.
    // The gate reads the CACHED triage report — it never probes.
    const offline = await this.offlineGate();
    if (offline) {
      const detail = `cannot verify while offline — ${offline.explanation}. Run \`crisismode triage\` for the full localization.`;
      return {
        status: 'unknown',
        confidence: 0,
        summary:
          `Third-party service status could not be checked: the ${offline.verdict === 'local' ? 'machine' : 'network'} ` +
          `is offline. ${offline.explanation}.`,
        observedAt,
        signals: [
          { source: 'service_status_page', checkId: SERVICE_STATUS_CHECK_IDS.statusPage, status: 'unknown', detail, observedAt },
          { source: 'service_reachability', checkId: SERVICE_STATUS_CHECK_IDS.reachability, status: 'unknown', detail, observedAt },
        ],
        recommendedActions: [
          'Fix the connectivity problem triage identified, then re-run — the service was never contacted.',
        ],
      };
    }

    const reports = await this.backend.queryServices();
    if (reports.length === 0) {
      return {
        status: 'unknown',
        confidence: 0,
        summary: 'No service-status reports were returned — check the service-status target configuration.',
        observedAt,
        signals: [],
        recommendedActions: ['Add a service to the `services:` list in crisismode.yaml.'],
      };
    }

    const signals: HealthSignal[] = reports.flatMap((report) => [
      {
        source: 'service_status_page',
        checkId: SERVICE_STATUS_CHECK_IDS.statusPage,
        status: statusPageSignalStatus(report),
        detail: `${report.label}: ${statusPageObservation(report)}`,
        observedAt,
        entityId: report.id,
      },
      {
        source: 'service_reachability',
        checkId: SERVICE_STATUS_CHECK_IDS.reachability,
        status: reachabilitySignalStatus(report),
        detail: `${report.label}: ${reachabilityObservation(report)}`,
        observedAt,
        entityId: report.id,
      },
    ]);

    const worst = worstVerdict(reports);
    const status = HEALTH_STATUS_BY_VERDICT[worst];
    const worstReport = reports.find((r) => r.verdict === worst) ?? reports[0]!;

    return buildHealthAssessment({
      status,
      signals,
      confidence: 0.9,
      summary: {
        // Single-service case routes through the report's own detail
        // (verdictDetail's output) rather than a hand-written "X is
        // healthy." — a raw domain's healthy detail carries the
        // "reachability only" qualifier honesty rule 2 requires, which a
        // hardcoded string would silently drop.
        healthy: reports.length > 1
          ? `All ${reports.length} configured third-party services are healthy.`
          : worstReport.detail,
        recovering: worstReport.detail,
        unhealthy: worstReport.detail,
      },
      actions: {
        healthy: ['No action required. Continue monitoring third-party service status.'],
        recovering: ['Watch the provider status page — this may resolve on its own.'],
        unhealthy: ['Run `crisismode down` for the full detail, and `crisismode triage` to rule out this machine or network.'],
      },
    });
  }

  async diagnose(_context: AgentContext): Promise<DiagnosisResult> {
    const offline = await this.offlineGate();
    if (offline) {
      return {
        status: 'unable',
        scenario: null,
        confidence: 0,
        findings: [
          {
            source: 'service_reachability',
            checkId: SERVICE_STATUS_CHECK_IDS.reachability,
            observation: `Third-party services could not be diagnosed from this machine: ${offline.explanation}.`,
            severity: 'info',
            data: { offline },
          },
        ],
        diagnosticPlanNeeded: false,
      };
    }

    const reports = await this.backend.queryServices();

    // Both facts, kept separate all the way to the findings layer — never
    // conflated into a single combined-verdict finding. See checker.ts's
    // module docstring for why.
    const findings: DiagnosisFinding[] = reports.flatMap((report) => [
      {
        source: 'service_status_page',
        checkId: SERVICE_STATUS_CHECK_IDS.statusPage,
        observation: `${report.label} ${statusPageObservation(report)}`,
        severity: statusPageSeverity(report),
        data: findingData(report),
      },
      {
        source: 'service_reachability',
        checkId: SERVICE_STATUS_CHECK_IDS.reachability,
        observation: `${report.label} ${reachabilityObservation(report)}`,
        severity: reachabilitySeverity(report),
        data: findingData(report),
      },
    ]);

    const worst = worstVerdict(reports);
    const scenario = SCENARIO_BY_VERDICT[worst];

    return {
      status: scenario === null ? 'inconclusive' : 'identified',
      scenario,
      confidence: scenario === null ? 0.9 : 0.95,
      findings,
      diagnosticPlanNeeded: false,
    };
  }

  async plan(_context: AgentContext, diagnosis: DiagnosisResult): Promise<RecoveryPlan> {
    // A null scenario means diagnose found nothing actionable. Defaulting to
    // a real failure scenario here would make the plan assert a dependency
    // problem that no check observed — the plan must not out-claim its
    // diagnosis.
    const scenario = diagnosis.scenario ?? 'no_finding';

    if (scenario === 'no_finding') {
      return {
        ...createPlanEnvelope({
          planIdSuffix: 'service-status',
          agentName: 'service-status-diagnosis',
          agentVersion: '1.0.0',
          scenario: 'no_finding',
          estimatedDuration: 'PT0S',
          summary: 'No actionable third-party service issue was found. This agent never mutates a provider — there is nothing to do.',
        }),
        impact: {
          affectedSystems: [],
          affectedServices: [],
          estimatedUserImpact: 'None observed — every checked service reports operational and reachable.',
          dataLossRisk: 'none',
        },
        steps: [],
        rollbackStrategy: {
          type: 'stepwise',
          description: 'Read-only plan: CrisisMode executes nothing that needs rolling back. No actionable service-status issue was found.',
        },
      };
    }

    // Both findings recorded for the worst service carry identical
    // serviceId/label/verdict/detail (see findingData) — the first match is
    // enough to recover which service made this scenario the worst one.
    const worstFinding = diagnosis.findings.find((f) => {
      const verdict = f.data?.['verdict'];
      return typeof verdict === 'string' && SCENARIO_BY_VERDICT[verdict as ServiceVerdict] === scenario;
    });
    const label = String(worstFinding?.data?.['label'] ?? 'The configured service');
    const detail = String(worstFinding?.data?.['detail'] ?? `${label}: ${scenario.replace(/_/g, ' ')}.`);
    const attribution =
      scenario === 'dependency_unreachable'
        ? 'This may be this machine or its network, not the provider — run `crisismode down` or `crisismode triage` to check.'
        : "This is on the provider's side — nothing in your app or infrastructure needs to change.";

    const steps: RecoveryStep[] = [
      {
        stepId: 'step-001',
        type: 'diagnosis_action',
        name: 'Re-capture third-party service status',
        executionContext: 'service_status_read',
        target: 'service-status',
        command: { type: 'structured_command', operation: 'query_services', parameters: {} },
        outputCapture: {
          name: 'current_service_status',
          format: 'structured',
          availableTo: 'subsequent_steps',
        },
        timeout: 'PT30S',
      },
      {
        stepId: 'step-002',
        type: 'human_notification',
        name: `Report ${label}'s status`,
        recipients: [{ role: 'on_call_engineer', urgency: scenario === 'dependency_incident' ? 'high' : 'medium' }],
        message: {
          summary: detail,
          detail: attribution,
          contextReferences: ['current_service_status'],
          actionRequired: scenario === 'dependency_unreachable',
        },
        channel: 'auto',
      },
    ];

    return {
      ...createPlanEnvelope({
        planIdSuffix: 'service-status',
        agentName: 'service-status-diagnosis',
        agentVersion: '1.0.0',
        scenario,
        estimatedDuration: 'PT2M',
        summary: `Report ${label}'s ${scenario.replace(/_/g, ' ')} and tell the operator whose problem it is. Read-only: CrisisMode cannot fix a third-party provider.`,
      }),
      impact: {
        affectedSystems: [
          { identifier: label, technology: 'service-status', role: 'dependency', impactType: 'diagnosis_and_notification' },
        ],
        affectedServices: [label],
        estimatedUserImpact:
          scenario === 'dependency_incident'
            ? 'Features that depend on this service are degraded or failing until the provider resolves the incident.'
            : scenario === 'dependency_degraded'
              ? 'Features that depend on this service may be slow or partially failing.'
              : 'This machine cannot reach the service — whether the app itself is affected depends on whether other environments can.',
        dataLossRisk: 'none',
      },
      steps,
      rollbackStrategy: {
        type: 'stepwise',
        description: 'This plan only reads service status and notifies humans. There are no mutations to roll back.',
      },
    };
  }

  replan = defaultReplan;
}
