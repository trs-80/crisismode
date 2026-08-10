// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * CLI routing — argv in, exit code out.
 *
 * Split out of index.ts so it can be driven from tests without triggering a
 * CLI run on import (index.ts is the bundle entry point and must
 * self-execute). Commands *return* an `ExitCode`; nothing below sets
 * `process.exitCode` — index.ts does that, once.
 */

import { parseCli, parseIntervalSeconds } from './args.js';
import { CliUsageError, ExitCode } from './exit-codes.js';
import { severityExitCode } from './status-presentation.js';
import { configure, setOutputOptions } from './output.js';
import { formatError, CrisisModeError } from './errors.js';
import { ConfigNotFoundError, ConfigValidationError } from '../config/loader.js';

export const HELP = `
  CrisisMode — AI-powered infrastructure recovery

  Usage:
    crisismode                              Zero-config health scan (default)
    crisismode scan [options]               Health scan with scored summary
    crisismode diagnose [options]           Health check + diagnosis (read-only)
    crisismode recover [options]            Full recovery flow (dry-run default)
    crisismode status                       Quick health probe
    crisismode triage                       Is it me, my network, or them? (exit 1 when local/network/mixed)
    crisismode down [<service>...]          Is <service> down, or is it just me? (exit 0/1/2; bare form checks configured services)
    crisismode readiness                    Scale-readiness report (read-only, will-it-break-under-load)
    crisismode init [path]                  Generate crisismode.yaml
    crisismode init --plugin <name>         Scaffold a check plugin
    crisismode demo                         Run simulator demo
    crisismode webhook [options]            Start webhook receiver
    crisismode ask "<question>"             Natural language AI diagnosis
    crisismode ask                          Interactive diagnostic REPL
    crisismode watch [options]              Continuous shadow observation
    crisismode completions bash|zsh|fish   Generate shell completions
    crisismode registry list               List available check plugins
    crisismode registry search <query>     Search check plugins
    crisismode registry install <name>     Install a check plugin
    crisismode playbook list               List discovered playbooks
    crisismode playbook validate <path>    Validate a playbook file
    crisismode playbook dry-run <path>     Preview compiled recovery plan
    crisismode agent list                  List all registered agents
    crisismode agent info <name>           Show details for a specific agent
    crisismode bundle ingest <path|->      Ingest an SRE evidence bundle (v1)
    crisismode bundle respond <path|->     Emit AdapterResponse v1 (use "-" for stdin)
    crisismode bundle execute <path|->     Translate bundle to RecoveryPlan (dry-run)
    crisismode mcp                         Start MCP server on stdio (read-only diagnosis tools)

  Options:
    --plugin <name>     Scaffold a new check plugin (init only)
    --agent <name>      Deprecated alias for --plugin (init only); --plugin wins
                        if both are given
    --config <path>     Path to crisismode.yaml
    --target <name>     Target name from config
    --category <kinds>  Comma-separated service kinds to scan (scan only)
    --interval <seconds>
                        Poll interval for watch, as a whole number of seconds
                        greater than 0 (e.g. --interval 30). Unit suffixes
                        like "30s" or "1m" are not accepted.
    --output <file>     Write machine-readable output to a file (bundle only)
    --terse             Suppress plain-language explanations and risk framing
                        (affects human output only; machine/--json always
                        carries the full data)
    --execute           Enable mutations (recover/webhook only)
    --health-only       Health check only, no diagnosis (recover only)
    --local             Install to ./checks/ instead of ~/.crisismode/checks/
    --force             Overwrite existing plugin installation
    --json              Machine-readable JSON output
    --no-color          Disable colored output
    --verbose           Show additional detail
    -h, --help          Show this help
    -v, --version       Show version

  Exit codes:
    0   healthy / the command did what was asked
    1   ran fine, the answer is bad news (unhealthy target, service down,
        validation failed)
    2   called wrong (unknown command or flag, missing value, bad config)
    3   nothing could be checked — every finding came back unknown. Not a
        clean bill of health: CrisisMode was blind, not reassured
    70  unexpected internal failure
`;

/** Print a usage error and return the one code that means "you called this wrong". */
function usageError(message: string): ExitCode {
  console.error(`crisismode: ${message}`);
  return ExitCode.USAGE;
}

/**
 * A missing or malformed required subcommand — `crisismode agent` with
 * nothing after it. Historically 1 (and 1 for `completions` with no shell),
 * against `down --bogusflag`'s 2 for the same class of mistake. Now 2
 * everywhere.
 */
function requireSubcommand<T extends string>(
  command: string,
  candidate: string | undefined,
  allowed: readonly T[],
): T | typeof ExitCode.USAGE {
  if (candidate !== undefined && (allowed as readonly string[]).includes(candidate)) {
    return candidate as T;
  }
  console.error(`crisismode ${command}: expected one of ${allowed.join('|')}`);
  console.error(`Usage: crisismode ${command} ${allowed.join('|')}`);
  return ExitCode.USAGE;
}

async function printVersion(): Promise<void> {
  // Inlined by esbuild at bundle time; falls back to package.json for dev.
  if (process.env.__CRISISMODE_VERSION) {
    console.log(process.env.__CRISISMODE_VERSION);
    return;
  }
  const { readFile } = await import('node:fs/promises');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  try {
    const pkg = JSON.parse(await readFile(resolve(here, '../../package.json'), 'utf-8')) as { version?: string };
    console.log(pkg.version ?? 'unknown');
  } catch {
    console.log('unknown');
  }
}

/**
 * Route one invocation. Returns the process exit code; never calls
 * `process.exit` and never writes `process.exitCode`.
 */
export async function runCli(argv: readonly string[]): Promise<ExitCode> {
  const parsed = parseCli(argv);
  if (parsed.kind === 'usage') {
    return usageError(parsed.message);
  }

  const { command, values, positionals } = parsed;

  configure({
    json: values.json === true,
    noColor: values['no-color'] === true,
    verbose: values.verbose === true,
  });
  setOutputOptions({ terse: values.terse === true });

  if (values.help === true || command === 'help') {
    console.log(HELP);
    return ExitCode.OK;
  }

  if (values.version === true) {
    await printVersion();
    return ExitCode.OK;
  }

  const configPath = values.config;

  switch (command) {
    // `scan` and the bare `crisismode` are the same command; one arm, so the
    // default invocation can never drift from the explicit one (it did
    // before: the `case undefined` arm was a copy of the `scan` arm).
    case undefined:
    case 'scan': {
      const { runScan } = await import('./commands/scan.js');
      const categoryStr = values.category;
      const result = await runScan({
        configPath,
        category: categoryStr ? categoryStr.split(',').map((s) => s.trim()) : undefined,
        verbose: values.verbose === true,
      });
      return severityExitCode(result.findings.map((f) => f.status));
    }

    case 'diagnose': {
      const { runDiagnose } = await import('./commands/diagnose.js');
      return runDiagnose({
        configPath,
        targetName: values.target ?? positionals[0],
      });
    }

    case 'recover': {
      // Recovery's outcome is "did the plan run", not "is the system
      // healthy" — and in its default dry-run mode nothing has been fixed
      // yet, so a health-derived code would report failure for a
      // successful preview. It stays OK unless the flow throws (the
      // catch below). Wiring the real execution outcome means changing
      // `runRecovery` in src/live.ts, out of scope here.
      const { runRecover } = await import('./commands/recover.js');
      await runRecover({
        configPath,
        targetName: values.target,
        execute: values.execute === true,
        healthOnly: values['health-only'] === true,
      });
      return ExitCode.OK;
    }

    case 'status': {
      const { runStatus } = await import('./commands/status.js');
      return runStatus();
    }

    case 'triage': {
      const { runTriageCommand } = await import('./commands/triage.js');
      return runTriageCommand({ configPath });
    }

    case 'down': {
      const { runDownCommand } = await import('./commands/down.js');
      // Positionals only. `down` used to receive the raw argv and re-parse
      // it privately because the old global `parseArgs({ strict: false })`
      // silently accepted any flag; args.ts now rejects unknown flags and
      // missing flag values for every command, so the private parser is gone.
      return runDownCommand(positionals, { configPath });
    }

    case 'readiness': {
      const { runReadinessCommand } = await import('./commands/readiness.js');
      return runReadinessCommand();
    }

    case 'init': {
      const { runInit } = await import('./commands/init.js');
      return runInit(positionals[0], {
        plugin: values.plugin,
        agent: values.agent,
      });
    }

    case 'demo': {
      const { runDemoCommand } = await import('./commands/demo.js');
      await runDemoCommand();
      return ExitCode.OK;
    }

    case 'webhook': {
      const { runWebhookCommand } = await import('./commands/webhook.js');
      await runWebhookCommand({
        configPath,
        execute: values.execute === true,
      });
      return ExitCode.OK;
    }

    case 'ask': {
      const question = positionals.join(' ');
      const { runAsk, runAskRepl } = await import('./commands/ask.js');
      if (!question) {
        await runAskRepl();
      } else {
        await runAsk(question);
      }
      return ExitCode.OK;
    }

    case 'watch': {
      // Validated BEFORE the command is imported or run: an unparseable
      // interval used to become NaN, survive watch.ts's `?? DEFAULT`, and
      // clamp setTimeout to 1ms — a continuous scan loop against degraded
      // infrastructure. See parseIntervalSeconds in args.ts.
      let intervalMs: number | undefined;
      if (values.interval !== undefined) {
        const seconds = parseIntervalSeconds(values.interval);
        if (typeof seconds !== 'number') return usageError(seconds.usageError);
        intervalMs = seconds * 1000;
      }
      const { runWatch } = await import('./commands/watch.js');
      await runWatch({
        configPath,
        targetName: values.target,
        intervalMs,
      });
      return ExitCode.OK;
    }

    case 'registry': {
      const sub = requireSubcommand('registry', positionals[0], ['list', 'install', 'search'] as const);
      if (sub === ExitCode.USAGE) return sub;
      const { runRegistry } = await import('./commands/registry.js');
      return runRegistry({
        subcommand: sub,
        args: positionals.slice(1),
        local: values.local === true,
        force: values.force === true,
        json: values.json === true,
      });
    }

    case 'playbook': {
      const sub = requireSubcommand('playbook', positionals[0], ['list', 'validate', 'dry-run'] as const);
      if (sub === ExitCode.USAGE) return sub;
      const { runPlaybook } = await import('./commands/playbook.js');
      return runPlaybook({
        subcommand: sub,
        args: positionals.slice(1),
        json: values.json === true,
      });
    }

    case 'agent': {
      const sub = requireSubcommand('agent', positionals[0], ['list', 'info'] as const);
      if (sub === ExitCode.USAGE) return sub;
      const { runAgent } = await import('./commands/agent.js');
      return runAgent({
        subcommand: sub,
        args: positionals.slice(1),
        json: values.json === true,
      });
    }

    case 'bundle': {
      const sub = requireSubcommand('bundle', positionals[0], ['ingest', 'respond', 'execute'] as const);
      if (sub === ExitCode.USAGE) return sub;
      const { runBundle } = await import('./commands/bundle.js');
      return runBundle({
        subcommand: sub,
        args: positionals.slice(1),
        output: values.output,
      });
    }

    case 'mcp': {
      const { startMcpServer } = await import('../mcp/server.js');
      await startMcpServer();
      return ExitCode.OK;
    }

    case 'completions': {
      const shell = positionals[0];
      if (shell === undefined) {
        console.error('crisismode completions: expected one of bash|zsh|fish');
        console.error('Usage: crisismode completions bash|zsh|fish');
        return ExitCode.USAGE;
      }
      const { runCompletions } = await import('./commands/completions.js');
      return runCompletions(shell);
    }

    // Unreachable while `parseCli` only ever yields an own key of
    // COMMAND_OPTIONS — but `command` arrives here through a runtime path
    // (a string from argv, narrowed by a cast), and TypeScript's
    // exhaustiveness check cannot protect a value the type system never
    // validated. Without this arm the switch fell through and `runCli`
    // resolved to `undefined`, which index.ts would assign to
    // `process.exitCode` — silently exiting 0 for an unroutable command.
    // Relying on the compiler here would be programming by coincidence.
    default: {
      console.error(`crisismode: unroutable command '${String(command)}'`);
      console.error('Run `crisismode --help` for the list of commands.');
      return ExitCode.USAGE;
    }
  }
}

/**
 * `runCli` with the top-level error boundary applied.
 *
 * USAGE (2) for the errors that describe how CrisisMode was invoked or
 * configured:
 * - `CliUsageError` — raised by a helper too deep to return a code.
 * - `ConfigNotFoundError` / `ConfigValidationError` — the config file is
 *   missing or does not parse.
 * - `CrisisModeError` (`errors.ts`) — the class exists precisely to carry a
 *   user-facing `suggestion` ("Run `crisismode init`...", "Set
 *   ANTHROPIC_API_KEY..."). Those were reaching INTERNAL, so `crisismode
 *   ask` with no API key exited 70 — claiming CrisisMode is broken when the
 *   user just needs to export a key.
 *
 * Anything else that escapes is a genuine bug in CrisisMode: INTERNAL (70),
 * which a script can tell apart from "your infrastructure is unhealthy" (1).
 */
export async function runCliSafely(argv: readonly string[]): Promise<ExitCode> {
  try {
    return await runCli(argv);
  } catch (err) {
    // Reporting must never be able to take the process down with it: stderr
    // can fail with EPIPE (`crisismode scan | head` closes the stream — a
    // normal thing an operator does), and formatError touches user data. If
    // this throws, the classification below still runs and the caller still
    // gets a code.
    try {
      console.error(formatError(err));
    } catch {
      // Nothing useful left to say, and nowhere to say it.
    }
    if (
      err instanceof CliUsageError
      || err instanceof ConfigNotFoundError
      || err instanceof ConfigValidationError
      || err instanceof CrisisModeError
    ) {
      return ExitCode.USAGE;
    }
    return ExitCode.INTERNAL;
  }
}
