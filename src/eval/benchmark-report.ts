// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Diagnosis eval — benchmark result summarization.
 *
 * Consumes the JSON payload emitted by the sre-incident-agent-skills
 * `incident_generator benchmark-runner` (schema
 * incident-generator.benchmark-result/v1) when run with an external
 * `--adapter-command` (the real `crisismode bundle respond -`), and renders
 * a per-family report: which incident families pass, which fail, and why.
 */

export interface BenchmarkCaseResult {
  case_id: string;
  /** 'passed' | 'failed' in benchmark-result/v1 */
  state?: string;
  failure_class?: string;
  duration_ms?: number;
  scoring?: {
    overall_pass?: boolean;
    hypothesis_pass?: boolean;
    abstention_pass?: boolean;
    action_policy_pass?: boolean;
    evidence_reference_pass?: boolean;
    false_attribution_pass?: boolean;
    uncertainty_pass?: boolean;
  };
  diagnosis?: {
    primary_hypothesis?: string | null;
    matched_expected_hypotheses?: string[];
    missing_expected_hypotheses?: string[];
    unexpected_hypotheses?: string[];
    evidence_refs?: string[];
  };
  evidence_discipline?: {
    abstained?: boolean;
    abstention_required?: boolean;
    false_attribution_observed?: string[];
    forbidden_hypotheses_observed?: string[];
    uncertainty_required?: boolean;
    uncertainty_stated?: boolean;
  };
  action_safety?: {
    action_policy_pass?: boolean;
    violations?: string[];
  };
}

export interface BenchmarkRunnerPayload {
  schema_version?: string;
  created_at?: string;
  benchmark_set?: {
    benchmark_set_id?: string;
    name?: string;
    case_count?: number;
  };
  aggregate?: Record<string, unknown>;
  results?: BenchmarkCaseResult[];
}

export interface CaseSummary {
  caseId: string;
  passed: boolean;
  failureClass: string;
  primaryHypothesis: string;
  durationMs: number | null;
  reasons: string[];
}

export interface BenchmarkSummary {
  benchmarkSetId: string;
  benchmarkSetName: string;
  score: string;
  passedCount: number;
  caseCount: number;
  aggregate: Record<string, unknown>;
  cases: CaseSummary[];
}

function casePassed(result: BenchmarkCaseResult): boolean {
  if (result.state !== undefined) return result.state === 'passed';
  return result.scoring?.overall_pass === true;
}

/** Derive human-readable failure reasons from a case result's details. */
function caseReasons(result: BenchmarkCaseResult): string[] {
  if (casePassed(result)) return [];
  const reasons: string[] = [];

  const d = result.diagnosis ?? {};
  for (const missing of d.missing_expected_hypotheses ?? []) {
    reasons.push(`missing expected hypothesis: "${missing}"`);
  }
  if ((d.unexpected_hypotheses ?? []).length > 0) {
    reasons.push(`unexpected hypotheses: ${(d.unexpected_hypotheses ?? []).map((h) => `"${h}"`).join(', ')}`);
  }

  const e = result.evidence_discipline ?? {};
  for (const fa of e.false_attribution_observed ?? []) {
    reasons.push(`false attribution: ${fa}`);
  }
  for (const forbidden of e.forbidden_hypotheses_observed ?? []) {
    reasons.push(`forbidden hypothesis stated: "${forbidden}"`);
  }
  if (e.abstention_required && !e.abstained) {
    reasons.push('abstention required but the adapter answered');
  }
  if (e.abstained && !e.abstention_required) {
    reasons.push('abstained although a diagnosis was expected');
  }
  if (e.uncertainty_required && !e.uncertainty_stated) {
    reasons.push('uncertainty statement required but missing');
  }

  const a = result.action_safety ?? {};
  if (a.action_policy_pass === false) {
    const detail = (a.violations ?? []).join('; ');
    reasons.push(`action policy violation${detail ? `: ${detail}` : ''}`);
  }

  if (result.scoring?.evidence_reference_pass === false) {
    const cited = (d.evidence_refs ?? []).length;
    reasons.push(`evidence reference requirement not met (${cited} cited)`);
  }

  if (reasons.length === 0) {
    reasons.push(`failed (${result.failure_class ?? 'unclassified'})`);
  }
  return reasons;
}

export function summarizeBenchmarkResults(payload: BenchmarkRunnerPayload): BenchmarkSummary {
  const results = payload.results ?? [];
  const passedCount = results.filter(casePassed).length;

  return {
    benchmarkSetId: payload.benchmark_set?.benchmark_set_id ?? 'unknown',
    benchmarkSetName: payload.benchmark_set?.name ?? 'unknown',
    score: `${passedCount}/${results.length}`,
    passedCount,
    caseCount: results.length,
    aggregate: payload.aggregate ?? {},
    cases: results.map((r) => ({
      caseId: r.case_id,
      passed: casePassed(r),
      failureClass: r.failure_class ?? 'none',
      primaryHypothesis: r.diagnosis?.primary_hypothesis ?? '',
      durationMs: r.duration_ms ?? null,
      reasons: caseReasons(r),
    })),
  };
}

export interface ReportMetadata {
  adapterLabel: string;
  gitSha: string;
  ranAt: string;
}

/** Escape a value for inclusion in a single markdown table cell. */
function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();
}

export function renderMarkdownReport(summary: BenchmarkSummary, meta: ReportMetadata): string {
  const lines: string[] = [];
  lines.push('# Diagnosis eval — SRE incident-family benchmark');
  lines.push('');
  lines.push(`- **Score:** ${summary.score}`);
  lines.push(`- **Benchmark set:** ${summary.benchmarkSetName} (\`${summary.benchmarkSetId}\`)`);
  lines.push(`- **Adapter:** ${meta.adapterLabel}`);
  lines.push(`- **crisismode commit:** ${meta.gitSha}`);
  lines.push(`- **Ran at:** ${meta.ranAt}`);
  lines.push('');
  lines.push('| Case | Pass | Primary hypothesis | Why it failed |');
  lines.push('|---|---|---|---|');
  for (const c of summary.cases) {
    lines.push(
      `| ${cell(c.caseId)} | ${c.passed ? '✅' : '❌'} | ${cell(c.primaryHypothesis)} | ${cell(c.reasons.join('; '))} |`,
    );
  }
  lines.push('');
  lines.push('## Aggregate');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(summary.aggregate, null, 2));
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}
