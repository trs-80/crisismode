// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Notification formatters — transform incident data into platform-specific
 * notification formats: Slack blocks, GitHub issue bodies, and Markdown.
 *
 * Each formatter produces a self-contained, human-readable message suitable
 * for its target platform.
 */

import type { IncidentReport } from './incident-report.js';
import type { HealthAssessment, OperatorSummary } from '../types/health.js';
import type { DiagnosisResult } from '../types/diagnosis-result.js';
import type { RecoveryPlan } from '../types/recovery-plan.js';
import type { HealthCard } from './watch-state.js';

// ── Types ──

export interface SlackNotification {
  text: string;
  blocks: SlackBlock[];
}

export interface SlackBlock {
  type: 'header' | 'section' | 'divider' | 'actions' | 'context';
  text?: { type: 'plain_text' | 'mrkdwn'; text: string };
  fields?: Array<{ type: 'mrkdwn'; text: string }>;
  elements?: Array<SlackBlockElement>;
}

export interface SlackBlockElement {
  type: 'button' | 'mrkdwn';
  text?: { type: 'plain_text'; text: string } | string;
  action_id?: string;
  value?: string;
  style?: 'primary' | 'danger';
  [key: string]: unknown;
}

export interface GitHubIssueBody {
  title: string;
  body: string;
  labels: string[];
}

export interface NotificationContext {
  health: HealthAssessment;
  diagnosis?: DiagnosisResult;
  plan?: RecoveryPlan;
  operatorSummary?: OperatorSummary;
  healthCard?: HealthCard;
}

// ── Severity helpers ──

const SEVERITY_EMOJI: Record<string, string> = {
  healthy: ':white_check_mark:',
  recovering: ':large_orange_diamond:',
  unhealthy: ':red_circle:',
  unknown: ':question:',
};

const SEVERITY_LABEL: Record<string, string> = {
  healthy: 'Healthy',
  recovering: 'Recovering',
  unhealthy: 'Unhealthy',
  unknown: 'Unknown',
};

// ── Slack Formatter ──

export function formatSlackNotification(ctx: NotificationContext): SlackNotification {
  const emoji = SEVERITY_EMOJI[ctx.health.status] ?? ':question:';
  const label = SEVERITY_LABEL[ctx.health.status] ?? 'Unknown';
  const confidencePct = (ctx.health.confidence * 100).toFixed(0);

  const blocks: SlackBlock[] = [];

  // Header
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: `${emoji} CrisisMode: ${label}` },
  });

  // Health summary
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Status:* ${label} (${confidencePct}% confidence)\n*Summary:* ${ctx.health.summary}`,
    },
  });

  // Signals
  if (ctx.health.signals.length > 0) {
    const signalLines = ctx.health.signals
      .slice(0, 5)
      .map((s) => `\`${s.status.toUpperCase()}\` ${s.source}: ${s.detail}`)
      .join('\n');
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Signals:*\n${signalLines}` },
    });
  }

  // Diagnosis
  if (ctx.diagnosis) {
    blocks.push({ type: 'divider' });
    const scenario = ctx.diagnosis.scenario
      ? ctx.diagnosis.scenario.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
      : 'Unknown';
    const diagConfidence = (ctx.diagnosis.confidence * 100).toFixed(0);

    blocks.push({
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Scenario:*\n${scenario}` },
        { type: 'mrkdwn', text: `*Confidence:*\n${diagConfidence}%` },
      ],
    });

    if (ctx.diagnosis.findings.length > 0) {
      const findingLines = ctx.diagnosis.findings
        .slice(0, 5)
        .map((f) => `\`${f.severity.toUpperCase()}\` ${f.observation}`)
        .join('\n');
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*Findings:*\n${findingLines}` },
      });
    }
  }

  // Recovery plan summary
  if (ctx.plan) {
    blocks.push({ type: 'divider' });
    const stepCount = ctx.plan.steps.length;
    const planSummary = ctx.plan.metadata?.summary ?? 'Recovery plan ready';
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Recovery Plan:* ${planSummary}\n*Steps:* ${stepCount} | *Rollback:* ${ctx.plan.rollbackStrategy.type}`,
      },
    });

    // Approval buttons
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Approve Recovery' },
          action_id: 'crisismode_approve',
          value: ctx.plan.metadata?.planId ?? 'unknown',
          style: 'primary',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Reject' },
          action_id: 'crisismode_reject',
          value: ctx.plan.metadata?.planId ?? 'unknown',
          style: 'danger',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'View Details' },
          action_id: 'crisismode_details',
          value: ctx.plan.metadata?.planId ?? 'unknown',
        },
      ],
    });
  }

  // Health card context (from watch mode)
  if (ctx.healthCard) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Uptime: ${ctx.healthCard.uptimePercent}% | Cycles: ${ctx.healthCard.totalCycles} | Transitions: ${ctx.healthCard.transitionCount} | Watching since: ${ctx.healthCard.watchingSince}`,
        },
      ],
    });
  }

  // Recommended actions
  if (ctx.operatorSummary?.recommendedActions.length) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Next step:* ${ctx.operatorSummary.recommendedNextStep}`,
      },
    });
  }

  const text = `CrisisMode: ${label} — ${ctx.health.summary}`;

  return { text, blocks };
}

// ── GitHub Issue Formatter ──

export function formatGitHubIssue(ctx: NotificationContext): GitHubIssueBody {
  const label = SEVERITY_LABEL[ctx.health.status] ?? 'Unknown';
  const confidencePct = (ctx.health.confidence * 100).toFixed(0);

  const sections: string[] = [];

  // Health summary
  sections.push('## Health Assessment\n');
  sections.push(`- **Status:** ${label}`);
  sections.push(`- **Confidence:** ${confidencePct}%`);
  sections.push(`- **Summary:** ${ctx.health.summary}`);
  sections.push(`- **Observed:** ${ctx.health.observedAt}`);

  // Signals
  if (ctx.health.signals.length > 0) {
    sections.push('\n### Signals\n');
    sections.push('| Status | Source | Detail |');
    sections.push('|--------|--------|--------|');
    for (const signal of ctx.health.signals) {
      sections.push(`| ${signal.status.toUpperCase()} | ${signal.source} | ${signal.detail} |`);
    }
  }

  // Diagnosis
  if (ctx.diagnosis) {
    const scenario = ctx.diagnosis.scenario
      ? ctx.diagnosis.scenario.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
      : 'Unknown';
    const diagConfidence = (ctx.diagnosis.confidence * 100).toFixed(0);

    sections.push('\n## Diagnosis\n');
    sections.push(`- **Scenario:** ${scenario}`);
    sections.push(`- **Status:** ${ctx.diagnosis.status}`);
    sections.push(`- **Confidence:** ${diagConfidence}%`);

    if (ctx.diagnosis.findings.length > 0) {
      sections.push('\n### Findings\n');
      for (const finding of ctx.diagnosis.findings) {
        sections.push(`- **[${finding.severity.toUpperCase()}]** ${finding.observation}`);
      }
    }
  }

  // Recovery plan
  if (ctx.plan) {
    sections.push('\n## Recovery Plan\n');
    sections.push(`- **Plan ID:** ${ctx.plan.metadata?.planId ?? 'N/A'}`);
    sections.push(`- **Steps:** ${ctx.plan.steps.length}`);
    sections.push(`- **Summary:** ${ctx.plan.metadata?.summary ?? 'N/A'}`);
    sections.push(`- **Rollback:** ${ctx.plan.rollbackStrategy.type} — ${ctx.plan.rollbackStrategy.description}`);

    if (ctx.plan.steps.length > 0) {
      sections.push('\n### Steps\n');
      sections.push('| # | Type | Name |');
      sections.push('|---|------|------|');
      ctx.plan.steps.forEach((step, i) => {
        sections.push(`| ${i + 1} | ${step.type} | ${step.name} |`);
      });
    }
  }

  // Recommended actions
  if (ctx.operatorSummary) {
    sections.push('\n## Recommended Actions\n');
    sections.push(`- **Next step:** ${ctx.operatorSummary.recommendedNextStep}`);
    for (const action of ctx.operatorSummary.recommendedActions) {
      sections.push(`- ${action}`);
    }
  }

  // Footer
  sections.push('\n---');
  sections.push('*Generated by [CrisisMode](https://crisismode.ai)*');

  const labels = ['crisismode', `health:${ctx.health.status}`];
  if (ctx.diagnosis?.scenario) {
    labels.push(`scenario:${ctx.diagnosis.scenario}`);
  }

  const title = ctx.diagnosis?.scenario
    ? `[CrisisMode] ${label}: ${ctx.diagnosis.scenario.replace(/_/g, ' ')}`
    : `[CrisisMode] ${label}: ${ctx.health.summary.slice(0, 60)}`;

  return {
    title,
    body: sections.join('\n'),
    labels,
  };
}

// ── Markdown Formatter ──

export function formatMarkdownNotification(ctx: NotificationContext): string {
  const label = SEVERITY_LABEL[ctx.health.status] ?? 'Unknown';
  const confidencePct = (ctx.health.confidence * 100).toFixed(0);

  const lines: string[] = [];

  lines.push(`# CrisisMode Alert: ${label}\n`);
  lines.push(`**Status:** ${label} (${confidencePct}% confidence)  `);
  lines.push(`**Summary:** ${ctx.health.summary}  `);
  lines.push(`**Observed:** ${ctx.health.observedAt}\n`);

  if (ctx.health.signals.length > 0) {
    lines.push('## Signals\n');
    for (const signal of ctx.health.signals) {
      lines.push(`- **[${signal.status.toUpperCase()}]** ${signal.source}: ${signal.detail}`);
    }
    lines.push('');
  }

  if (ctx.diagnosis) {
    const scenario = ctx.diagnosis.scenario
      ? ctx.diagnosis.scenario.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
      : 'Unknown';

    lines.push('## Diagnosis\n');
    lines.push(`**Scenario:** ${scenario}  `);
    lines.push(`**Confidence:** ${(ctx.diagnosis.confidence * 100).toFixed(0)}%\n`);

    for (const finding of ctx.diagnosis.findings) {
      lines.push(`- **[${finding.severity.toUpperCase()}]** ${finding.observation}`);
    }
    lines.push('');
  }

  if (ctx.plan) {
    lines.push('## Recovery Plan\n');
    lines.push(`**Steps:** ${ctx.plan.steps.length} | **Rollback:** ${ctx.plan.rollbackStrategy.type}\n`);
    ctx.plan.steps.forEach((step, i) => {
      lines.push(`${i + 1}. **${step.name}** (${step.type})`);
    });
    lines.push('');
  }

  if (ctx.operatorSummary) {
    lines.push('## Recommended Actions\n');
    lines.push(`**Next step:** ${ctx.operatorSummary.recommendedNextStep}\n`);
    for (const action of ctx.operatorSummary.recommendedActions) {
      lines.push(`- ${action}`);
    }
    lines.push('');
  }

  if (ctx.healthCard) {
    lines.push('## Watch Status\n');
    lines.push(`- **Uptime:** ${ctx.healthCard.uptimePercent}%`);
    lines.push(`- **Cycles:** ${ctx.healthCard.totalCycles}`);
    lines.push(`- **Transitions:** ${ctx.healthCard.transitionCount}`);
    lines.push(`- **Watching since:** ${ctx.healthCard.watchingSince}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ── Postmortem Generator ──

export interface PostmortemDraft {
  title: string;
  markdown: string;
  sections: Array<{ heading: string; content: string }>;
}

export function generatePostmortemDraft(ctx: NotificationContext): PostmortemDraft {
  const timestamp = ctx.health.observedAt;
  const scenario = ctx.diagnosis?.scenario
    ? ctx.diagnosis.scenario.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    : 'Unknown Incident';

  const title = `Postmortem: ${scenario} — ${formatDate(timestamp)}`;
  const sections: Array<{ heading: string; content: string }> = [];

  // Summary
  sections.push({
    heading: 'Incident Summary',
    content: [
      `**Date:** ${formatDate(timestamp)}`,
      `**Status:** ${ctx.health.status}`,
      `**Confidence:** ${(ctx.health.confidence * 100).toFixed(0)}%`,
      `**Summary:** ${ctx.health.summary}`,
      '',
      ctx.diagnosis
        ? `**Root cause (preliminary):** ${ctx.diagnosis.scenario ?? 'Under investigation'}`
        : '**Root cause:** Under investigation',
    ].join('\n'),
  });

  // Timeline
  const timelineEntries: string[] = [];
  timelineEntries.push(`- **${formatTime(timestamp)}** — Health degradation detected`);
  if (ctx.diagnosis) {
    timelineEntries.push(`- **${formatTime(timestamp)}** — Automated diagnosis completed (${ctx.diagnosis.status})`);
  }
  if (ctx.plan) {
    timelineEntries.push(`- **${formatTime(timestamp)}** — Recovery plan generated (${ctx.plan.steps.length} steps)`);
  }
  timelineEntries.push('- **[TODO]** — Add manual investigation steps');
  timelineEntries.push('- **[TODO]** — Add resolution confirmation');

  sections.push({
    heading: 'Timeline',
    content: timelineEntries.join('\n'),
  });

  // Impact
  const impactLines: string[] = [];
  if (ctx.plan?.impact) {
    impactLines.push(`**User impact:** ${ctx.plan.impact.estimatedUserImpact}`);
    impactLines.push(`**Data loss risk:** ${ctx.plan.impact.dataLossRisk}`);
    if (ctx.plan.impact.affectedServices.length > 0) {
      impactLines.push(`**Affected services:** ${ctx.plan.impact.affectedServices.join(', ')}`);
    }
  } else {
    impactLines.push('**User impact:** [TODO: Describe user-facing impact]');
    impactLines.push('**Data loss risk:** [TODO: Assess data loss risk]');
  }
  impactLines.push('**Duration:** [TODO: Add incident duration]');

  sections.push({
    heading: 'Impact',
    content: impactLines.join('\n'),
  });

  // Root Cause
  const rcaLines: string[] = [];
  if (ctx.diagnosis) {
    for (const finding of ctx.diagnosis.findings) {
      rcaLines.push(`- **[${finding.severity.toUpperCase()}]** ${finding.observation}`);
    }
  }
  rcaLines.push('');
  rcaLines.push('**Root cause analysis:** [TODO: Complete root cause analysis]');
  rcaLines.push('**Contributing factors:** [TODO: List contributing factors]');

  sections.push({
    heading: 'Root Cause',
    content: rcaLines.join('\n'),
  });

  // Resolution
  const resolutionLines: string[] = [];
  if (ctx.plan) {
    resolutionLines.push(`Recovery plan with ${ctx.plan.steps.length} steps was generated.`);
    resolutionLines.push(`Rollback strategy: ${ctx.plan.rollbackStrategy.type}\n`);
    ctx.plan.steps.forEach((step, i) => {
      resolutionLines.push(`${i + 1}. ${step.name} (${step.type})`);
    });
  } else {
    resolutionLines.push('[TODO: Describe resolution steps taken]');
  }

  sections.push({
    heading: 'Resolution',
    content: resolutionLines.join('\n'),
  });

  // Action Items
  sections.push({
    heading: 'Action Items',
    content: [
      '| Priority | Action | Owner | Due Date |',
      '|----------|--------|-------|----------|',
      '| P1 | [TODO: Add immediate action items] | [TODO] | [TODO] |',
      '| P2 | [TODO: Add follow-up action items] | [TODO] | [TODO] |',
      '| P3 | [TODO: Add preventive measures] | [TODO] | [TODO] |',
    ].join('\n'),
  });

  // Lessons Learned
  sections.push({
    heading: 'Lessons Learned',
    content: [
      '**What went well:**',
      '- CrisisMode detected the issue automatically',
      ctx.diagnosis ? `- Automated diagnosis identified: ${ctx.diagnosis.scenario}` : '',
      ctx.plan ? '- Recovery plan was generated automatically' : '',
      '',
      '**What could be improved:**',
      '- [TODO: Add areas for improvement]',
      '',
      '**Where we got lucky:**',
      '- [TODO: Add lucky breaks]',
    ].filter(Boolean).join('\n'),
  });

  const markdown = `# ${title}\n\n` +
    sections.map((s) => `## ${s.heading}\n\n${s.content}`).join('\n\n') +
    '\n\n---\n*Generated by [CrisisMode](https://crisismode.ai) — review and complete all [TODO] sections*\n';

  return { title, markdown, sections };
}

// ── Helpers ──

function formatDate(iso: string): string {
  try {
    return new Date(iso).toISOString().split('T')[0];
  } catch {
    return iso;
  }
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
  } catch {
    return iso;
  }
}
