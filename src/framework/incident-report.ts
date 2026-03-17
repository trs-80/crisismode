// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Human-readable incident report generator.
 *
 * Converts ForensicRecord (JSON) and diagnosis results into shareable
 * Markdown documents using incident-native language — "what happened",
 * not "scenario identifier".
 */

import type { ForensicRecord, ExecutionLogEntry } from '../types/forensic-record.js';
import type { DiagnosisResult } from '../types/diagnosis-result.js';
import type { HealthAssessment, OperatorSummary } from '../types/health.js';
import type { RecoveryPlan } from '../types/recovery-plan.js';
import type { StepResult } from '../types/execution-state.js';

export interface IncidentReport {
  /** Markdown-formatted incident report */
  markdown: string;
  /** Structured sections for programmatic use */
  sections: ReportSection[];
}

export interface ReportSection {
  title: string;
  content: string;
}

// ── Full incident report from a ForensicRecord ──

/**
 * Generate a complete incident report from a forensic record.
 * Covers the full lifecycle: trigger, diagnosis, execution, outcome.
 */
export function generateIncidentReport(record: ForensicRecord): IncidentReport {
  const sections: ReportSection[] = [
    buildIncidentSummary(record),
    buildTimeline(record),
    buildTriggerSection(record),
    buildFindingsSection(record),
    buildActionsSection(record),
    buildChangesSection(record),
    buildCurrentStateSection(record),
    buildFollowUpSection(record),
    buildEvidenceSection(record),
  ];

  const markdown = sections
    .map((s) => `## ${s.title}\n\n${s.content}`)
    .join('\n\n');

  const header = `# Incident Report — ${describeOutcome(record.summary.outcome)}\n\n` +
    `**Record:** ${record.recordId}  \n` +
    `**Started:** ${formatTimestamp(record.createdAt)}  \n` +
    `**Completed:** ${formatTimestamp(record.completedAt)}  \n` +
    `**Duration:** ${formatDuration(record.summary.totalDurationMs)}\n`;

  return {
    markdown: `${header}\n${markdown}`,
    sections,
  };
}

// ── Diagnosis-only report (lighter, no execution) ──

/**
 * Generate a lighter report for diagnosis-only runs.
 * No execution steps — just health, diagnosis, and recommendations.
 */
export function generateDiagnosisReport(
  diagnosis: DiagnosisResult,
  health: HealthAssessment,
  operatorSummary: OperatorSummary,
): IncidentReport {
  const sections: ReportSection[] = [
    buildHealthSection(health),
    buildDiagnosisSection(diagnosis),
    buildRecommendedActionsSection(operatorSummary),
  ];

  const markdown = sections
    .map((s) => `## ${s.title}\n\n${s.content}`)
    .join('\n\n');

  const header = `# Health & Diagnosis Report\n\n` +
    `**Observed:** ${formatTimestamp(health.observedAt)}  \n` +
    `**Status:** ${health.status}  \n` +
    `**Confidence:** ${formatConfidence(health.confidence)}\n`;

  return {
    markdown: `${header}\n${markdown}`,
    sections,
  };
}

// ── Section builders for full incident report ──

function buildIncidentSummary(record: ForensicRecord): ReportSection {
  const outcome = describeOutcome(record.summary.outcome);
  const scenario = record.diagnosis?.scenario ?? 'Unknown';
  const duration = formatDuration(record.summary.totalDurationMs);
  const stepsRun = record.summary.totalSteps;
  const stepsSucceeded = record.summary.completedSteps;
  const stepsFailed = record.summary.failedSteps;

  let content = `**What happened:** ${describeScenario(scenario)}\n\n`;
  content += `**Outcome:** ${outcome}\n\n`;
  content += `**Duration:** ${duration} across ${stepsRun} steps `;
  content += `(${stepsSucceeded} succeeded, ${stepsFailed} failed).\n`;

  if (record.summary.replanCount > 0) {
    content += `\nThe recovery plan was revised ${record.summary.replanCount} time(s) during execution.\n`;
  }

  return { title: 'What Happened', content };
}

function buildTimeline(record: ForensicRecord): ReportSection {
  const events: Array<{ time: string; description: string }> = [];

  events.push({
    time: record.createdAt,
    description: 'Incident triggered',
  });

  // Key log events
  const keyTypes: ExecutionLogEntry['type'][] = [
    'step_start', 'step_complete', 'step_failed',
    'approval_request', 'approval_received',
    'replan_start', 'replan_result',
  ];

  for (const entry of record.executionLog) {
    if (keyTypes.includes(entry.type)) {
      events.push({
        time: entry.timestamp,
        description: describeLogEntry(entry),
      });
    }
  }

  events.push({
    time: record.completedAt,
    description: `Recovery ${describeOutcome(record.summary.outcome).toLowerCase()}`,
  });

  let content = '';
  for (const event of events) {
    content += `- **${formatTimestamp(event.time)}** — ${event.description}\n`;
  }

  return { title: 'Timeline', content };
}

function buildTriggerSection(record: ForensicRecord): ReportSection {
  const trigger = record.context.trigger;
  let content = `**How it started:** ${describeTriggerType(trigger.type)} from ${trigger.source}\n\n`;
  content += `**When:** ${formatTimestamp(trigger.receivedAt)}\n\n`;

  // Include key payload fields without exposing secrets
  const safePayload = sanitizePayload(trigger.payload);
  if (Object.keys(safePayload).length > 0) {
    content += '**Key details:**\n\n';
    for (const [key, value] of Object.entries(safePayload)) {
      content += `- ${humanizeKey(key)}: ${String(value)}\n`;
    }
  }

  return { title: 'What Triggered This', content };
}

function buildFindingsSection(record: ForensicRecord): ReportSection {
  const diagnosis = record.diagnosis;
  if (!diagnosis) {
    return { title: 'What Was Found', content: 'No diagnosis was performed.\n' };
  }

  let content = `**Scenario:** ${describeScenario(diagnosis.scenario)}\n\n`;
  content += `**Confidence:** ${formatConfidence(diagnosis.confidence)}\n\n`;

  if (diagnosis.findings.length > 0) {
    content += '**Findings:**\n\n';
    for (const finding of diagnosis.findings) {
      const severity = finding.severity.toUpperCase();
      content += `- **[${severity}]** ${finding.observation}\n`;

      if (finding.data?.root_cause) {
        content += `  - Root cause: ${String(finding.data.root_cause)}\n`;
      }
    }
  }

  return { title: 'What Was Found', content };
}

function buildActionsSection(record: ForensicRecord): ReportSection {
  if (record.stepResults.length === 0) {
    return { title: 'What Was Done', content: 'No recovery actions were executed.\n' };
  }

  let content = '';
  for (let i = 0; i < record.stepResults.length; i++) {
    const result = record.stepResults[i];
    const step = result.step;
    const status = describeStepStatus(result.status);
    const duration = formatDuration(result.durationMs);
    const description = ('description' in step && step.description) ? step.description : step.name;

    content += `${i + 1}. **${description}** — ${status} (${duration})\n`;

    if (result.error) {
      content += `   - Error: ${result.error}\n`;
    }
  }

  return { title: 'What Was Done', content };
}

function buildChangesSection(record: ForensicRecord): ReportSection {
  const mutations = record.stepResults.filter(
    (r) => r.step.type === 'system_action' && r.status === 'success',
  );

  if (mutations.length === 0) {
    return { title: 'What Changed', content: 'No system changes were made.\n' };
  }

  let content = 'The following actions modified the system:\n\n';
  for (const m of mutations) {
    const description = ('description' in m.step && m.step.description) ? m.step.description : m.step.name;
    content += `- ${description}\n`;

    if (m.step.type === 'system_action') {
      const blastRadius = m.step.blastRadius;
      const affected = blastRadius.directComponents.join(', ');
      const reversible = m.step.rollback ? 'Yes' : 'No';
      content += `  - What is affected: ${affected}\n`;
      content += `  - Whether the action is reversible: ${reversible}\n`;
    }
  }

  return { title: 'What Changed', content };
}

function buildCurrentStateSection(record: ForensicRecord): ReportSection {
  const outcome = record.summary.outcome;
  let content = '';

  switch (outcome) {
    case 'success':
      content = 'Recovery completed successfully. The system should now be in a healthy state.\n';
      break;
    case 'partial_success':
      content = 'Recovery partially completed. Some steps succeeded but others failed. ' +
        'The system may still require attention.\n';
      break;
    case 'failed':
      content = 'Recovery failed. The system is likely still in an unhealthy state. ' +
        'Manual intervention is recommended.\n';
      break;
    case 'aborted':
      content = 'Recovery was aborted before completion. Review the timeline above to ' +
        'understand where and why execution stopped.\n';
      break;
  }

  content += `\n**Data completeness:** ${record.completeness}\n`;

  return { title: 'Current State', content };
}

function buildFollowUpSection(record: ForensicRecord): ReportSection {
  const actions: string[] = [];

  if (record.summary.outcome !== 'success') {
    actions.push('Verify the current state of the system with `crisismode diagnose`');
  }

  if (record.summary.failedSteps > 0) {
    actions.push('Review failed steps in the timeline and address any underlying issues');
  }

  if (record.summary.outcome === 'success') {
    actions.push('Monitor the system for the next 30 minutes to confirm stability');
    actions.push('Update any related incident tickets');
  }

  if (record.summary.replanCount > 0) {
    actions.push('Review why the plan needed revision — this may indicate an evolving incident');
  }

  actions.push('Share this report with relevant stakeholders');

  let content = '';
  for (const action of actions) {
    content += `- ${action}\n`;
  }

  return { title: 'Follow-Up Actions', content };
}

function buildEvidenceSection(record: ForensicRecord): ReportSection {
  let content = '<details>\n<summary>Detailed diagnostic data</summary>\n\n';

  // Diagnosis findings
  if (record.diagnosis?.findings.length) {
    content += '### Diagnostic Findings\n\n';
    content += '```\n';
    for (const finding of record.diagnosis.findings) {
      content += `[${finding.severity.toUpperCase()}] ${finding.source}: ${finding.observation}\n`;
      if (finding.data) {
        const safeData = sanitizePayload(finding.data);
        content += `  Data: ${JSON.stringify(safeData, null, 2)}\n`;
      }
    }
    content += '```\n\n';
  }

  // State captures
  if (record.captures.length > 0) {
    content += '### State Captures\n\n';
    for (const capture of record.captures) {
      content += `- **${capture.name}** (${capture.captureType}): ${capture.status}`;
      if (capture.reason) {
        content += ` — ${capture.reason}`;
      }
      content += '\n';
    }
    content += '\n';
  }

  // Execution log summary
  content += '### Execution Log\n\n';
  content += '```\n';
  for (const entry of record.executionLog) {
    content += `[${entry.timestamp}] ${entry.type}: ${entry.message}\n`;
  }
  content += '```\n';

  content += '\n</details>\n';

  return { title: 'Evidence', content };
}

// ── Section builders for diagnosis-only report ──

function buildHealthSection(health: HealthAssessment): ReportSection {
  let content = `**Status:** ${health.status}\n\n`;
  content += `**Confidence:** ${formatConfidence(health.confidence)}\n\n`;
  content += `**Summary:** ${health.summary}\n\n`;

  if (health.signals.length > 0) {
    content += '**Signals:**\n\n';
    for (const signal of health.signals) {
      content += `- **[${signal.status.toUpperCase()}]** ${signal.source}: ${signal.detail}\n`;
    }
  }

  return { title: 'Health Assessment', content };
}

function buildDiagnosisSection(diagnosis: DiagnosisResult): ReportSection {
  let content = `**What happened:** ${describeScenario(diagnosis.scenario)}\n\n`;
  content += `**Status:** ${diagnosis.status}\n\n`;
  content += `**Confidence:** ${formatConfidence(diagnosis.confidence)}\n\n`;

  if (diagnosis.findings.length > 0) {
    content += '**What was found:**\n\n';
    for (const finding of diagnosis.findings) {
      content += `- **[${finding.severity.toUpperCase()}]** ${finding.observation}\n`;

      if (finding.data?.root_cause) {
        content += `  - Root cause: ${String(finding.data.root_cause)}\n`;
      }

      if (Array.isArray(finding.data?.recommendations)) {
        for (const rec of finding.data.recommendations as string[]) {
          content += `  - ${rec}\n`;
        }
      }
    }
  }

  return { title: 'Diagnosis', content };
}

function buildRecommendedActionsSection(operatorSummary: OperatorSummary): ReportSection {
  let content = `**Action required:** ${describeActionRequired(operatorSummary.actionRequired)}\n\n`;
  content += `**Next step:** ${operatorSummary.recommendedNextStep}\n\n`;

  if (operatorSummary.recommendedActions.length > 0) {
    content += '**Recommended actions:**\n\n';
    for (const action of operatorSummary.recommendedActions) {
      content += `- ${action}\n`;
    }
  }

  if (operatorSummary.validationBlockers.length > 0) {
    content += '\n**Blockers:**\n\n';
    for (const blocker of operatorSummary.validationBlockers) {
      content += `- ${blocker}\n`;
    }
  }

  return { title: 'Recommended Actions', content };
}

// ── Formatting helpers ──

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
  } catch {
    return iso;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatConfidence(confidence: number): string {
  return `${(confidence * 100).toFixed(0)}%`;
}

// ── Incident-native language helpers ──

function describeOutcome(outcome: string): string {
  switch (outcome) {
    case 'success': return 'Recovery Succeeded';
    case 'partial_success': return 'Partial Recovery';
    case 'failed': return 'Recovery Failed';
    case 'aborted': return 'Recovery Aborted';
    default: return outcome;
  }
}

function describeScenario(scenario: string | null): string {
  if (!scenario) return 'Unknown issue';
  // Convert machine identifiers to human language
  return scenario
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function describeTriggerType(type: string): string {
  switch (type) {
    case 'alert': return 'An alert was received';
    case 'health_check': return 'A health check detected an issue';
    case 'manual': return 'An operator manually triggered recovery';
    default: return `A ${type} event occurred`;
  }
}

function describeStepStatus(status: string): string {
  switch (status) {
    case 'success': return 'completed successfully';
    case 'failed': return 'failed';
    case 'skipped': return 'was skipped';
    case 'rolled_back': return 'was rolled back';
    default: return status;
  }
}

function describeActionRequired(action: string): string {
  switch (action) {
    case 'none': return 'No action needed';
    case 'monitor': return 'Continue monitoring';
    case 'investigate': return 'Investigation needed';
    case 'retry_with_execute': return 'Ready for automated recovery';
    case 'manual_intervention_required': return 'Manual intervention required';
    case 'use_different_tool': return 'Use manual recovery workflow';
    default: return action;
  }
}

function describeLogEntry(entry: ExecutionLogEntry): string {
  switch (entry.type) {
    case 'step_start': return `Started: ${entry.message}`;
    case 'step_complete': return `Completed: ${entry.message}`;
    case 'step_failed': return `Failed: ${entry.message}`;
    case 'approval_request': return `Approval requested: ${entry.message}`;
    case 'approval_received': return `Approval received: ${entry.message}`;
    case 'replan_start': return `Plan revision started: ${entry.message}`;
    case 'replan_result': return `Plan revised: ${entry.message}`;
    default: return entry.message;
  }
}

function humanizeKey(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Remove fields that might contain secrets from payload data.
 * Never expose tokens, passwords, keys, or DSNs in reports.
 */
function sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const sensitivePatterns = /^(password|token|secret|key|dsn|credential|auth|bearer|api_key|apikey)$/i;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(payload)) {
    if (sensitivePatterns.test(key)) {
      result[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[key] = sanitizePayload(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }

  return result;
}
