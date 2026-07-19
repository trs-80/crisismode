// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * `crisismode readiness` — forward-looking scale-readiness report.
 * Read-only; suggest escalation level at most.
 */

import { runReadiness } from '../../readiness/run.js';
import { printBanner, printInfo, jsonOut, getOutputMode } from '../output.js';
import type { ReadinessReport } from '../../readiness/types.js';

const STATUS_ICON: Record<string, string> = {
  ready: '✅', at_risk: '🟡', blocking: '🔴', unknown: '❔',
};

export function renderReadinessReport(report: ReadinessReport): string[] {
  const lines: string[] = [];
  lines.push(`Scale readiness: ${report.verdict} (score ${report.score}/100)`);
  lines.push(`${report.evaluated} rules evaluated, ${report.unknown} could not run`);
  lines.push('');
  for (const f of report.findings) {
    lines.push(`${STATUS_ICON[f.status] ?? '·'} ${f.title} [${f.status}]`);
    for (const e of f.evidence) lines.push(`    ${e}`);
    if (f.status === 'unknown' && f.reason) lines.push(`    could not run: ${f.reason}`);
    if (f.status === 'at_risk' || f.status === 'blocking') {
      lines.push(`    ${f.explanation}`);
      lines.push(`    Fix: ${f.fix}`);
      lines.push(`    Learn more: ${f.learnMoreUrl}`);
    }
  }
  if (report.ceilings) {
    lines.push('');
    lines.push('Capacity ceilings (upper bounds — real capacity is lower):');
    for (const c of report.ceilings) {
      const label = `[${c.evidenceClasses.join('×')}: ${c.evidence.join('; ')}]`;
      if (c.value !== null) {
        lines.push(`  ${c.title}: at most ${c.value} ${c.unit} ${label}`);
      } else {
        lines.push(`  ${c.title}: typically ${c.rangeLow}–${c.rangeHigh} ${c.unit} (cited range, not a measurement) ${label}`);
      }
    }
    for (const o of report.ceilingsOmitted ?? []) {
      lines.push(`  Could not assess: ${o.id} — ${o.reason}`);
    }
    const wl = report.weakLink;
    if (wl) {
      if (wl.conditional.length > 0) {
        const parts = wl.conditional.map((c) => `${c.queriesPerRequest} → ~${c.requestsPerSec} req/s (${c.bindingCeilingId})`);
        const prefix = wl.binding === null ? 'varies by assumption: ' : '';
        lines.push(`Weak link (conditional — fan-out assumed, not measured): ${prefix}queries/request ${parts.join('; ')}`);
        lines.push(`  ${wl.note}`);
      } else {
        lines.push(`Weak link: ${wl.note}`);
      }
    }
  }
  return lines;
}

export async function runReadinessCommand(): Promise<void> {
  const report = await runReadiness();
  if (getOutputMode() === 'machine') {
    jsonOut('readiness', report);
    return;
  }
  printBanner();
  for (const line of renderReadinessReport(report)) printInfo(line);
}
