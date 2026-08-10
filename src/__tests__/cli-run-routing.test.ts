// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * `src/cli/run.ts` — routing and exit-code mapping.
 *
 * This dispatch used to live in `src/cli/index.ts`, which `vitest.config.ts`
 * excludes from coverage, so none of it was ever measured. Moving it here
 * made ~350 lines of untested code *visible* rather than adding it; these
 * tests close that gap instead of extending the exclusion list (the same
 * exclusion is what hides `live.ts` at 9% function coverage and `webhook.ts`
 * at 0%, and repeating it here knowingly would be worse than the original).
 *
 * Every command handler is mocked: this file asserts that argv reaches the
 * right handler with the right options and that the handler's outcome
 * becomes the right exit code. What the handlers actually do is covered by
 * their own suites.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExitCode, CliUsageError } from '../cli/exit-codes.js';
import { ConfigNotFoundError, ConfigValidationError } from '../config/loader.js';
import type { HealthStatus } from '../types/health.js';

const runScan = vi.fn(async () => ({ findings: [] as Array<{ status: HealthStatus }> }));
const runDiagnose = vi.fn(async (): Promise<ExitCode> => ExitCode.OK);
const runRecover = vi.fn(async () => undefined);
const runStatus = vi.fn(async (): Promise<ExitCode> => ExitCode.OK);
const runTriageCommand = vi.fn(async (): Promise<ExitCode> => ExitCode.OK);
const runDownCommand = vi.fn(async (): Promise<ExitCode> => ExitCode.OK);
const runReadinessCommand = vi.fn(async (): Promise<ExitCode> => ExitCode.OK);
const runInit = vi.fn(async (): Promise<ExitCode> => ExitCode.OK);
const runDemoCommand = vi.fn(async () => undefined);
const runWebhookCommand = vi.fn(async () => undefined);
const runAsk = vi.fn(async () => undefined);
const runAskRepl = vi.fn(async () => undefined);
const runWatch = vi.fn(async () => undefined);
const runRegistry = vi.fn(async (): Promise<ExitCode> => ExitCode.OK);
const runPlaybook = vi.fn(async (): Promise<ExitCode> => ExitCode.OK);
const runAgent = vi.fn(async (): Promise<ExitCode> => ExitCode.OK);
const runBundle = vi.fn(async (): Promise<ExitCode> => ExitCode.OK);
const runCompletions = vi.fn(async (): Promise<ExitCode> => ExitCode.OK);
const startMcpServer = vi.fn(async () => undefined);

vi.mock('../cli/commands/scan.js', () => ({ runScan }));
vi.mock('../cli/commands/diagnose.js', () => ({ runDiagnose }));
vi.mock('../cli/commands/recover.js', () => ({ runRecover }));
vi.mock('../cli/commands/status.js', () => ({ runStatus }));
vi.mock('../cli/commands/triage.js', () => ({ runTriageCommand }));
vi.mock('../cli/commands/down.js', () => ({ runDownCommand }));
vi.mock('../cli/commands/readiness.js', () => ({ runReadinessCommand }));
vi.mock('../cli/commands/init.js', () => ({ runInit }));
vi.mock('../cli/commands/demo.js', () => ({ runDemoCommand }));
vi.mock('../cli/commands/webhook.js', () => ({ runWebhookCommand }));
vi.mock('../cli/commands/ask.js', () => ({ runAsk, runAskRepl }));
vi.mock('../cli/commands/watch.js', () => ({ runWatch }));
vi.mock('../cli/commands/registry.js', () => ({ runRegistry }));
vi.mock('../cli/commands/playbook.js', () => ({ runPlaybook }));
vi.mock('../cli/commands/agent.js', () => ({ runAgent }));
vi.mock('../cli/commands/bundle.js', () => ({ runBundle }));
vi.mock('../cli/commands/completions.js', () => ({ runCompletions }));
vi.mock('../mcp/server.js', () => ({ startMcpServer }));

const { runCli, runCliSafely } = await import('../cli/run.js');

const ALL_HANDLERS: Record<string, ReturnType<typeof vi.fn>> = {
  runScan, runDiagnose, runRecover, runStatus, runTriageCommand, runDownCommand,
  runReadinessCommand, runInit, runDemoCommand, runWebhookCommand, runAsk,
  runAskRepl, runWatch, runRegistry, runPlaybook, runAgent, runBundle,
  runCompletions, startMcpServer,
};

beforeEach(() => {
  for (const fn of Object.values(ALL_HANDLERS)) fn.mockClear();
  runScan.mockResolvedValue({ findings: [] });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('runCli — every command reaches its own handler', () => {
  it.each([
    // [argv, handler name that must be called]
    [[], 'runScan'],
    [['scan'], 'runScan'],
    [['diagnose'], 'runDiagnose'],
    [['recover'], 'runRecover'],
    [['status'], 'runStatus'],
    [['triage'], 'runTriageCommand'],
    [['down'], 'runDownCommand'],
    [['readiness'], 'runReadinessCommand'],
    [['init'], 'runInit'],
    [['demo'], 'runDemoCommand'],
    [['webhook'], 'runWebhookCommand'],
    [['ask', 'why', 'is', 'pg', 'slow'], 'runAsk'],
    [['ask'], 'runAskRepl'],
    [['watch'], 'runWatch'],
    [['registry', 'list'], 'runRegistry'],
    [['playbook', 'list'], 'runPlaybook'],
    [['agent', 'list'], 'runAgent'],
    [['bundle', 'ingest', 'x.json'], 'runBundle'],
    [['mcp'], 'startMcpServer'],
    [['completions', 'bash'], 'runCompletions'],
    // C8b: the same routing must hold with the flag first.
    [['--json', 'diagnose'], 'runDiagnose'],
    [['--verbose', 'completions', 'bash'], 'runCompletions'],
    [['--no-color', 'status'], 'runStatus'],
    [['--terse', 'triage'], 'runTriageCommand'],
  ])('%j routes to %s and nothing else', async (argv, expected) => {
    await runCli(argv as string[]);
    expect(ALL_HANDLERS[expected]!, `${expected} should have been called`).toHaveBeenCalledTimes(1);
    for (const [name, fn] of Object.entries(ALL_HANDLERS)) {
      // runAsk/runAskRepl share a module and a command; only assert the
      // sibling that should NOT have run.
      if (name === expected) continue;
      expect(fn, `${name} should not have been called`).not.toHaveBeenCalled();
    }
  });
});

describe('runCli — options reach the handler', () => {
  it('threads --config and --category into scan', async () => {
    await runCli(['scan', '--config', 'a.yaml', '--category', 'postgresql, redis']);
    expect(runScan).toHaveBeenCalledWith(expect.objectContaining({
      configPath: 'a.yaml',
      category: ['postgresql', 'redis'],
    }));
  });

  it('passes a diagnose target positionally or via --target', async () => {
    await runCli(['diagnose', 'PLUG-001']);
    expect(runDiagnose).toHaveBeenCalledWith(expect.objectContaining({ targetName: 'PLUG-001' }));
    runDiagnose.mockClear();
    await runCli(['diagnose', '--target', 'main-pg']);
    expect(runDiagnose).toHaveBeenCalledWith(expect.objectContaining({ targetName: 'main-pg' }));
  });

  it('passes --execute and --health-only to recover', async () => {
    await runCli(['recover', '--execute', '--health-only']);
    expect(runRecover).toHaveBeenCalledWith(expect.objectContaining({ execute: true, healthOnly: true }));
  });

  it('converts --interval seconds to milliseconds for watch', async () => {
    await runCli(['watch', '--interval', '60']);
    expect(runWatch).toHaveBeenCalledWith(expect.objectContaining({ intervalMs: 60_000 }));
  });

  it('omits intervalMs entirely when --interval is not given', async () => {
    await runCli(['watch']);
    expect(runWatch).toHaveBeenCalledWith(expect.objectContaining({ intervalMs: undefined }));
  });
});

/**
 * `watch --interval` was a self-inflicted DoS: a non-numeric value became
 * NaN, survived `watch.ts`'s `?? DEFAULT_INTERVAL_MS` (`??` only catches
 * null/undefined), and `setTimeout(fn, NaN)` clamped to 1ms — a continuous
 * scan loop against already-degraded infrastructure. Inherited from
 * `src/cli/index.ts:260` on main, fixed here because this is where the
 * CLI's argument-validation contract now lives.
 */
describe('runCli — watch --interval is validated before it can reach a timer', () => {
  it.each([
    [['watch', '--interval', 'abc']],
    [['watch', '--interval', '1m']],
    [['watch', '--interval', '60s']],
    [['watch', '--interval', '0']],
    // The inline form: `--interval -5` is caught only by accident (parseArgs
    // reads `-5` as an unknown short option); `--interval=-5` bypassed that
    // entirely and printed "every -5s" while hot-looping.
    [['watch', '--interval=-5']],
    [['watch', '--interval=0']],
    [['watch', '--interval=abc']],
    [['watch', '--interval=1.5']],
  ])('%j exits USAGE and never starts the watch loop', async (argv) => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runCli(argv as string[]);
    const message = err.mock.calls.map((c) => c.join(' ')).join('\n');
    err.mockRestore();
    expect(code).toBe(ExitCode.USAGE);
    // The critical assertion: the command must not run at all.
    expect(runWatch).not.toHaveBeenCalled();
    expect(message).toContain('--interval');
  });

  it.each([
    [['watch', '--interval', '1'], 1_000],
    [['watch', '--interval', '30'], 30_000],
    [['watch', '--interval=45'], 45_000],
  ])('%j still works, as %i ms', async (argv, expected) => {
    expect(await runCli(argv as string[])).toBe(ExitCode.OK);
    expect(runWatch).toHaveBeenCalledWith(expect.objectContaining({ intervalMs: expected }));
  });
});

describe('runCliSafely — a CrisisModeError is the user\'s problem, not a crash', () => {
  it('maps CrisisModeError to USAGE, not INTERNAL', async () => {
    // `noConfig()` / `missingEnvVar()` (src/cli/errors.ts) are deliberate,
    // user-actionable errors — the class carries a `suggestion` field. They
    // were falling through to INTERNAL (70, EX_SOFTWARE), which claims
    // CrisisMode is broken when the user just needs to export a key.
    // Verified at the real surface: `crisismode ask` with no
    // ANTHROPIC_API_KEY exited 70.
    const { missingEnvVar } = await import('../cli/errors.js');
    runScan.mockRejectedValueOnce(missingEnvVar('ANTHROPIC_API_KEY', 'required for AI diagnosis'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runCliSafely(['scan']);
    err.mockRestore();
    expect(code).toBe(ExitCode.USAGE);
    expect(code).not.toBe(ExitCode.INTERNAL);
  });

  it('hands down only positionals — never raw flags (its private re-parser is gone)', async () => {
    await runCli(['down', 'stripe', 'github', '--json']);
    expect(runDownCommand).toHaveBeenCalledWith(['stripe', 'github'], expect.anything());
  });

  it('splits a subcommand off the positionals for registry/playbook/agent/bundle', async () => {
    await runCli(['registry', 'search', 'redis', 'cache']);
    expect(runRegistry).toHaveBeenCalledWith(expect.objectContaining({
      subcommand: 'search', args: ['redis', 'cache'],
    }));
    await runCli(['bundle', 'ingest', 'b.json']);
    expect(runBundle).toHaveBeenCalledWith(expect.objectContaining({
      subcommand: 'ingest', args: ['b.json'],
    }));
  });
});

describe('runCli — scan exit code is derived from the findings', () => {
  it.each([
    // Zero findings: nothing was asked for, not "nothing observable".
    [[], ExitCode.OK],
    [['healthy'], ExitCode.OK],
    // One unmeasurable signal must not fail a deploy.
    [['healthy', 'unknown'], ExitCode.OK],
    [['unhealthy'], ExitCode.UNHEALTHY],
    [['healthy', 'recovering'], ExitCode.UNHEALTHY],
    // Nothing could be determined at all.
    [['unknown'], ExitCode.INDETERMINATE],
    [['unknown', 'unknown', 'unknown'], ExitCode.INDETERMINATE],
    // A definite bad answer beats "could not check".
    [['unknown', 'unhealthy'], ExitCode.UNHEALTHY],
  ])('findings %j -> exit %i', async (statuses, expected) => {
    runScan.mockResolvedValue({ findings: (statuses as HealthStatus[]).map((status) => ({ status })) });
    expect(await runCli(['scan'])).toBe(expected);
  });

  it('the bare `crisismode` invocation reports INDETERMINATE identically', async () => {
    runScan.mockResolvedValue({ findings: [{ status: 'unknown' }, { status: 'unknown' }] });
    expect(await runCli([])).toBe(ExitCode.INDETERMINATE);
  });

  it('applies the same derivation to the bare `crisismode` invocation', async () => {
    runScan.mockResolvedValue({ findings: [{ status: 'unhealthy' }] });
    expect(await runCli([])).toBe(ExitCode.UNHEALTHY);
  });
});

describe('runCli — a handler\'s returned code is passed through unchanged', () => {
  it.each([
    [ExitCode.OK],
    [ExitCode.UNHEALTHY],
    [ExitCode.USAGE],
  ])('diagnose returning %i exits %i', async (code) => {
    runDiagnose.mockResolvedValue(code);
    expect(await runCli(['diagnose'])).toBe(code);
  });

  it.each([
    ['status', runStatus, ['status']],
    ['triage', runTriageCommand, ['triage']],
    ['down', runDownCommand, ['down']],
    ['readiness', runReadinessCommand, ['readiness']],
    ['agent', runAgent, ['agent', 'list']],
    ['playbook', runPlaybook, ['playbook', 'list']],
    ['registry', runRegistry, ['registry', 'list']],
    ['bundle', runBundle, ['bundle', 'ingest', 'x']],
    ['completions', runCompletions, ['completions', 'bash']],
    ['init', runInit, ['init']],
  ] as const)('%s returning UNHEALTHY exits 1', async (_name, handler, argv) => {
    handler.mockResolvedValue(ExitCode.UNHEALTHY);
    expect(await runCli(argv as unknown as string[])).toBe(ExitCode.UNHEALTHY);
    handler.mockResolvedValue(ExitCode.OK);
  });

  it.each([
    [['recover'], 'recover'],
    [['demo'], 'demo'],
    [['webhook'], 'webhook'],
    [['watch'], 'watch'],
    [['ask'], 'ask'],
    [['mcp'], 'mcp'],
  ])('%j returns OK — these commands have no health verdict to report', async (argv) => {
    expect(await runCli(argv as string[])).toBe(ExitCode.OK);
  });
});

describe('runCli — usage errors', () => {
  it.each([
    [['notacommand'], 'notacommand'],
    [['scan', '--notaflag'], '--notaflag'],
    [['--json', 'scan', '--notaflag'], '--notaflag'],
    [['--config'], '--config'],
  ])('%j exits USAGE and names %s', async (argv, token) => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runCli(argv as string[]);
    const message = err.mock.calls.map((c) => c.join(' ')).join('\n');
    err.mockRestore();
    expect(code).toBe(ExitCode.USAGE);
    expect(message).toContain(token);
  });

  it('suggests the nearest command for a near miss', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runCli(['diagnos']);
    const message = err.mock.calls.map((c) => c.join(' ')).join('\n');
    err.mockRestore();
    expect(code).toBe(ExitCode.USAGE);
    expect(message).toContain("Did you mean 'diagnose'?");
  });

  it.each([
    [['registry'], 'list|install|search'],
    [['playbook'], 'list|validate|dry-run'],
    [['agent'], 'list|info'],
    [['bundle'], 'ingest|respond|execute'],
    [['completions'], 'bash|zsh|fish'],
  ])('%j (missing required subcommand) exits USAGE and lists the options', async (argv, options) => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runCli(argv as string[]);
    const message = err.mock.calls.map((c) => c.join(' ')).join('\n');
    err.mockRestore();
    expect(code).toBe(ExitCode.USAGE);
    expect(message).toContain(options);
    // The handler must never run with a bogus subcommand.
    expect(ALL_HANDLERS.runRegistry).not.toHaveBeenCalled();
    expect(ALL_HANDLERS.runPlaybook).not.toHaveBeenCalled();
    expect(ALL_HANDLERS.runAgent).not.toHaveBeenCalled();
    expect(ALL_HANDLERS.runBundle).not.toHaveBeenCalled();
    expect(ALL_HANDLERS.runCompletions).not.toHaveBeenCalled();
  });

  it.each([
    [['registry', 'bogus']],
    [['playbook', 'bogus']],
    [['agent', 'bogus']],
    [['bundle', 'bogus']],
  ])('%j (unrecognized subcommand) exits USAGE', async (argv) => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runCli(argv as string[]);
    err.mockRestore();
    expect(code).toBe(ExitCode.USAGE);
  });
});

describe('runCli — help and version', () => {
  it('prints help and exits OK for --help', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runCli(['--help'])).toBe(ExitCode.OK);
    expect(log.mock.calls.join('\n')).toContain('Usage:');
    log.mockRestore();
    expect(runScan).not.toHaveBeenCalled();
  });

  it.each([
    ['--interval'],
    ['--output'],
  ])('documents %s in the Options block', async (flag) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runCli(['--help']);
    const help = log.mock.calls.join('\n');
    log.mockRestore();
    expect(help).toContain(flag);
  });

  it('states the --interval contract in --help, so the operator does not learn it from an error', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runCli(['--help']);
    const help = log.mock.calls.join('\n');
    log.mockRestore();
    // Whole seconds, positive, suffixes rejected.
    expect(help).toMatch(/--interval <seconds>/);
    expect(help).toMatch(/whole number|positive integer/i);
  });

  it('documents the exit codes in the help text', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runCli(['--help']);
    const help = log.mock.calls.join('\n');
    log.mockRestore();
    expect(help).toContain('Exit codes:');
    expect(help).toContain('70');
  });

  it('treats the bare `help` command like --help', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runCli(['help'])).toBe(ExitCode.OK);
    expect(log.mock.calls.join('\n')).toContain('Usage:');
    log.mockRestore();
  });

  it('prints the version and exits OK', async () => {
    const previous = process.env.__CRISISMODE_VERSION;
    process.env.__CRISISMODE_VERSION = '9.9.9-test';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runCli(['--version'])).toBe(ExitCode.OK);
    expect(log).toHaveBeenCalledWith('9.9.9-test');
    log.mockRestore();
    if (previous === undefined) delete process.env.__CRISISMODE_VERSION;
    else process.env.__CRISISMODE_VERSION = previous;
  });

  it('falls back to package.json when the version was not inlined at bundle time', async () => {
    const previous = process.env.__CRISISMODE_VERSION;
    delete process.env.__CRISISMODE_VERSION;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runCli(['-v'])).toBe(ExitCode.OK);
    const printed = log.mock.calls.map((c) => String(c[0])).join('');
    log.mockRestore();
    if (previous !== undefined) process.env.__CRISISMODE_VERSION = previous;
    expect(printed).toMatch(/^\d+\.\d+\.\d+|unknown/);
  });
});

describe('runCliSafely — the error boundary', () => {
  it('maps CliUsageError to USAGE', async () => {
    runScan.mockRejectedValueOnce(new CliUsageError('--plugin requires a plugin name'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runCliSafely(['scan']);
    err.mockRestore();
    expect(code).toBe(ExitCode.USAGE);
  });

  it.each([
    ['ConfigNotFoundError', () => new ConfigNotFoundError('/nope.yaml')],
    ['ConfigValidationError', () => new ConfigValidationError('bad config')],
  ])('maps %s to USAGE — a broken config is the user calling this wrong', async (_name, make) => {
    runScan.mockRejectedValueOnce(make());
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runCliSafely(['scan']);
    err.mockRestore();
    expect(code).toBe(ExitCode.USAGE);
  });

  it('maps an unexpected throw to INTERNAL, not UNHEALTHY', async () => {
    runScan.mockRejectedValueOnce(new TypeError('cannot read properties of undefined'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runCliSafely(['scan']);
    const message = err.mock.calls.map((c) => c.join(' ')).join('\n');
    err.mockRestore();
    // 70, not 1: a script must be able to tell "this tool is broken" from
    // "your infrastructure is unhealthy".
    expect(code).toBe(ExitCode.INTERNAL);
    expect(code).not.toBe(ExitCode.UNHEALTHY);
    expect(message).toContain('cannot read properties of undefined');
  });

  /**
   * The boundary must be total. `runCliSafely`'s own catch calls
   * `console.error(formatError(err))`; if that throws — stderr closed by
   * `crisismode scan | head`, an EPIPE, a formatError fault — the returned
   * promise rejected, Node reported an unhandled rejection, and
   * `process.exitCode` was never assigned.
   */
  it('still resolves to INTERNAL when reporting the error itself throws', async () => {
    runScan.mockRejectedValueOnce(new TypeError('original failure'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('EPIPE: broken pipe');
    });
    let code: number | undefined;
    let rejected = false;
    try {
      code = await runCliSafely(['scan']);
    } catch {
      rejected = true;
    }
    err.mockRestore();
    expect(rejected).toBe(false);
    expect(code).toBe(ExitCode.INTERNAL);
  });

  it('passes a successful run through untouched', async () => {
    runScan.mockResolvedValue({ findings: [{ status: 'healthy' }] });
    expect(await runCliSafely(['scan'])).toBe(ExitCode.OK);
  });
});

describe('runCli never writes process.exitCode — index.ts is the only place that does', () => {
  it.each([
    [['scan']],
    [['notacommand']],
    [['down']],
  ])('%j leaves process.exitCode untouched', async (argv) => {
    const before = process.exitCode;
    runScan.mockResolvedValue({ findings: [{ status: 'unhealthy' }] });
    runDownCommand.mockResolvedValue(ExitCode.UNHEALTHY);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runCli(argv as string[]);
    err.mockRestore();
    expect(process.exitCode).toBe(before);
    runDownCommand.mockResolvedValue(ExitCode.OK);
  });
});
