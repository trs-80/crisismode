// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * `crisismode registry` — browse and install check plugins from the curated registry.
 *
 * Subcommands:
 *   list              List all available check plugins
 *   search <query>    Search by name, description, or target kind
 *   install <name>    Download and install a check plugin
 */

import { fetchRegistry, matchEntries } from '../../config/check-registry.js';
import type { CheckRegistryEntry } from '../../config/check-registry.js';
import { installCheck, getInstalledVersion } from '../../framework/check-installer.js';
import { printInfo, printSuccess, printError } from '../output.js';

export interface RegistryOptions {
  subcommand: 'list' | 'install' | 'search';
  args: string[];
  local?: boolean;
  force?: boolean;
  json?: boolean;
}

export async function runRegistry(opts: RegistryOptions): Promise<void> {
  switch (opts.subcommand) {
    case 'list':
      return runList(opts);
    case 'search':
      return runSearch(opts);
    case 'install':
      return runInstall(opts);
  }
}

async function runList(opts: RegistryOptions): Promise<void> {
  const registry = await fetchRegistry();

  if (opts.json) {
    const entries = registry.checks.map((c) => ({
      ...c,
      installed: getInstalledVersion(c.name) !== null,
      installedVersion: getInstalledVersion(c.name),
    }));
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  printInfo(`${registry.checks.length} check(s) available (registry updated ${registry.updatedAt.split('T')[0]})\n`);
  printTable(registry.checks);
  console.log('');
  printInfo('Install with: crisismode registry install <name>');
}

async function runSearch(opts: RegistryOptions): Promise<void> {
  const query = opts.args.join(' ');
  if (!query) {
    printError('Usage: crisismode registry search <query>');
    process.exit(1);
  }

  const registry = await fetchRegistry();
  const results = matchEntries(registry.checks, query);

  if (opts.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  if (results.length === 0) {
    printInfo(`No checks matching "${query}".`);
    return;
  }

  printInfo(`${results.length} check(s) matching "${query}"\n`);
  printTable(results);
}

async function runInstall(opts: RegistryOptions): Promise<void> {
  const name = opts.args[0];
  if (!name) {
    printError('Usage: crisismode registry install <name>');
    process.exit(1);
  }

  const registry = await fetchRegistry();
  const entry = registry.checks.find((c) => c.name === name);

  if (!entry) {
    // Suggest fuzzy matches
    const suggestions = matchEntries(registry.checks, name);
    if (suggestions.length > 0) {
      printError(`Check "${name}" not found. Did you mean:`);
      for (const s of suggestions.slice(0, 3)) {
        printInfo(`  ${s.name} — ${s.description}`);
      }
    } else {
      printError(`Check "${name}" not found. Run \`crisismode registry list\` to see available checks.`);
    }
    process.exit(1);
  }

  try {
    const result = await installCheck(entry, {
      ...(opts.local !== undefined ? { local: opts.local } : {}),
      ...(opts.force !== undefined ? { force: opts.force } : {}),
    });
    printSuccess(`Installed ${result.name}@${entry.version} -> ${result.installedTo}`);
    printInfo('Run: crisismode scan');
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

function printTable(entries: CheckRegistryEntry[]): void {
  // Compute column widths
  const nameWidth = Math.max(4, ...entries.map((e) => e.name.length));
  const versionWidth = Math.max(7, ...entries.map((e) => e.version.length));

  // Header
  const header = `  ${'NAME'.padEnd(nameWidth)}  ${'VERSION'.padEnd(versionWidth)}  ${'STATUS'.padEnd(16)}  DESCRIPTION`;
  console.log(header);
  console.log(`  ${'─'.repeat(nameWidth)}  ${'─'.repeat(versionWidth)}  ${'─'.repeat(16)}  ${'─'.repeat(40)}`);

  for (const entry of entries) {
    const installed = getInstalledVersion(entry.name);
    let status: string;
    if (installed === null) {
      status = '';
    } else if (installed === entry.version) {
      status = 'installed';
    } else {
      status = `update: ${installed}`;
    }

    console.log(
      `  ${entry.name.padEnd(nameWidth)}  ${entry.version.padEnd(versionWidth)}  ${status.padEnd(16)}  ${entry.description}`,
    );
  }
}
