// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * CLI command: crisismode playbook <subcommand>
 *
 * Subcommands:
 *   validate <path>  — Parse and validate a playbook
 *   list             — List all discovered playbooks
 *   dry-run <path>   — Simulate playbook execution
 */

import { readFile } from 'node:fs/promises';
import { parsePlaybook } from '../../framework/playbook/parser.js';
import { playbookToPlan } from '../../framework/playbook/runtime.js';
import { discoverPlaybooks } from '../../framework/playbook/discovery.js';
import { printInfo, printSuccess, printError, printWarning } from '../output.js';

export interface PlaybookOptions {
  subcommand: string;
  args: string[];
  json?: boolean;
}

export async function runPlaybook(options: PlaybookOptions): Promise<void> {
  switch (options.subcommand) {
    case 'validate':
      return runValidate(options);
    case 'list':
      return runList(options);
    case 'dry-run':
      return runDryRun(options);
    default:
      printError(`Unknown subcommand: ${options.subcommand}`);
      process.exit(1);
  }
}

async function runValidate(opts: PlaybookOptions): Promise<void> {
  const filePath = opts.args[0];
  if (!filePath) {
    printError('Usage: crisismode playbook validate <path>');
    process.exit(1);
  }

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      console.log(JSON.stringify({ valid: false, error: message }));
    } else {
      printError(`Failed to read ${filePath}: ${message}`);
    }
    process.exit(1);
    return;
  }

  try {
    const playbook = parsePlaybook(content, filePath);
    const plan = playbookToPlan(playbook);

    if (opts.json) {
      console.log(JSON.stringify({
        valid: true,
        name: playbook.frontmatter.name,
        version: playbook.frontmatter.version,
        stepCount: playbook.steps.length,
        planStepCount: plan.steps.length,
      }));
    } else {
      printSuccess(
        `${filePath}: valid playbook "${playbook.frontmatter.name}" v${playbook.frontmatter.version} ` +
        `(${playbook.steps.length} step(s), compiles to ${plan.steps.length} plan step(s))`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      console.log(JSON.stringify({ valid: false, error: message }));
    } else {
      printError(`${filePath}: ${message}`);
    }
    process.exit(1);
  }
}

async function runList(opts: PlaybookOptions): Promise<void> {
  const result = await discoverPlaybooks();

  if (opts.json) {
    console.log(JSON.stringify(result.playbooks.map((p) => ({
      name: p.frontmatter.name,
      version: p.frontmatter.version,
      description: p.frontmatter.description,
      source: p.source,
      filePath: p.filePath,
      agent: p.frontmatter.agent,
      tags: p.frontmatter.tags,
    })), null, 2));
    return;
  }

  if (result.playbooks.length === 0) {
    printInfo('No playbooks discovered.');
    printInfo('Place .md playbooks in ~/.crisismode/playbooks/ or ./playbooks/');
    return;
  }

  printInfo(`${result.playbooks.length} playbook(s) discovered\n`);

  // Compute column widths
  const nameWidth = Math.max(4, ...result.playbooks.map((p) => p.frontmatter.name.length));
  const versionWidth = Math.max(7, ...result.playbooks.map((p) => p.frontmatter.version.length));
  const sourceWidth = Math.max(6, ...result.playbooks.map((p) => p.source.length));

  // Header
  const header = `  ${'NAME'.padEnd(nameWidth)}  ${'VERSION'.padEnd(versionWidth)}  ${'SOURCE'.padEnd(sourceWidth)}  DESCRIPTION`;
  console.log(header);
  console.log(`  ${'─'.repeat(nameWidth)}  ${'─'.repeat(versionWidth)}  ${'─'.repeat(sourceWidth)}  ${'─'.repeat(40)}`);

  for (const playbook of result.playbooks) {
    const fm = playbook.frontmatter;
    console.log(
      `  ${fm.name.padEnd(nameWidth)}  ${fm.version.padEnd(versionWidth)}  ${playbook.source.padEnd(sourceWidth)}  ${fm.description}`,
    );
  }

  // Print warnings
  if (result.warnings.length > 0) {
    console.log('');
    for (const warning of result.warnings) {
      printWarning(`${warning.path}: ${warning.reason}`);
    }
  }
}

async function runDryRun(opts: PlaybookOptions): Promise<void> {
  const filePath = opts.args[0];
  if (!filePath) {
    printError('Usage: crisismode playbook dry-run <path>');
    process.exit(1);
  }

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    printError(`Failed to read ${filePath}: ${message}`);
    process.exit(1);
    return;
  }

  try {
    const playbook = parsePlaybook(content, filePath);
    const plan = playbookToPlan(playbook);

    if (opts.json) {
      console.log(JSON.stringify(plan, null, 2));
      return;
    }

    printInfo(`Compiled plan: "${plan.metadata.planId}" (${plan.steps.length} step(s))\n`);

    for (const step of plan.steps) {
      const riskLabel = 'riskLevel' in step ? ` [${(step as unknown as Record<string, unknown>).riskLevel}]` : '';
      console.log(`  ${step.stepId}  ${step.type}${riskLabel}`);
      console.log(`    ${step.name}`);
      console.log('');
    }

    if (plan.rollbackStrategy) {
      printInfo(`Rollback: ${plan.rollbackStrategy.description}`);
    }

    printInfo('NOTE: Actual execution against simulators is future work.');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    printError(`Failed to compile playbook: ${message}`);
    process.exit(1);
  }
}
