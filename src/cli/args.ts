// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Argument parsing for the `crisismode` CLI — one parser, one place.
 *
 * Two defects lived in the old inline parse in index.ts:
 *
 * 1. The subcommand was `args[0] && !args[0].startsWith('-') ? args[0] :
 *    undefined` — it gave up entirely the moment argv[0] was a flag, instead
 *    of scanning for the first non-flag positional. `crisismode --json
 *    diagnose` therefore had no subcommand.
 * 2. `parseArgs({ strict: false })` never rejected the orphaned `diagnose`
 *    token (it landed in `positionals` and was discarded) and never rejected
 *    an unknown flag either, so the router fell through to `runScan` and the
 *    user silently got a different command.
 *
 * The fix: find the subcommand as the first positional that is neither a
 * flag nor a flag's value, then re-parse the remainder with `strict: true`
 * scoped to that subcommand's own option set. An unrecognized token is a
 * usage error naming the token (with the nearest valid command when there is
 * an obvious one), not a silent fallback.
 *
 * `down` used to carry a private re-parser (`parseDownArgs`) to work around
 * defect 2 at one call site. It is deleted: the missing/flag-like value
 * check it introduced for `--config` now applies to every value-taking flag
 * of every command, here.
 */

import { parseArgs } from 'node:util';

interface OptionSpec {
  type: 'string' | 'boolean';
  short?: string;
  default?: boolean;
}

/**
 * Every option the CLI knows about. Which subset a given command accepts is
 * `COMMAND_OPTIONS` below; this table only says how each one is spelled.
 */
const OPTION_SPECS = {
  config: { type: 'string' },
  target: { type: 'string' },
  category: { type: 'string' },
  plugin: { type: 'string' },
  /** Deprecated alias for --plugin (init only); --plugin wins if both are given. */
  agent: { type: 'string' },
  interval: { type: 'string' },
  output: { type: 'string' },
  execute: { type: 'boolean', default: false },
  'health-only': { type: 'boolean', default: false },
  local: { type: 'boolean', default: false },
  force: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  'no-color': { type: 'boolean', default: false },
  verbose: { type: 'boolean', default: false },
  terse: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
} as const satisfies Record<string, OptionSpec>;

export type OptionName = keyof typeof OPTION_SPECS;

/** Output/meta flags every command accepts. */
const COMMON_OPTIONS = ['json', 'no-color', 'verbose', 'terse', 'help', 'version'] as const;

/**
 * Per-command option sets, mirroring the per-command flag lists the shell
 * completions already advertise (`commands/completions.ts`). A flag a
 * command would silently ignore is a usage error here, for the same reason
 * an unknown flag is: the user asked for something that will not happen.
 */
const COMMAND_OPTIONS = {
  scan: ['config', 'category'],
  diagnose: ['config', 'target'],
  recover: ['config', 'target', 'execute', 'health-only'],
  status: [],
  triage: ['config'],
  down: ['config'],
  readiness: [],
  init: ['plugin', 'agent'],
  demo: [],
  webhook: ['config', 'execute'],
  // No `config`: runAsk/runAskRepl never load a config file (they only need
  // ANTHROPIC_API_KEY), so accepting --config would silently ignore it.
  // Matches completions.ts, which advertises no flags for `ask`.
  ask: [],
  watch: ['config', 'target', 'interval'],
  registry: ['local', 'force'],
  playbook: [],
  agent: [],
  bundle: ['output'],
  mcp: [],
  completions: [],
  help: [],
} as const satisfies Record<string, readonly OptionName[]>;

export type CommandName = keyof typeof COMMAND_OPTIONS;

/** Every command name, for usage messages and near-miss suggestions. */
export const COMMAND_NAMES: readonly string[] = Object.keys(COMMAND_OPTIONS);

/** No subcommand means the zero-config health scan, so it inherits scan's options. */
const DEFAULT_COMMAND: CommandName = 'scan';

/** Long options that consume the following token as their value. */
const VALUE_FLAGS: ReadonlySet<string> = new Set(
  Object.entries(OPTION_SPECS).filter(([, s]) => s.type === 'string').map(([name]) => name),
);

export interface CliValues {
  config?: string | undefined;
  target?: string | undefined;
  category?: string | undefined;
  plugin?: string | undefined;
  agent?: string | undefined;
  interval?: string | undefined;
  output?: string | undefined;
  execute?: boolean;
  'health-only'?: boolean;
  local?: boolean;
  force?: boolean;
  json?: boolean;
  'no-color'?: boolean;
  verbose?: boolean;
  terse?: boolean;
  help?: boolean;
  version?: boolean;
}

export type ParseResult =
  | { kind: 'command'; command: CommandName | undefined; values: CliValues; positionals: string[] }
  | { kind: 'usage'; message: string };

function usage(message: string): ParseResult {
  return { kind: 'usage', message };
}

/**
 * Locate the subcommand — the first token that is neither a flag nor the
 * value of a value-taking flag — and, in the same pass, reject a
 * value-taking flag whose value is missing or is itself a flag.
 *
 * That second check is what `down`'s deleted private parser did for
 * `--config` alone: `crisismode down --config` used to proceed with no path
 * and `--config --terse` used to look for a config file literally named
 * `--terse`. Node's `parseArgs` does not catch either (`strict: false`
 * stored `true`; `strict: true` happily swallows the next flag as a value),
 * so it stays an explicit pre-pass.
 */
function scanTokens(args: readonly string[]): { subcommandIndex: number | undefined } | { usageError: string } {
  let subcommandIndex: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    // `--` ends option processing; everything after it is a literal positional.
    if (token === '--') break;
    if (token.startsWith('--')) {
      const name = token.slice(2).split('=', 1)[0]!;
      if (token.includes('=')) {
        // `--config=` (nothing after the `=`) is a missing value, same as
        // `--config` with nothing after it. Skipping the check for any token
        // containing `=` let it through as the empty string, so the config
        // loader received an empty path instead of a usage error.
        if (VALUE_FLAGS.has(name) && token.slice(name.length + 3) === '') {
          return { usageError: `option '--${name}' requires a value` };
        }
        continue; // value is inline
      }
      if (VALUE_FLAGS.has(name)) {
        const value = args[i + 1];
        if (value === undefined || value.startsWith('-')) {
          return { usageError: `option '--${name}' requires a value` };
        }
        i++; // consume the value so it is never mistaken for the subcommand
      }
      continue;
    }
    // A lone '-' is stdin (e.g. `bundle ingest -`), never a command name.
    if (token.startsWith('-') && token.length > 1) continue;
    if (token !== '-' && subcommandIndex === undefined) subcommandIndex = i;
  }
  return { subcommandIndex };
}

/**
 * `--interval <seconds>` — a plain positive integer, or a usage error.
 *
 * The old expression was `parseInt(intervalStr, 10) * 1000`, and it made
 * `crisismode watch` a self-inflicted DoS:
 *
 * - `--interval abc` → `parseInt` gives `NaN` → `NaN * 1000` is `NaN`.
 *   `watch.ts`'s `opts.intervalMs ?? DEFAULT_INTERVAL_MS` does *not* catch
 *   that: `??` only falls back on `null`/`undefined`. `setTimeout(fn, NaN)`
 *   clamps to 1ms, so the watch loop ran continuously against infrastructure
 *   that is by definition already degraded — while printing "every NaNs" to
 *   the operator.
 * - `--interval 1m` → `parseInt('1m')` is `1` → a one-second loop. The
 *   operator asked for a minute and got 60x the load.
 * - `--interval 60s` happened to work, by the same accident. So the natural
 *   inputs a stressed operator types either work by luck or silently produce
 *   a hot loop.
 * - `--interval=0` / `--interval=-5` also clamp to a 1ms timer.
 *
 * Unit suffixes are deliberately **rejected** rather than parsed: the flag is
 * documented as seconds, and accepting `60s` while `1m` means one second is
 * the trap itself. The error message says what to type instead.
 *
 * This is a pre-existing bug — `src/cli/index.ts:260` on main has the
 * identical expression — fixed here because this is the module that now owns
 * whether an argument is well-formed.
 */
export function parseIntervalSeconds(raw: string): number | { usageError: string } {
  const reject = {
    usageError:
      `'--interval' expects a whole number of seconds greater than 0 (e.g. --interval 30). ` +
      `Got '${raw}'. Unit suffixes like '30s' or '1m' are not accepted.`,
  };
  // Strictly digits only: no whitespace, sign, decimal point, exponent, hex
  // or suffix. Every one of those forms is something parseInt silently
  // mangled into a number that then reached a timer.
  if (!/^\d+$/.test(raw)) return reject;
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return reject;
  return seconds;
}

function levenshtein(a: string, b: string): number {
  const rows: number[][] = [Array.from({ length: b.length + 1 }, (_, j) => j)];
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        rows[i - 1]![j]! + 1,
        row[j - 1]! + 1,
        rows[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    rows.push(row);
  }
  return rows[a.length]![b.length]!;
}

/** The closest command name within a small edit distance, or undefined. */
export function nearestCommand(token: string): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const name of COMMAND_NAMES) {
    const distance = levenshtein(token.toLowerCase(), name);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = name;
    }
  }
  return bestDistance <= 3 ? best : undefined;
}

function optionsFor(command: CommandName): Record<string, OptionSpec> {
  const allowed = [...COMMON_OPTIONS, ...COMMAND_OPTIONS[command]];
  const options: Record<string, OptionSpec> = {};
  for (const name of allowed) options[name] = OPTION_SPECS[name];
  return options;
}

/**
 * Parse a full argv tail (`process.argv.slice(2)`) into a command, its
 * values and its positionals — or into a usage error naming the offending
 * token. Pure: no I/O, no process mutation, so the contract is unit-testable.
 */
export function parseCli(argv: readonly string[]): ParseResult {
  const scanned = scanTokens(argv);
  if ('usageError' in scanned) return usage(scanned.usageError);

  const { subcommandIndex } = scanned;
  const token = subcommandIndex !== undefined ? argv[subcommandIndex]! : undefined;

  let command: CommandName | undefined;
  if (token !== undefined) {
    // Object.hasOwn, NOT `in`: `in` also matches inherited Object.prototype
    // keys, so `crisismode toString` / `constructor` / `__proto__` were
    // accepted as commands and cast to CommandName. `optionsFor` then spread
    // `COMMAND_OPTIONS['toString']` — a function — and the operator got
    // "COMMAND_OPTIONS[command] is not iterable" instead of an unknown-command
    // message. Own-property-only means they take the branch below and get a
    // suggestion like any other typo.
    if (!Object.hasOwn(COMMAND_OPTIONS, token)) {
      const suggestion = nearestCommand(token);
      return usage(
        `unknown command '${token}'` +
        (suggestion !== undefined ? `. Did you mean '${suggestion}'?` : '') +
        `\nRun \`crisismode --help\` for the list of commands.`,
      );
    }
    command = token as CommandName;
  }

  const rest = subcommandIndex !== undefined
    ? [...argv.slice(0, subcommandIndex), ...argv.slice(subcommandIndex + 1)]
    : [...argv];

  try {
    const { values, positionals } = parseArgs({
      args: rest,
      options: optionsFor(command ?? DEFAULT_COMMAND),
      allowPositionals: true,
      strict: true,
    });
    return {
      kind: 'command',
      command,
      values: values as CliValues,
      positionals,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return usage(
      `${detail}` +
      `\nRun \`crisismode ${command ?? ''} --help\`.`.replace('  ', ' '),
    );
  }
}
