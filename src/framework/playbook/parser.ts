// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { parse as parseYaml } from 'yaml';
import type {
  ParsedPlaybook,
  PlaybookBlastRadius,
  PlaybookCodeBlock,
  PlaybookFrontmatter,
  PlaybookStep,
  PlaybookValidationError,
  PlaybookValidationResult,
} from './types.js';

const VALID_SEVERITIES = ['routine', 'elevated', 'high', 'critical'] as const;

const SNAKE_TO_CAMEL: Record<string, keyof PlaybookStep> = {
  type: 'type',
  description: 'description',
  risk: 'risk',
  target: 'target',
  execution_context: 'executionContext',
  precondition: 'precondition',
  success: 'success',
  channel: 'channel',
  message: 'message',
  timeout: 'timeout',
  escalation: 'escalation',
  condition: 'condition',
  on_success: 'onSuccess',
  on_failure: 'onFailure',
  template: 'template',
};

/**
 * Parse a Markdown playbook into a typed ParsedPlaybook object.
 */
export function parsePlaybook(markdown: string, filePath?: string): ParsedPlaybook {
  const { frontmatterRaw, body } = extractFrontmatter(markdown);

  let frontmatterObj: unknown;
  try {
    frontmatterObj = parseYaml(frontmatterRaw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid YAML in frontmatter: ${message}`);
  }

  const validation = validatePlaybookFrontmatter(frontmatterObj);
  if (!validation.valid) {
    const details = validation.errors.map((e) => `${e.field}: ${e.message}`).join('; ');
    throw new Error(`Invalid playbook frontmatter: ${details}`);
  }

  const frontmatter = normalizeFrontmatter(frontmatterObj as Record<string, unknown>);
  const steps = parseSteps(body);
  const rollback = parseRollback(body);

  return {
    frontmatter,
    steps,
    rollback,
    rawMarkdown: markdown,
    filePath,
  };
}

/**
 * Validate that a parsed frontmatter object has the required shape.
 */
export function validatePlaybookFrontmatter(frontmatter: unknown): PlaybookValidationResult {
  const errors: PlaybookValidationError[] = [];

  if (frontmatter == null || typeof frontmatter !== 'object') {
    errors.push({ field: 'frontmatter', message: 'Must be an object' });
    return { valid: false, errors };
  }

  const fm = frontmatter as Record<string, unknown>;

  if (typeof fm.name !== 'string' || fm.name.trim() === '') {
    errors.push({ field: 'name', message: 'Must be a non-empty string' });
  }
  if (typeof fm.version !== 'string' || fm.version.trim() === '') {
    errors.push({ field: 'version', message: 'Must be a non-empty string' });
  }
  if (typeof fm.description !== 'string' || fm.description.trim() === '') {
    errors.push({ field: 'description', message: 'Must be a non-empty string' });
  }

  if (fm.severity !== undefined) {
    if (!(VALID_SEVERITIES as readonly string[]).includes(fm.severity as string)) {
      errors.push({
        field: 'severity',
        message: `Must be one of: ${VALID_SEVERITIES.join(', ')}`,
      });
    }
  }

  if (fm.triggers !== undefined) {
    if (!Array.isArray(fm.triggers)) {
      errors.push({ field: 'triggers', message: 'Must be an array' });
    } else {
      for (let i = 0; i < fm.triggers.length; i++) {
        const trigger = fm.triggers[i];
        if (
          trigger == null ||
          typeof trigger !== 'object' ||
          typeof (trigger as Record<string, unknown>).alert !== 'string'
        ) {
          errors.push({ field: `triggers[${i}]`, message: 'Each trigger must have an "alert" string' });
        }
      }
    }
  }

  if (fm.requires !== undefined) {
    if (fm.requires == null || typeof fm.requires !== 'object' || Array.isArray(fm.requires)) {
      errors.push({ field: 'requires', message: 'Must be an object' });
    }
  }

  if (fm.tags !== undefined) {
    if (!Array.isArray(fm.tags)) {
      errors.push({ field: 'tags', message: 'Must be an array' });
    } else if (!fm.tags.every((t: unknown) => typeof t === 'string')) {
      errors.push({ field: 'tags', message: 'All tags must be strings' });
    }
  }

  return { valid: errors.length === 0, errors };
}

// --- Internal helpers ---

export function extractFrontmatter(markdown: string): { frontmatterRaw: string; body: string } {
  const lines = markdown.split('\n');

  if (lines[0]?.trim() !== '---') {
    throw new Error('Playbook must start with a YAML frontmatter delimiter (---)');
  }

  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      closingIndex = i;
      break;
    }
  }

  if (closingIndex === -1) {
    throw new Error('Missing closing frontmatter delimiter (---)');
  }

  const frontmatterRaw = lines.slice(1, closingIndex).join('\n');
  const body = lines.slice(closingIndex + 1).join('\n');

  return { frontmatterRaw, body };
}

function normalizeFrontmatter(raw: Record<string, unknown>): PlaybookFrontmatter {
  const fm: PlaybookFrontmatter = {
    name: raw.name as string,
    version: raw.version as string,
    description: raw.description as string,
  };

  if (raw.agent !== undefined) fm.agent = raw.agent as string;
  if (raw.provider !== undefined) fm.provider = raw.provider as string;
  if (raw.severity !== undefined) fm.severity = raw.severity as PlaybookFrontmatter['severity'];
  if (raw.triggers !== undefined) fm.triggers = raw.triggers as PlaybookFrontmatter['triggers'];
  if (raw.requires !== undefined) fm.requires = raw.requires as PlaybookFrontmatter['requires'];
  if (raw.tags !== undefined) fm.tags = raw.tags as string[];
  if (raw.author !== undefined) fm.author = raw.author as string;
  if (raw.estimated_duration !== undefined) fm.estimatedDuration = raw.estimated_duration as string;
  if (raw.estimatedDuration !== undefined) fm.estimatedDuration = raw.estimatedDuration as string;

  return fm;
}

function parseSteps(body: string): PlaybookStep[] {
  const steps: PlaybookStep[] = [];
  // Split on H3 headings: ### N. Title
  const stepPattern = /^### (\d+)\.\s+(.+)$/gm;
  const matches: { index: number; position: number; title: string }[] = [];

  let match: RegExpExecArray | null;
  while ((match = stepPattern.exec(body)) !== null) {
    matches.push({
      index: match.index,
      position: parseInt(match[1], 10),
      title: match[2].trim(),
    });
  }

  // Find the rollback section boundary to avoid including it in the last step
  const rollbackIndex = body.search(/^## Rollback/m);

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index + body.slice(matches[i].index).indexOf('\n') + 1;
    let end: number;
    if (i + 1 < matches.length) {
      end = matches[i + 1].index;
    } else if (rollbackIndex !== -1 && rollbackIndex > matches[i].index) {
      end = rollbackIndex;
    } else {
      end = body.length;
    }

    const sectionContent = body.slice(start, end).trim();
    const step = parseStepSection(sectionContent, matches[i].position, matches[i].title);
    steps.push(step);
  }

  return steps;
}

function parseStepSection(content: string, position: number, title: string): PlaybookStep {
  const { codeBlocks, contentWithoutCode } = processCodeBlocks(content);
  const { properties, bodyLines } = parseProperties(contentWithoutCode);

  const step: PlaybookStep = {
    position,
    title,
    type: (properties.type as string) ?? '',
    body: bodyLines.join('\n').trim(),
    codeBlocks,
  };

  // Map parsed properties to step fields
  for (const [key, value] of Object.entries(properties)) {
    if (key === 'blast_radius') continue; // handled separately
    const camelKey = SNAKE_TO_CAMEL[key];
    if (camelKey && camelKey !== 'type') {
      (step as unknown as Record<string, unknown>)[camelKey] = value;
    }
  }

  // Handle blast_radius
  if (properties.blast_radius !== undefined) {
    step.blastRadius = properties.blast_radius as PlaybookBlastRadius;
  }

  return step;
}

function parseProperties(content: string): {
  properties: Record<string, unknown>;
  bodyLines: string[];
} {
  const properties: Record<string, unknown> = {};
  const bodyLines: string[] = [];
  const lines = content.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const propMatch = line.match(/^- (\w+):\s*(.*)$/);

    if (propMatch) {
      const key = propMatch[1];
      const value = propMatch[2].trim();

      if (key === 'blast_radius' && (value === '' || value === undefined)) {
        // Parse indented sub-properties
        const blastRadius: PlaybookBlastRadius = {};
        i++;
        while (i < lines.length) {
          const subLine = lines[i];
          const subMatch = subLine.match(/^\s+(\w+):\s*(.+)$/);
          if (!subMatch) break;

          const subKey = subMatch[1];
          const subValue = subMatch[2].trim();

          if (subKey === 'max_affected_rows') {
            blastRadius.maxAffectedRows = parseInt(subValue, 10);
          } else if (subKey === 'max_downtime_seconds') {
            blastRadius.maxDowntimeSeconds = parseInt(subValue, 10);
          } else if (subKey === 'requires_maintenance_window') {
            blastRadius.requiresMaintenanceWindow = subValue === 'true';
          }
          i++;
        }
        properties.blast_radius = blastRadius;
        continue;
      }

      // Strip surrounding quotes
      properties[key] = stripQuotes(value);
    } else {
      bodyLines.push(line);
    }

    i++;
  }

  return { properties, bodyLines };
}

function processCodeBlocks(content: string): { codeBlocks: PlaybookCodeBlock[]; contentWithoutCode: string } {
  const codeBlocks: PlaybookCodeBlock[] = [];
  const contentWithoutCode = content.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang: string, code: string) => {
    codeBlocks.push({ lang: lang || '', content: code.trim() });
    return '';
  });
  return { codeBlocks, contentWithoutCode };
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseRollback(body: string): string | undefined {
  const startIndex = body.search(/^## Rollback/m);
  if (startIndex === -1) return undefined;

  const afterHeading = body.slice(startIndex);
  const headingEnd = afterHeading.indexOf('\n');
  if (headingEnd === -1) return undefined;

  const remainder = afterHeading.slice(headingEnd + 1);
  const nextSectionMatch = remainder.search(/^## /m);
  const rollbackContent =
    nextSectionMatch !== -1 ? remainder.slice(0, nextSectionMatch) : remainder;

  const trimmed = rollbackContent.trim();
  return trimmed || undefined;
}
