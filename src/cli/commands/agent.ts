// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * CLI command: crisismode agent <subcommand>
 *
 * Subcommands:
 *   list          — List all registered agents (builtin + discovered plugins)
 *   info <name>   — Show details for a specific agent
 */

import { builtinAgents } from '../../config/builtin-agents.js';
import { discoverAgentPlugins } from '../../framework/registry/local.js';
import type { DiscoveredAgentPlugin } from '../../framework/registry/types.js';
import { printInfo, printError } from '../output.js';

export interface AgentCommandOptions {
  subcommand: string;
  args: string[];
  json?: boolean;
}

export async function runAgent(opts: AgentCommandOptions): Promise<void> {
  switch (opts.subcommand) {
    case 'list':
      return runList(opts);
    case 'info':
      return runInfo(opts);
    default:
      printError(`Unknown subcommand: ${opts.subcommand}`);
      console.error('Usage: crisismode agent list|info <name>');
      process.exit(1);
  }
}

// ── list ──

async function runList(opts: AgentCommandOptions): Promise<void> {
  const { plugins, warnings } = await discoverAgentPlugins();

  if (opts.json) {
    const entries = [
      ...builtinAgents.map((a) => ({
        name: a.name,
        type: 'builtin' as const,
        targetSystems: a.manifest.spec.targetSystems.map((t) => t.technology),
        riskLevel: a.manifest.spec.riskProfile.maxRiskLevel,
        description: a.manifest.metadata.description,
        source: 'builtin',
      })),
      ...plugins.map((p) => ({
        name: p.manifest.name,
        type: 'plugin' as const,
        targetSystems: p.manifest.targetKinds,
        riskLevel: p.manifest.riskProfile?.maxRiskLevel ?? 'unknown',
        description: p.manifest.description,
        source: p.source,
      })),
    ];
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  const totalCount = builtinAgents.length + plugins.length;
  printInfo(`${totalCount} agent(s) registered\n`);

  // Header
  const nameW = 38;
  const typeW = 10;
  const targetW = 24;
  const riskW = 10;
  const sourceW = 14;
  console.log(
    pad('Name', nameW) +
      pad('Type', typeW) +
      pad('Targets', targetW) +
      pad('Risk', riskW) +
      pad('Source', sourceW),
  );
  console.log('-'.repeat(nameW + typeW + targetW + riskW + sourceW));

  // Built-in agents
  for (const agent of builtinAgents) {
    const targets = agent.manifest.spec.targetSystems.map((t) => t.technology).join(', ');
    console.log(
      pad(agent.name, nameW) +
        pad('builtin', typeW) +
        pad(targets, targetW) +
        pad(agent.manifest.spec.riskProfile.maxRiskLevel, riskW) +
        pad('builtin', sourceW),
    );
  }

  // Plugin agents
  for (const plugin of plugins) {
    const targets = plugin.manifest.targetKinds.join(', ');
    console.log(
      pad(plugin.manifest.name, nameW) +
        pad('plugin', typeW) +
        pad(targets, targetW) +
        pad(plugin.manifest.riskProfile?.maxRiskLevel ?? '-', riskW) +
        pad(plugin.source, sourceW),
    );
  }

  if (warnings.length > 0) {
    console.log('');
    for (const w of warnings) {
      printError(`Warning: ${w.path} — ${w.reason}`);
    }
  }
}

// ── info ──

async function runInfo(opts: AgentCommandOptions): Promise<void> {
  const name = opts.args[0];
  if (!name) {
    printError('Usage: crisismode agent info <name>');
    process.exit(1);
  }

  // Search builtin agents first
  const builtin = builtinAgents.find((a) => a.name === name);
  if (builtin) {
    if (opts.json) {
      console.log(JSON.stringify({
        name: builtin.name,
        type: 'builtin',
        kind: builtin.kind,
        description: builtin.manifest.metadata.description,
        version: builtin.manifest.metadata.version,
        targetSystems: builtin.manifest.spec.targetSystems,
        riskProfile: builtin.manifest.spec.riskProfile,
        tags: builtin.manifest.metadata.tags,
        license: builtin.manifest.metadata.license,
      }, null, 2));
      return;
    }
    printBuiltinInfo(builtin);
    return;
  }

  // Search discovered plugins
  const { plugins } = await discoverAgentPlugins();
  const plugin = plugins.find((p) => p.manifest.name === name);
  if (plugin) {
    if (opts.json) {
      console.log(JSON.stringify({
        ...plugin.manifest,
        type: 'plugin',
        pluginDir: plugin.pluginDir,
        source: plugin.source,
      }, null, 2));
      return;
    }
    printPluginInfo(plugin);
    return;
  }

  printError(`Agent not found: ${name}`);
  process.exit(1);
}

// ── Helpers ──

function printBuiltinInfo(agent: (typeof builtinAgents)[number]): void {
  const m = agent.manifest;
  console.log(`Name:          ${agent.name}`);
  console.log(`Type:          builtin`);
  console.log(`Kind:          ${agent.kind}`);
  console.log(`Version:       ${m.metadata.version}`);
  console.log(`Description:   ${m.metadata.description}`);
  console.log(`Targets:       ${m.spec.targetSystems.map((t) => t.technology).join(', ')}`);
  console.log(`Risk level:    ${m.spec.riskProfile.maxRiskLevel}`);
  console.log(`Data loss:     ${m.spec.riskProfile.dataLossPossible ? 'possible' : 'no'}`);
  console.log(`Tags:          ${m.metadata.tags.join(', ')}`);
  console.log(`License:       ${m.metadata.license}`);
}

function printPluginInfo(plugin: DiscoveredAgentPlugin): void {
  const m = plugin.manifest;
  console.log(`Name:          ${m.name}`);
  console.log(`Type:          plugin`);
  console.log(`Kind:          ${m.kind}`);
  console.log(`Version:       ${m.version}`);
  console.log(`Description:   ${m.description}`);
  console.log(`Targets:       ${m.targetKinds.join(', ')}`);
  console.log(`Risk level:    ${m.riskProfile?.maxRiskLevel ?? '-'}`);
  console.log(`Data loss:     ${m.riskProfile ? (m.riskProfile.dataLossPossible ? 'possible' : 'no') : '-'}`);
  console.log(`Min version:   ${m.crisismode.minVersion}`);
  console.log(`Source:        ${plugin.source}`);
  console.log(`Directory:     ${plugin.pluginDir}`);
  if (m.author) console.log(`Author:        ${m.author}`);
  if (m.license) console.log(`License:       ${m.license}`);
  if (m.repository) console.log(`Repository:    ${m.repository}`);
  if (m.entryPoint) console.log(`Entry point:   ${m.entryPoint}`);
}

function pad(str: string, width: number): string {
  return str.length >= width ? str + '  ' : str + ' '.repeat(width - str.length);
}
