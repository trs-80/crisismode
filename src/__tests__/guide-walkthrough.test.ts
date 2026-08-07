// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, cpSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  generateWalkthrough,
  parseVerdicts,
  applyVerdicts,
  stampChecklistFile,
  mapGuideIdsToFiles,
  PLATFORM_INFO,
} from '../framework/guidance/walkthrough.js';
import { REMEDIATION_GUIDES } from '../framework/guidance/registry.js';

const REAL_GUIDES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'framework',
  'guidance',
  'guides',
);

function tempGuidesDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'guides-'));
  cpSync(REAL_GUIDES_DIR, dir, { recursive: true });
  return dir;
}

describe('guide walk-through generation', () => {
  const md = generateWalkthrough(REMEDIATION_GUIDES, '2026-08-07', REAL_GUIDES_DIR);

  it('emits exactly one verdict line per registered guide, each carrying its id marker', () => {
    for (const guide of REMEDIATION_GUIDES) {
      const marker = `<!-- guide:${guide.id} -->`;
      const occurrences = md.split(marker).length - 1;
      expect(occurrences, `marker for ${guide.id}`).toBe(1);
    }
    const verdictLines = md.split('\n').filter((l) => l.startsWith('**Verdict:**'));
    expect(verdictLines).toHaveLength(REMEDIATION_GUIDES.length);
    for (const line of verdictLines) expect(line).toContain('PENDING');
  });

  it('includes every console step, url, and expected outcome verbatim', () => {
    for (const guide of REMEDIATION_GUIDES) {
      for (const step of guide.consoleSteps) expect(md).toContain(step);
      expect(md).toContain(guide.expectedAfter);
      if (guide.url) expect(md).toContain(guide.url);
    }
  });

  it('groups guides under one section per platform', () => {
    const platforms = new Set(REMEDIATION_GUIDES.map((g) => g.platform));
    const sections = md.split('\n').filter((l) => /^## .+ — \d+ guide/.test(l));
    expect(sections).toHaveLength(platforms.size);
  });

  it('shows each guide\'s source file in its header line', () => {
    const fileMap = mapGuideIdsToFiles(
      REMEDIATION_GUIDES.map((g) => g.id),
      REAL_GUIDES_DIR,
    );
    for (const guide of REMEDIATION_GUIDES) {
      const file = fileMap.get(guide.id);
      expect(file, `source file for ${guide.id}`).toBeDefined();
      expect(md).toContain(`defined in \`src/framework/guidance/guides/${file}\``);
    }
  });

  it('labels /docs/ links as "Reference doc:" and everything else as "Open:"', () => {
    const docGuideIds = ['supabase-connection-limits', 'supabase-pgvector-index', 'neon-pooled-connection', 'neon-compute-size'];
    for (const id of docGuideIds) {
      const guide = REMEDIATION_GUIDES.find((g) => g.id === id);
      expect(guide, id).toBeDefined();
      expect(guide!.url).toContain('/docs/');
      expect(md).toContain(`**Reference doc:** ${guide!.url}`);
    }

    const nonDocGuide = REMEDIATION_GUIDES.find((g) => g.id === 'anthropic-rotate-key');
    expect(nonDocGuide).toBeDefined();
    expect(nonDocGuide!.url).not.toContain('/docs/');
    expect(md).toContain(`**Open:** ${nonDocGuide!.url}`);
  });

  it('states the stake and mentions BLOCKED in the how-to', () => {
    expect(md).toContain(
      'the person who finds out is a user in the middle of an incident, following directions that no longer match their screen',
    );
    expect(md).toContain('`BLOCKED`');
    expect(md).toContain('a real gap in coverage, not your failure to finish');
  });
});

describe('platform info coverage', () => {
  it('has a PLATFORM_INFO entry for every distinct guide platform', () => {
    const platforms = new Set(REMEDIATION_GUIDES.map((g) => g.platform));
    for (const platform of platforms) {
      expect(PLATFORM_INFO[platform], `PLATFORM_INFO entry for ${platform}`).toBeDefined();
    }
  });

  it('keys the AWS RDS guides under aws-rds with an RDS-specific label', () => {
    const awsGuide = REMEDIATION_GUIDES.find((g) => g.platform === 'aws-rds');
    expect(awsGuide).toBeDefined();
    expect(PLATFORM_INFO['aws-rds']?.label).toBe('AWS Console (RDS)');
  });
});

describe('verdict parsing', () => {
  it('parses MATCHES, DIFFERS with notes, and PENDING', () => {
    const sample = [
      '**Verdict:** MATCHES <!-- guide:anthropic-rotate-key -->',
      '',
      '**Verdict:** DIFFERS <!-- guide:anthropic-rate-limits -->',
      '**Notes:** Limits page moved under Organization settings.',
      '',
      '**Verdict:** PENDING <!-- guide:anthropic-billing-credits -->',
    ].join('\n');

    const { verdicts, warnings } = parseVerdicts(sample);
    expect(warnings).toEqual([]);
    expect(verdicts).toEqual([
      { guideId: 'anthropic-rotate-key', verdict: 'MATCHES', notes: undefined },
      {
        guideId: 'anthropic-rate-limits',
        verdict: 'DIFFERS',
        notes: 'Limits page moved under Organization settings.',
      },
      { guideId: 'anthropic-billing-credits', verdict: 'PENDING', notes: undefined },
    ]);
  });

  it('parses a freshly generated checklist as all-PENDING', () => {
    const md = generateWalkthrough(REMEDIATION_GUIDES, '2026-08-07', REAL_GUIDES_DIR);
    const { verdicts, warnings } = parseVerdicts(md);
    expect(verdicts).toHaveLength(REMEDIATION_GUIDES.length);
    expect(verdicts.every((v) => v.verdict === 'PENDING')).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('parses BLOCKED with a note', () => {
    const sample = [
      '**Verdict:** BLOCKED <!-- guide:anthropic-rotate-key -->',
      '**Notes:** No account on this platform.',
    ].join('\n');
    const { verdicts } = parseVerdicts(sample);
    expect(verdicts).toEqual([
      { guideId: 'anthropic-rotate-key', verdict: 'BLOCKED', notes: 'No account on this platform.' },
    ]);
  });

  it('parses STAMPED with its recorded date, and keeps it separate from MATCHES', () => {
    const sample = '**Verdict:** STAMPED 2026-08-05 <!-- guide:anthropic-rotate-key -->';
    const { verdicts } = parseVerdicts(sample);
    expect(verdicts).toEqual([
      { guideId: 'anthropic-rotate-key', verdict: 'STAMPED', notes: undefined, stampedOn: '2026-08-05' },
    ]);
  });

  it('collects multi-line and indented notes until a blank line', () => {
    const sample = [
      '**Verdict:** DIFFERS <!-- guide:anthropic-rate-limits -->',
      '  **Notes:** Limits page moved.',
      '  It now lives under Organization settings > Limits.',
      '',
      '**Verdict:** PENDING <!-- guide:anthropic-billing-credits -->',
    ].join('\n');
    const { verdicts } = parseVerdicts(sample);
    expect(verdicts[0]).toEqual({
      guideId: 'anthropic-rate-limits',
      verdict: 'DIFFERS',
      notes: 'Limits page moved. It now lives under Organization settings > Limits.',
    });
  });

  it('leniently normalizes emoji/punctuation-decorated verdict tokens', () => {
    const sample = [
      '**Verdict:** ✅ MATCHES <!-- guide:anthropic-rotate-key -->',
      '**Verdict:** MATCHES. <!-- guide:anthropic-rate-limits -->',
    ].join('\n');
    const { verdicts, warnings } = parseVerdicts(sample);
    expect(verdicts).toEqual([
      { guideId: 'anthropic-rotate-key', verdict: 'MATCHES', notes: undefined },
      { guideId: 'anthropic-rate-limits', verdict: 'MATCHES', notes: undefined },
    ]);
    expect(warnings).toEqual([]);
  });

  it('warns on unrecognized verdict tokens and falls back to PENDING', () => {
    const sample = [
      '**Verdict:** MATCH <!-- guide:anthropic-rotate-key -->',
      '**Verdict:** OK <!-- guide:anthropic-rate-limits -->',
    ].join('\n');
    const { verdicts, warnings } = parseVerdicts(sample);
    expect(verdicts.every((v) => v.verdict === 'PENDING')).toBe(true);
    expect(warnings).toEqual([
      'Unrecognized verdict "MATCH" on anthropic-rotate-key — treated as PENDING. Use exactly MATCHES, DIFFERS, or BLOCKED.',
      'Unrecognized verdict "OK" on anthropic-rate-limits — treated as PENDING. Use exactly MATCHES, DIFFERS, or BLOCKED.',
    ]);
  });
});

describe('applying verdicts', () => {
  const ids = new Set(REMEDIATION_GUIDES.map((g) => g.id));

  it('stamps verifiedOn only for MATCHES guides, leaving siblings untouched', () => {
    const dir = tempGuidesDir();
    const result = applyVerdicts(
      [
        { guideId: 'anthropic-rotate-key', verdict: 'MATCHES', notes: undefined },
        { guideId: 'anthropic-rate-limits', verdict: 'DIFFERS', notes: 'menu moved' },
        { guideId: 'anthropic-billing-credits', verdict: 'PENDING', notes: undefined },
      ],
      '2026-08-07',
      dir,
      ids,
    );

    expect(result.stamped).toEqual(['anthropic-rotate-key']);
    expect(result.differs.map((d) => d.guideId)).toEqual(['anthropic-rate-limits']);
    expect(result.differs[0]?.file).toBe('anthropic.ts');
    expect(result.pending).toEqual(['anthropic-billing-credits']);

    const content = readFileSync(join(dir, 'anthropic.ts'), 'utf8');
    const rotateScope = content.slice(
      content.indexOf("id: 'anthropic-rotate-key'"),
      content.indexOf("id: 'anthropic-rate-limits'"),
    );
    const limitsScope = content.slice(
      content.indexOf("id: 'anthropic-rate-limits'"),
      content.indexOf("id: 'anthropic-billing-credits'"),
    );
    expect(rotateScope).toContain("verifiedOn: '2026-08-07'");
    expect(limitsScope).not.toContain("verifiedOn: '2026-08-07'");
  });

  it('buckets BLOCKED verdicts separately, note included', () => {
    const dir = tempGuidesDir();
    const result = applyVerdicts(
      [{ guideId: 'anthropic-rotate-key', verdict: 'BLOCKED', notes: 'no account on this platform' }],
      '2026-08-07',
      dir,
      ids,
    );
    expect(result.blocked).toEqual([
      { guideId: 'anthropic-rotate-key', verdict: 'BLOCKED', notes: 'no account on this platform' },
    ]);
    expect(result.stamped).toEqual([]);
  });

  it('reports unknown guide ids without touching files', () => {
    const dir = tempGuidesDir();
    const before = readFileSync(join(dir, 'anthropic.ts'), 'utf8');
    const result = applyVerdicts(
      [{ guideId: 'no-such-guide', verdict: 'MATCHES', notes: undefined }],
      '2026-08-07',
      dir,
      ids,
    );
    expect(result.unknown).toEqual(['no-such-guide']);
    expect(result.stamped).toEqual([]);
    expect(readFileSync(join(dir, 'anthropic.ts'), 'utf8')).toBe(before);
  });

  it('throws when a MATCHES guide lives in no file under guidesDir', () => {
    const dir = tempGuidesDir();
    const idsWithGhost = new Set([...ids, 'ghost-guide']);
    expect(() =>
      applyVerdicts([{ guideId: 'ghost-guide', verdict: 'MATCHES', notes: undefined }], '2026-08-07', dir, idsWithGhost),
    ).toThrow(/ghost-guide/);
  });

  it('round-trips: a generated checklist edited to MATCHES stamps every guide in that platform', () => {
    const dir = tempGuidesDir();
    const md = generateWalkthrough(REMEDIATION_GUIDES, '2026-08-07', REAL_GUIDES_DIR).replace(
      /\*\*Verdict:\*\* PENDING/g,
      '**Verdict:** MATCHES',
    );
    const { verdicts } = parseVerdicts(md);
    const result = applyVerdicts(verdicts, '2026-08-07', dir, ids);
    expect(result.stamped.sort()).toEqual([...ids].sort());
    for (const file of ['anthropic.ts', 'openai.ts', 'supabase.ts', 'neon.ts', 'aws-rds.ts']) {
      const content = readFileSync(join(dir, file), 'utf8');
      expect(content).not.toMatch(/verifiedOn: '2026-08-05'/);
    }
  });
});

describe('checklist STAMPED round-trip', () => {
  const ids = new Set(REMEDIATION_GUIDES.map((g) => g.id));

  it('rewrites newly-stamped lines to STAMPED <date>, and a later apply at a new date reports them already-stamped with the original date preserved', () => {
    const dir = tempGuidesDir();
    const checklistPath = join(mkdtempSync(join(tmpdir(), 'checklist-')), 'walkthrough.md');
    const generated = generateWalkthrough(REMEDIATION_GUIDES, '2026-08-07', REAL_GUIDES_DIR);
    const firstPassMd = generated.replace(
      /\*\*Verdict:\*\* PENDING <!-- guide:anthropic-rotate-key -->/,
      '**Verdict:** MATCHES <!-- guide:anthropic-rotate-key -->',
    );
    writeFileSync(checklistPath, firstPassMd);

    // First apply: stamps the guide source file and rewrites the checklist line to STAMPED.
    const raw1 = readFileSync(checklistPath, 'utf8');
    const { verdicts: verdicts1 } = parseVerdicts(raw1);
    const result1 = applyVerdicts(verdicts1, '2026-08-07', dir, ids);
    expect(result1.stamped).toEqual(['anthropic-rotate-key']);
    const updated1 = stampChecklistFile(raw1, result1.stamped, '2026-08-07');
    writeFileSync(checklistPath, updated1);
    expect(updated1).toContain('**Verdict:** STAMPED 2026-08-07 <!-- guide:anthropic-rotate-key -->');

    // Second apply, different date: previously-stamped guide is reported already-stamped
    // with its original date, not re-stamped, and the checklist file is unchanged for that line.
    const raw2 = readFileSync(checklistPath, 'utf8');
    const { verdicts: verdicts2 } = parseVerdicts(raw2);
    const result2 = applyVerdicts(verdicts2, '2026-09-01', dir, ids);
    expect(result2.stamped).not.toContain('anthropic-rotate-key');
    expect(result2.alreadyStamped).toContainEqual({ guideId: 'anthropic-rotate-key', date: '2026-08-07' });
    const updated2 = stampChecklistFile(raw2, result2.stamped, '2026-09-01');
    expect(updated2).toContain('**Verdict:** STAMPED 2026-08-07 <!-- guide:anthropic-rotate-key -->');
    expect(updated2).not.toContain('STAMPED 2026-09-01');

    const content = readFileSync(join(dir, 'anthropic.ts'), 'utf8');
    expect(content).toContain("verifiedOn: '2026-08-07'");
    expect(content).not.toContain("verifiedOn: '2026-09-01'");
  });
});
