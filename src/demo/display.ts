import chalk from 'chalk';
import type { RecoveryStep, SystemActionStep, HumanApprovalStep } from '../types/step-types.js';
import type { RecoveryPlan } from '../types/recovery-plan.js';
import type { AgentContext } from '../types/agent-context.js';
import type { DiagnosisResult } from '../types/diagnosis-result.js';
import type { ValidationResult } from '../framework/validator.js';
import type { CatalogMatchResult } from '../framework/catalog.js';
import type { CatalogEntry } from '../types/catalog-entry.js';
import type { ForensicRecord } from '../types/forensic-record.js';
import type { StepResult } from '../types/execution-state.js';

const DIVIDER = chalk.dim('─'.repeat(72));
const DOUBLE_DIVIDER = chalk.dim('═'.repeat(72));

export function banner(): void {
  console.log('');
  console.log(DOUBLE_DIVIDER);
  console.log(chalk.bold.red('  ⚠  CRISISMODE — Recovery Agent Framework Demo'));
  console.log(chalk.dim('  Recovery Agent Contract Specification v0.2.1'));
  console.log(chalk.dim('  PostgreSQL Replication Lag Cascade Recovery'));
  console.log(DOUBLE_DIVIDER);
  console.log('');
  console.log(
    chalk.dim(
      '  This demo walks through the full execution flow of the Recovery Agent\n' +
      '  Contract using a simulated PostgreSQL replication recovery scenario.\n' +
      '  All system interactions are simulated — no real databases are touched.',
    ),
  );
  console.log('');
}

export function phase(number: number, title: string): void {
  console.log('');
  console.log(DIVIDER);
  console.log(chalk.bold.cyan(`  Phase ${number}: ${title}`));
  console.log(DIVIDER);
  console.log('');
}

export function step(number: number, title: string): void {
  console.log(chalk.bold.white(`  ${number}. ${title}`));
}

export function info(message: string): void {
  console.log(chalk.dim(`     ${message}`));
}

export function success(message: string): void {
  console.log(chalk.green(`     ✓ ${message}`));
}

export function warning(message: string): void {
  console.log(chalk.yellow(`     ! ${message}`));
}

export function error(message: string): void {
  console.log(chalk.red(`     ✗ ${message}`));
}

export function displayTrigger(trigger: AgentContext['trigger']): void {
  console.log(chalk.bold.yellow('     ALERT FIRED'));
  console.log(chalk.yellow(`     Source:  ${trigger.source}`));
  console.log(chalk.yellow(`     Type:    ${trigger.type}`));
  console.log(chalk.yellow(`     Label:   alertname=PostgresReplicationLagCritical`));
  console.log(chalk.yellow(`     Time:    ${trigger.receivedAt}`));
  console.log('');
}

export function displayCatalogEntry(entry: CatalogEntry): void {
  console.log(chalk.dim(`     Catalog ID:   ${entry.metadata.catalogId}`));
  console.log(chalk.dim(`     Name:         ${entry.metadata.name}`));
  console.log(chalk.dim(`     Approved by:  ${entry.metadata.approvedBy}`));
  console.log(chalk.dim(`     Expires:      ${entry.metadata.expiresAt}`));
  console.log(chalk.dim(`     Covers:       ${entry.authorization.satisfiesApprovalFor.join(', ')} risk levels`));
  console.log('');
}

export function displayManifest(name: string, version: string, description: string): void {
  console.log(chalk.dim(`     Agent:        ${name} v${version}`));
  console.log(chalk.dim(`     Description:  ${description}`));
  console.log('');
}

export function displayContext(context: AgentContext): void {
  console.log(chalk.dim('     Topology:'));
  for (const comp of context.topology.components) {
    const statusColor =
      comp.healthStatus === 'healthy'
        ? chalk.green
        : comp.healthStatus === 'degraded'
          ? chalk.yellow
          : chalk.red;
    console.log(
      chalk.dim(`       ${comp.identifier.padEnd(28)} `) +
        statusColor(comp.healthStatus.padEnd(12)) +
        chalk.dim(comp.role),
    );
  }
  console.log('');
  console.log(chalk.dim(`     Trust level:  ${context.trustLevel} (scenario override: ${context.trustScenarioOverrides['replication_lag_cascade'] || 'none'})`));
  console.log(chalk.dim(`     Layers:       L1=${context.frameworkLayers.execution_kernel}, L2=${context.frameworkLayers.safety}, L3=${context.frameworkLayers.coordination}, L4=${context.frameworkLayers.enrichment}`));
  console.log(chalk.dim(`     Policies:     requireApprovalForAllElevated=${context.organizationalPolicies.requireApprovalForAllElevated}`));
  console.log('');
}

export function displayDiagnosis(diagnosis: DiagnosisResult): void {
  const statusColor =
    diagnosis.status === 'identified' ? chalk.green : chalk.yellow;
  console.log(
    chalk.dim('     Status:      ') + statusColor(diagnosis.status),
  );
  console.log(chalk.dim(`     Scenario:    ${diagnosis.scenario}`));
  console.log(chalk.dim(`     Confidence:  ${(diagnosis.confidence * 100).toFixed(0)}%`));

  // Show AI root cause if present
  const rootCause = diagnosis.findings[0]?.data?.root_cause;
  if (rootCause) {
    console.log('');
    console.log(chalk.cyan('     Root cause:  ') + chalk.white(String(rootCause)));
  }

  // Show AI recommendations if present
  const recommendations = diagnosis.findings[0]?.data?.recommendations;
  if (Array.isArray(recommendations) && recommendations.length > 0) {
    console.log('');
    console.log(chalk.cyan('     Recommendations:'));
    for (const rec of recommendations) {
      console.log(chalk.dim(`       - ${rec}`));
    }
  }

  console.log('');
  for (const finding of diagnosis.findings) {
    const sevColor =
      finding.severity === 'critical'
        ? chalk.red
        : finding.severity === 'warning'
          ? chalk.yellow
          : chalk.dim;
    console.log(
      sevColor(`     [${finding.severity.toUpperCase()}] `) +
        chalk.dim(`${finding.source}: ${finding.observation}`),
    );
  }
  console.log('');
}

export function displayPlanTable(plan: RecoveryPlan): void {
  console.log(chalk.dim(`     Plan ID:      ${plan.metadata.planId}`));
  console.log(chalk.dim(`     Duration:     ${plan.metadata.estimatedDuration}`));
  console.log(chalk.dim(`     Summary:      ${plan.metadata.summary}`));
  console.log(chalk.dim(`     Rollback:     ${plan.rollbackStrategy.type}`));
  console.log('');

  console.log(
    chalk.dim('     ') +
      chalk.bold('#'.padEnd(4)) +
      chalk.bold('Type'.padEnd(24)) +
      chalk.bold('Risk'.padEnd(12)) +
      chalk.bold('Name'),
  );
  console.log(chalk.dim('     ' + '─'.repeat(68)));

  for (let i = 0; i < plan.steps.length; i++) {
    const s = plan.steps[i];
    const num = `${i + 1}`.padEnd(4);
    const type = s.type.padEnd(24);
    const risk =
      s.type === 'system_action'
        ? riskBadge(s.riskLevel)
        : chalk.dim('—'.padEnd(12));
    console.log(chalk.dim('     ') + num + type + risk + s.name);
  }
  console.log('');

  console.log(chalk.dim('     Impact:'));
  for (const sys of plan.impact.affectedSystems) {
    console.log(chalk.dim(`       ${sys.identifier} (${sys.role}): ${sys.impactType}`));
  }
  console.log(chalk.dim(`     User impact:  ${plan.impact.estimatedUserImpact}`));
  console.log(chalk.dim(`     Data loss:    ${plan.impact.dataLossRisk}`));
  console.log('');
}

function riskBadge(risk: string): string {
  switch (risk) {
    case 'routine':
      return chalk.green(risk.padEnd(12));
    case 'elevated':
      return chalk.yellow(risk.padEnd(12));
    case 'high':
      return chalk.red(risk.padEnd(12));
    case 'critical':
      return chalk.bgRed.white(risk.padEnd(12));
    default:
      return risk.padEnd(12);
  }
}

export function displayValidation(result: ValidationResult): void {
  for (const check of result.checks) {
    if (check.passed) {
      console.log(chalk.green(`     ✓ ${check.name}`));
    } else {
      console.log(chalk.red(`     ✗ ${check.name}: ${check.message}`));
    }
  }
  console.log('');
}

export function displayCatalogMatch(result: CatalogMatchResult): void {
  for (const detail of result.matchDetails) {
    console.log(chalk.dim(`     ${detail}`));
  }
  if (result.matched) {
    success(`Catalog match: covers ${result.coveredRiskLevels.join(', ')} risk levels`);
    warning('Steps with high/critical risk still require manual approval');
  }
  console.log('');
}

export function displayStepExecution(
  recoveryStep: RecoveryStep,
  index: number,
): void {
  const typeColor =
    recoveryStep.type === 'system_action'
      ? chalk.yellow
      : recoveryStep.type === 'human_approval'
        ? chalk.magenta
        : recoveryStep.type === 'human_notification'
          ? chalk.blue
          : recoveryStep.type === 'replanning_checkpoint'
            ? chalk.cyan
            : recoveryStep.type === 'conditional'
              ? chalk.white
              : chalk.dim;

  console.log('');
  console.log(
    chalk.bold(
      `     Step ${recoveryStep.stepId} `,
    ) + typeColor(`[${recoveryStep.type}]`),
  );
  console.log(chalk.dim(`     ${recoveryStep.name}`));
}

export function displayApprovalPrompt(step: HumanApprovalStep): void {
  console.log('');
  console.log(chalk.bold.magenta('     ┌─────────────────────────────────────────────────────┐'));
  console.log(chalk.bold.magenta('     │          HUMAN APPROVAL REQUIRED                    │'));
  console.log(chalk.bold.magenta('     └─────────────────────────────────────────────────────┘'));
  console.log('');
  console.log(chalk.bold(`     ${step.presentation.summary}`));
  console.log(chalk.dim(`     ${step.presentation.detail}`));
  console.log('');
  console.log(chalk.bold('     Proposed actions:'));
  for (const action of step.presentation.proposedActions) {
    console.log(chalk.dim(`       • ${action}`));
  }
  console.log('');
  if (step.presentation.riskSummary) {
    console.log(chalk.yellow(`     Risk: ${step.presentation.riskSummary}`));
    console.log('');
  }
  console.log(chalk.dim('     Alternatives:'));
  for (const alt of step.presentation.alternatives) {
    console.log(chalk.dim(`       [${alt.action}] ${alt.description}`));
  }
}

export function displayNotification(step: RecoveryStep & { type: 'human_notification' }): void {
  console.log(
    chalk.blue(`     → Notification: ${step.message.summary}`),
  );
  console.log(
    chalk.dim(`       Recipients: ${step.recipients.map((r) => `${r.role} (${r.urgency})`).join(', ')}`),
  );
}

export function displayCaptureResult(name: string, status: string): void {
  if (status === 'captured') {
    console.log(chalk.dim(`     ◆ Capture: ${name} — captured`));
  } else if (status === 'skipped') {
    console.log(chalk.yellow(`     ◇ Capture: ${name} — skipped`));
  } else {
    console.log(chalk.red(`     ◇ Capture: ${name} — failed`));
  }
}

export function displayPreCondition(passed: boolean, description: string): void {
  if (passed) {
    console.log(chalk.green(`     ✓ Precondition: ${description}`));
  } else {
    console.log(chalk.red(`     ✗ Precondition: ${description}`));
  }
}

export function displaySuccessCheck(passed: boolean, description: string): void {
  if (passed) {
    console.log(chalk.green(`     ✓ Success: ${description}`));
  } else {
    console.log(chalk.red(`     ✗ Success: ${description}`));
  }
}

export function displayBlastRadius(step: SystemActionStep, message: string): void {
  console.log(
    chalk.dim(`     ◈ Blast radius: ${step.blastRadius.directComponents.join(', ')} (cascade: ${step.blastRadius.cascadeRisk})`),
  );
}

export function displayConditionalResult(conditionMet: boolean): void {
  if (conditionMet) {
    console.log(chalk.green('     → Condition TRUE — executing thenStep'));
  } else {
    console.log(chalk.yellow('     → Condition FALSE — executing elseStep'));
  }
}

export function displayReplanStart(): void {
  console.log(chalk.cyan('     ↻ Replanning checkpoint reached — invoking agent.replan()'));
}

export function displayReplanResult(action: string, details?: string): void {
  if (action === 'revised_plan') {
    console.log(chalk.cyan(`     ↻ Agent returned revised plan`));
    if (details) console.log(chalk.dim(`       ${details}`));
  } else if (action === 'continue') {
    console.log(chalk.green('     ↻ Agent confirmed: current plan remains valid'));
  } else {
    console.log(chalk.red(`     ↻ Agent recommended abort: ${details}`));
  }
}

export function displayStepResult(step: RecoveryStep, result: StepResult): void {
  const statusColor =
    result.status === 'success'
      ? chalk.green
      : result.status === 'skipped'
        ? chalk.yellow
        : chalk.red;
  console.log(statusColor(`     ● ${result.status.toUpperCase()} (${result.durationMs}ms)`));
}

export function displayAutoApproval(catalogCovered: boolean): void {
  if (catalogCovered) {
    console.log(chalk.green('     ✓ Approval pre-satisfied by catalog entry'));
  } else {
    console.log(chalk.green('     ✓ Approval auto-satisfied by trust level'));
  }
}

export function displayForensicSummary(record: ForensicRecord): void {
  console.log('');
  console.log(DOUBLE_DIVIDER);
  console.log(chalk.bold('  Forensic Record Summary'));
  console.log(DOUBLE_DIVIDER);
  console.log('');
  console.log(chalk.dim(`     Record ID:      ${record.recordId}`));
  console.log(chalk.dim(`     Completeness:   ${record.completeness}`));
  console.log(chalk.dim(`     Outcome:        ${record.summary.outcome}`));
  console.log(chalk.dim(`     Duration:       ${record.summary.totalDurationMs}ms`));
  console.log('');
  console.log(chalk.dim(`     Steps:          ${record.summary.completedSteps} completed, ${record.summary.failedSteps} failed, ${record.summary.skippedSteps} skipped (${record.summary.totalSteps} total)`));
  console.log(chalk.dim(`     Captures:       ${record.summary.capturesSucceeded} succeeded, ${record.summary.capturesSkipped} skipped (${record.summary.capturesAttempted} total)`));
  console.log(chalk.dim(`     Catalog match:  ${record.summary.catalogMatchUsed ? 'yes' : 'no'}`));
  console.log(chalk.dim(`     Replans:        ${record.summary.replanCount}`));
  console.log(chalk.dim(`     Plans:          ${record.plans.length}`));
  console.log('');
}

export function displayComplete(outputPath: string): void {
  console.log(chalk.green(`     Forensic record written to: ${outputPath}`));
  console.log('');
  console.log(DOUBLE_DIVIDER);
  console.log(chalk.bold.green('  Demo Complete'));
  console.log(DOUBLE_DIVIDER);
  console.log('');
}
