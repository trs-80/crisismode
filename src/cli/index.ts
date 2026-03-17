#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * CrisisMode CLI — unified entry point for all commands.
 *
 * Usage:
 *   crisismode                              # zero-config health scan (default)
 *   crisismode scan                         # explicit health scan
 *   crisismode diagnose                     # health check + diagnosis (read-only)
 *   crisismode recover                      # full recovery (dry-run default)
 *   crisismode status                       # quick health probe
 *   crisismode init                         # generate crisismode.yaml
 *   crisismode demo                         # run simulator demo
 *   crisismode webhook                      # start webhook receiver
 *   crisismode ask "my postgres is slow"    # AI-powered diagnosis
 *   crisismode watch                        # continuous shadow observation
 */

import { parseArgs } from 'node:util';
import { configure } from './output.js';
import { formatError } from './errors.js';

const HELP = `
  CrisisMode — AI-powered infrastructure recovery

  Usage:
    crisismode                              Zero-config health scan (default)
    crisismode scan [options]               Health scan with scored summary
    crisismode diagnose [options]           Health check + diagnosis (read-only)
    crisismode recover [options]            Full recovery flow (dry-run default)
    crisismode status                       Quick health probe
    crisismode init [path]                  Generate crisismode.yaml
    crisismode demo                         Run simulator demo
    crisismode webhook [options]            Start webhook receiver
    crisismode ask "<question>"             Natural language AI diagnosis
    crisismode watch [options]              Continuous shadow observation

  Options:
    --config <path>     Path to crisismode.yaml
    --target <name>     Target name from config
    --category <kinds>  Comma-separated service kinds to scan (scan only)
    --execute           Enable mutations (recover/webhook only)
    --health-only       Health check only, no diagnosis (recover only)
    --json              Machine-readable JSON output
    --no-color          Disable colored output
    --verbose           Show additional detail
    -h, --help          Show this help
    -v, --version       Show version
`;

async function main(): Promise<void> {
  // Extract subcommand (first non-flag arg)
  const args = process.argv.slice(2);
  const subcommand = args[0] && !args[0].startsWith('-') ? args[0] : undefined;
  const restArgs = subcommand ? args.slice(1) : args;

  // Parse global flags
  let parsed;
  try {
    parsed = parseArgs({
      args: restArgs,
      options: {
        config: { type: 'string' },
        target: { type: 'string' },
        category: { type: 'string' },
        execute: { type: 'boolean', default: false },
        'health-only': { type: 'boolean', default: false },
        interval: { type: 'string' },
        json: { type: 'boolean', default: false },
        'no-color': { type: 'boolean', default: false },
        verbose: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
      allowPositionals: true,
      strict: false,
    });
  } catch {
    console.error(HELP);
    process.exit(1);
  }

  const { values, positionals } = parsed;

  // Configure output
  configure({
    json: values.json as boolean,
    noColor: values['no-color'] as boolean,
    verbose: values.verbose as boolean,
  });

  // Help
  if (values.help || subcommand === 'help') {
    console.log(HELP);
    return;
  }

  // Version
  if (values.version) {
    const { readFileSync } = await import('node:fs');
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    try {
      const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf-8'));
      console.log(pkg.version);
    } catch {
      console.log('unknown');
    }
    return;
  }

  // Route to command
  switch (subcommand) {
    case 'scan': {
      const { runScan } = await import('./commands/scan.js');
      const categoryStr = values.category as string | undefined;
      await runScan({
        configPath: values.config as string | undefined,
        category: categoryStr ? categoryStr.split(',').map((s) => s.trim()) : undefined,
        verbose: values.verbose as boolean,
      });
      break;
    }

    case 'diagnose': {
      const { runDiagnose } = await import('./commands/diagnose.js');
      await runDiagnose({
        configPath: values.config as string | undefined,
        targetName: values.target as string | undefined,
      });
      break;
    }

    case 'recover': {
      const { runRecover } = await import('./commands/recover.js');
      await runRecover({
        configPath: values.config as string | undefined,
        targetName: values.target as string | undefined,
        execute: values.execute as boolean,
        healthOnly: values['health-only'] as boolean,
      });
      break;
    }

    case 'status': {
      const { runStatus } = await import('./commands/status.js');
      await runStatus();
      break;
    }

    case 'init': {
      const { runInit } = await import('./commands/init.js');
      await runInit(positionals[0]);
      break;
    }

    case 'demo': {
      const { runDemoCommand } = await import('./commands/demo.js');
      await runDemoCommand();
      break;
    }

    case 'webhook': {
      const { runWebhookCommand } = await import('./commands/webhook.js');
      await runWebhookCommand({
        configPath: values.config as string | undefined,
        execute: values.execute as boolean,
      });
      break;
    }

    case 'ask': {
      const question = positionals.join(' ');
      if (!question) {
        console.error('Usage: crisismode ask "<your question>"');
        process.exit(1);
      }
      const { runAsk } = await import('./commands/ask.js');
      await runAsk(question);
      break;
    }

    case 'watch': {
      const { runWatch } = await import('./commands/watch.js');
      const intervalStr = values.interval as string | undefined;
      await runWatch({
        configPath: values.config as string | undefined,
        targetName: values.target as string | undefined,
        intervalMs: intervalStr ? parseInt(intervalStr, 10) * 1000 : undefined,
      });
      break;
    }

    case undefined: {
      // No subcommand — default to scan (zero-config health scan)
      const { runScan: runDefaultScan } = await import('./commands/scan.js');
      const defaultCategoryStr = values.category as string | undefined;
      await runDefaultScan({
        configPath: values.config as string | undefined,
        category: defaultCategoryStr ? defaultCategoryStr.split(',').map((s) => s.trim()) : undefined,
        verbose: values.verbose as boolean,
      });
      break;
    }

    default: {
      console.error(`Unknown command: ${subcommand}`);
      console.error(HELP);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(formatError(err));
  process.exit(1);
});
