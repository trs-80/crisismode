// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { defaultReplan } from '../interface.js';
import type { RecoveryAgent } from '../interface.js';
import type { AgentContext } from '../../types/agent-context.js';
import type { DiagnosisResult, DiagnosisFinding } from '../../types/diagnosis-result.js';
import type { HealthAssessment, HealthSignal, HealthStatus } from '../../types/health.js';
import type { RecoveryPlan, AffectedSystem } from '../../types/recovery-plan.js';
import type { RecoveryStep } from '../../types/step-types.js';
import { createPlanEnvelope } from '../../framework/plan-helpers.js';
import { isPermissionMissing } from '../aws-common.js';
import type { PermissionMissing } from '../aws-common.js';
import { iacDriftManifest } from './manifest.js';
import { isDriftUnknown } from './backend.js';
import type { IacDriftBackend, IacStateStatus, ResourceExistence, DriftUnknown } from './backend.js';
import { WATCHABLE_TF_TYPES } from './state-parser.js';
import type { IacResource } from './state-parser.js';
import type { AttributeDrift, DriftComparison } from './drift-compare.js';

/** Appended to any resource-level detail/observation downgraded by a stale state. */
const STALE_CAVEAT = 'state may be stale — re-run after terraform refresh';

/** One managed resource plus its independently-queried existence and drift outcomes. */
interface CollectedItem {
  resource: IacResource;
  existence: ResourceExistence | PermissionMissing;
  drift: DriftComparison | PermissionMissing | DriftUnknown | null;
}

interface CollectResult {
  status: IacStateStatus;
  items: CollectedItem[];
}

function isStale(status: IacStateStatus): boolean {
  return (status.staleDays !== undefined && status.staleDays > 30) || status.dirtyTfFiles === true;
}

function stateUnreadableDetail(status: IacStateStatus): string {
  return `CrisisMode found Terraform but could not read its state: ${status.reason ?? 'unknown reason'}`;
}

/** First drift verbatim, "+N more" for the rest — used by the iac_attribute_drift health signal. */
function formatDriftDetail(resource: IacResource, drift: DriftComparison): string {
  const first = drift.drifts[0]!;
  const more = drift.drifts.length > 1 ? ` (+${drift.drifts.length - 1} more)` : '';
  return `${resource.type} ${resource.id}: ${first.attribute} intended ${first.intended}, observed ${first.observed}${more}`;
}

/** Every drift, semicolon-joined — used in the plan() suggestion detail so the operator sees the full list, not just the first. */
function formatDriftList(drifts: AttributeDrift[]): string {
  return drifts.map((d) => `${d.attribute} intended ${d.intended}, observed ${d.observed}`).join('; ');
}

/** Pulls the type/id/name a resource-level finding recorded in diagnose(), falling back to
 *  placeholders for findings that carry no resource data (e.g. iac_state_stale). */
function resourceLabel(data: Record<string, unknown> | undefined): { type: string; id: string; name: string } {
  return {
    type: typeof data?.resourceType === 'string' ? data.resourceType : 'resource',
    id: typeof data?.resourceId === 'string' ? data.resourceId : 'unknown',
    name: typeof data?.resourceName === 'string' ? data.resourceName : 'unknown',
  };
}

export class IacDriftRecoveryAgent implements RecoveryAgent {
  manifest = iacDriftManifest;
  backend: IacDriftBackend;

  constructor(backend: IacDriftBackend) {
    this.backend = backend;
  }

  /**
   * Gathers state status and, when the state is readable, every managed
   * resource's existence and drift outcome. Shared by assessHealth() and
   * diagnose() so the two views of the world can never disagree. Existence
   * and drift are queried independently per resource — EXCEPT when a
   * resource is missing, in which case getResourceDrift() is never called
   * for it: a missing resource earns only a missing finding, never a drift
   * finding.
   */
  private async collect(): Promise<CollectResult> {
    const status = await this.backend.getStateStatus();
    if (!status.readable) return { status, items: [] };

    const resources = await this.backend.listManagedResources();
    const items: CollectedItem[] = [];
    for (const resource of resources) {
      const existence = await this.backend.checkResourceExistence(resource);
      const isMissing = 'existence' in existence && existence.existence === 'missing';
      const drift = isMissing ? null : await this.backend.getResourceDrift(resource);
      items.push({ resource, existence, drift });
    }
    return { status, items };
  }

  async assessHealth(_context: AgentContext): Promise<HealthAssessment> {
    const observedAt = new Date().toISOString();
    const { status, items } = await this.collect();

    if (!status.readable) {
      const detail = stateUnreadableDetail(status);
      return {
        status: 'unknown',
        confidence: 0,
        summary: detail,
        observedAt,
        signals: [{ source: 'iac_state', status: 'warning', detail, observedAt }],
        recommendedActions: ['Fix Terraform state readability, then re-run the drift scan.'],
      };
    }

    const stale = isStale(status);
    const signals: HealthSignal[] = [];

    if (stale) {
      const staleness = status.staleDays !== undefined
        ? `${status.staleDays} day(s) old`
        : 'has uncommitted *.tf changes';
      signals.push({
        source: 'iac_state',
        status: 'warning',
        detail: `Terraform state is stale (${staleness}) — ${STALE_CAVEAT}.`,
        observedAt,
      });
    } else {
      const resourceCount = Object.values(status.resourceCounts ?? {}).reduce((sum, n) => sum + n, 0);
      signals.push({
        source: 'iac_state',
        status: 'healthy',
        detail: `Terraform state is readable (serial ${status.serial ?? 'unknown'}, ${resourceCount} resource(s)).`,
        observedAt,
      });
    }

    let anyCritical = false;
    let anyWarningResource = false;
    let missingCount = 0;
    let driftCount = 0;
    // Existence is the verification signal this coverage tally is built on:
    // an 'exists'/'missing' answer is a real check against AWS, while
    // PermissionMissing (denied) and non-permission 'unknown' (SDK absent,
    // unwatched type, transient error) are both "we don't actually know" —
    // assessHealth must never let either read as a verified clean state.
    let verifiedCount = 0;
    const unverifiedReasonCounts = new Map<string, number>();
    const countUnverified = (reason: string): void => {
      unverifiedReasonCounts.set(reason, (unverifiedReasonCounts.get(reason) ?? 0) + 1);
    };

    for (const { resource, existence, drift } of items) {
      // Verification is per-resource, not per-check: existence 'missing' is
      // fully verified on its own (drift is never independently checked for
      // a missing resource — see collect()), but existence 'exists' only
      // stays verified if drift was ALSO actually checked. A drift check
      // that comes back PermissionMissing flips it back to unverified below.
      let resourceVerified = false;

      if (isPermissionMissing(existence)) {
        signals.push({
          source: 'iac_iam_permissions',
          status: 'warning',
          detail: `cannot verify ${resource.type} ${resource.id}: IAM action ${existence.permissionMissing} not allowed`,
          observedAt,
        });
        anyWarningResource = true;
        countUnverified(`IAM action ${existence.permissionMissing} not allowed`);
      } else if (existence.existence === 'missing') {
        resourceVerified = true;
        missingCount += 1;
        const critical = !stale;
        if (critical) anyCritical = true;
        else anyWarningResource = true;
        const baseDetail = `${resource.type} ${resource.id} exists in Terraform state but not in AWS`;
        signals.push({
          source: 'iac_resource_missing',
          status: critical ? 'critical' : 'warning',
          entityId: resource.id,
          detail: stale ? `${baseDetail} (${STALE_CAVEAT})` : baseDetail,
          observedAt,
        });
      } else if (existence.existence === 'unknown') {
        countUnverified(existence.reason ?? 'unknown reason');
      } else {
        resourceVerified = true;
      }
      // existence 'exists' or non-permission 'unknown' -> no existence-side signal (never guess)

      if (drift) {
        if (isPermissionMissing(drift)) {
          signals.push({
            source: 'iac_iam_permissions',
            status: 'warning',
            detail: `cannot verify drift for ${resource.type} ${resource.id}: IAM action ${drift.permissionMissing} not allowed`,
            observedAt,
          });
          anyWarningResource = true;
          // Existence may have verified fine, but drift itself is unknown —
          // this resource is not fully verified (the coverage-honesty bug:
          // a real IAM policy can allow e.g. s3:ListBucket while denying
          // s3:GetBucketVersioning, so existence succeeds but drift can't).
          resourceVerified = false;
          countUnverified(`IAM action ${drift.permissionMissing} not allowed`);
        } else if (isDriftUnknown(drift)) {
          // A drift check that was attempted but failed (SDK absent, an
          // unexpected/empty response, throttling, network error) — never a
          // guess, so no signal is pushed (same as a non-permission
          // 'unknown' existence result), but it must not read as verified.
          resourceVerified = false;
          countUnverified(drift.driftUnknown);
        } else if (drift.drifts.length > 0) {
          driftCount += 1;
          anyWarningResource = true;
          signals.push({
            source: 'iac_attribute_drift',
            status: 'warning',
            entityId: resource.id,
            detail: formatDriftDetail(resource, drift),
            observedAt,
          });
        }
      }

      if (resourceVerified) verifiedCount += 1;
    }

    const totalItems = items.length;
    const unverifiedCount = totalItems - verifiedCount;
    // Nothing verified means every existence check came back unknown or
    // permission-denied — assessHealth has no evidence to call the state
    // clean OR dirty, so it must say so rather than defaulting to "healthy".
    const nothingVerified = totalItems > 0 && verifiedCount === 0;

    let healthStatus: HealthStatus = anyCritical ? 'unhealthy' : anyWarningResource ? 'recovering' : 'healthy';
    if (nothingVerified) healthStatus = 'unknown';

    const hasDriftOrMissing = missingCount > 0 || driftCount > 0;

    // Built from the actual counters, not from anyCritical/anyWarningResource
    // — those flags also go true for stale-downgraded missing resources and
    // for drift-permission-denied resources, neither of which means "0
    // resource(s) drifted"; only the counts a resource actually earned can
    // say that honestly.
    let summary: string;
    if (hasDriftOrMissing) {
      const parts: string[] = [];
      if (missingCount > 0) parts.push(`${missingCount} resource(s) recorded in state no longer exist in AWS`);
      if (driftCount > 0) parts.push(`${driftCount} resource(s) drifted from their intended configuration`);
      summary = `Terraform drift: ${parts.join('; ')}.`;
    } else if (anyWarningResource) {
      summary = 'Terraform drift check could not fully verify all resources — see the coverage details below.';
    } else {
      summary = 'Terraform state matches observed AWS infrastructure.';
    }

    if (nothingVerified) {
      const dominantReason = [...unverifiedReasonCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown reason';
      summary = `Terraform state found (${totalItems} resource(s)) but none could be verified against AWS: ${dominantReason}.`;
    } else if (unverifiedCount > 0) {
      summary += ` ${unverifiedCount} of ${totalItems} resource(s) could not be verified.`;
    }

    // Confidence tracks coverage: fully verified stays at the historical 0.9,
    // partial coverage scales down proportionally, and a floor of 0.3 keeps
    // an all-unverified run from reading as "very confident about nothing".
    const confidence = stale
      ? 0.5
      : totalItems > 0
        ? Math.max(0.3, Math.round((0.9 * verifiedCount / totalItems) * 100) / 100)
        : 0.9;

    return {
      status: healthStatus,
      confidence,
      summary,
      observedAt,
      signals,
      recommendedActions: nothingVerified
        ? ['Restore AWS access (credentials, IAM permissions, or install the missing AWS SDK package), then re-run the drift scan.']
        : hasDriftOrMissing ? ['Run terraform plan to confirm what apply would change'] : [],
    };
  }

  async diagnose(_context: AgentContext): Promise<DiagnosisResult> {
    const { status, items } = await this.collect();

    if (!status.readable) {
      return {
        status: 'unable',
        scenario: 'state_unreadable',
        confidence: 0,
        findings: [
          { source: 'iac_state_unreadable', observation: stateUnreadableDetail(status), severity: 'warning' },
        ],
        diagnosticPlanNeeded: false,
      };
    }

    const stale = isStale(status);
    const findings: DiagnosisFinding[] = [];

    if (stale) {
      const staleness = status.staleDays !== undefined
        ? ` (${status.staleDays} day(s) old)`
        : status.dirtyTfFiles
          ? ' (uncommitted *.tf changes present)'
          : '';
      findings.push({
        source: 'iac_state_stale',
        observation: `Terraform state is stale${staleness} — drift findings below may not reflect the current infrastructure intent.`,
        severity: 'info',
        data: { staleDays: status.staleDays, dirtyTfFiles: status.dirtyTfFiles },
      });
    }

    let hasMissing = false;
    let hasDrift = false;

    for (const { resource, existence, drift } of items) {
      // A permission-missing existence/drift check is neither a confirmed
      // miss nor a confirmed drift — surfacing it as a finding here would be
      // a guess. It's still visible via the iac_iam_permissions health
      // signal in assessHealth(); diagnose() stays silent on it.
      if (!isPermissionMissing(existence) && existence.existence === 'missing') {
        hasMissing = true;
        // Intentional asymmetry with assessHealth(): assessHealth treats ANY
        // missing resource as critical (severity is a coarse "call it
        // unhealthy" signal), while diagnose() scales severity by whether the
        // type is in the deep-comparator trio (WATCHABLE_TF_TYPES) — a
        // missing type CrisisMode can't drift-compare is a real finding but a
        // lower-confidence one than a missing RDS/S3/DynamoDB resource.
        const watchable = resource.type in WATCHABLE_TF_TYPES;
        const baseObservation = `${resource.type} ${resource.id} is recorded in Terraform state but no longer exists in AWS. If it was deleted on purpose, remove it from your Terraform config; if not, terraform apply can recreate it.`;
        findings.push({
          source: 'iac_resource_missing',
          observation: stale ? `${baseObservation} (${STALE_CAVEAT})` : baseObservation,
          severity: stale ? 'warning' : watchable ? 'critical' : 'warning',
          data: { resourceType: resource.type, resourceId: resource.id, resourceName: resource.name, region: resource.region },
        });
      }
      // existence 'exists' or non-permission 'unknown' -> no finding (never guess)

      // A permission-missing or DriftUnknown drift result is an unfinished
      // check, not a confirmed drift — no finding, same "never guess" rule
      // as the existence branch above.
      if (drift && !isPermissionMissing(drift) && !isDriftUnknown(drift) && drift.drifts.length > 0) {
        hasDrift = true;
        const first = drift.drifts[0]!;
        findings.push({
          source: 'iac_attribute_drift',
          observation: `${resource.type} ${resource.id} was changed outside Terraform (${first.attribute}: ${first.intended} → ${first.observed}). The next terraform apply would revert this change.`,
          severity: 'warning',
          data: {
            resourceType: resource.type,
            resourceId: resource.id,
            resourceName: resource.name,
            drifts: drift.drifts,
            comparedAttributes: drift.comparedAttributes,
            intendedAttributeCount: drift.intendedAttributeCount,
          },
        });
      }
    }

    const scenario = hasMissing ? 'resource_missing' : hasDrift ? 'attribute_drift' : stale ? 'state_stale' : null;

    return {
      status: scenario ? 'identified' : 'inconclusive',
      scenario,
      confidence: stale ? 0.5 : 0.9,
      findings,
      diagnosticPlanNeeded: false,
    };
  }

  /**
   * Terraform reconciliation stays at the 'suggest' escalation level:
   * CrisisMode can see drift but only the operator decides whether to
   * backport a manual change into the .tf source or let terraform apply
   * revert it — so the plan only captures state and notifies. Every step is
   * diagnosis_action or human_notification, never system_action, never
   * human_approval, and no terraform command is ever run by CrisisMode.
   */
  async plan(_context: AgentContext, diagnosis: DiagnosisResult): Promise<RecoveryPlan> {
    const steps: RecoveryStep[] = [
      {
        stepId: 'step-001',
        type: 'diagnosis_action',
        name: 'Capture current Terraform drift state',
        executionContext: 'iac_read',
        target: 'terraform-state',
        command: {
          type: 'structured_command',
          operation: 'scan_iac_drift',
          parameters: {},
        },
        outputCapture: {
          name: 'current_iac_drift_state',
          format: 'structured',
          availableTo: 'subsequent_steps',
        },
        timeout: 'PT30S',
      },
    ];

    let stepSeq = 2;
    const pushSuggestion = (summary: string, detail: string): void => {
      steps.push({
        stepId: `step-${String(stepSeq).padStart(3, '0')}`,
        type: 'human_notification',
        name: summary,
        recipients: [{ role: 'on_call_engineer', urgency: 'high' }],
        message: {
          summary,
          detail,
          contextReferences: ['current_iac_drift_state'],
          actionRequired: true,
        },
        channel: 'auto',
      });
      stepSeq += 1;
    };

    const affectedSystems: AffectedSystem[] = [];
    const seenResourceIds = new Set<string>();
    const trackAffected = (type: string, id: string, impactType: string): void => {
      if (id === 'unknown' || seenResourceIds.has(id)) return;
      seenResourceIds.add(id);
      affectedSystems.push({ identifier: id, technology: type, role: 'managed-resource', impactType });
    };

    for (const finding of diagnosis.findings) {
      const { type, id, name } = resourceLabel(finding.data);

      if (finding.source === 'iac_attribute_drift') {
        const drifts = Array.isArray(finding.data?.drifts) ? (finding.data.drifts as AttributeDrift[]) : [];
        trackAffected(type, id, 'attribute_drift');
        pushSuggestion(
          `Out-of-band change on ${id}`,
          `${type} ${id} differs from Terraform's intent: ${formatDriftList(drifts)}. Confirm first: run \`terraform plan\` (read-only). ` +
            `Then choose: **Option A — keep the live change:** update the \`${type}.${name}\` block in your .tf so the next apply doesn't revert it (backports the manual change). ` +
            `**Option B — restore Terraform's intent:** run \`terraform apply\` — WARNING: this reverts the manual change; if it was an emergency fix, applying undoes it.`,
        );
      } else if (finding.source === 'iac_resource_missing') {
        trackAffected(type, id, 'resource_missing');
        pushSuggestion(
          `Terraform-managed ${id} no longer exists`,
          `Confirm with \`terraform plan\`. If the deletion was intentional, remove the \`${type}.${name}\` block (or \`terraform state rm ${type}.${name}\`) so Terraform stops managing it. ` +
            `If not, \`terraform apply\` can recreate it — review the plan output first; recreation may not restore data.`,
        );
      } else if (finding.source === 'iac_state_stale') {
        pushSuggestion(
          'Terraform state is stale',
          `${finding.observation} Run \`terraform refresh\` to reconcile the state file with real infrastructure before trusting the drift findings above, then re-run this scan.`,
        );
      } else if (finding.source === 'iac_state_unreadable') {
        pushSuggestion(
          'Terraform state could not be read',
          `${finding.observation} Run \`terraform init\` to reinitialize the working directory and restore a readable state, then re-run this scan.`,
        );
      }
    }

    return {
      ...createPlanEnvelope({
        planIdSuffix: 'iac-drift',
        agentName: 'iac-drift-recovery',
        agentVersion: '1.0.0',
        scenario: diagnosis.scenario ?? 'attribute_drift',
        estimatedDuration: 'PT5M',
        summary: `Suggested Terraform reconciliation: ${diagnosis.scenario ?? 'attribute drift'}. No mutations performed — operator action required.`,
      }),
      impact: {
        affectedSystems,
        affectedServices: ['terraform-managed-infrastructure'],
        estimatedUserImpact: 'No action is taken by CrisisMode — suggestions only.',
        dataLossRisk: 'none',
      },
      steps,
      rollbackStrategy: {
        type: 'stepwise',
        description: 'Read-only plan: CrisisMode executes nothing that needs rolling back. All reconciliation is operator-run terraform.',
      },
    };
  }

  replan = defaultReplan;
}
