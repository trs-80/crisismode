// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Every command's "outcome -> returned ExitCode" mapping.
 *
 * These commands used to end in `process.exit(1)` (or, for the health
 * commands, in nothing at all). The codes are now returned, which makes them
 * assertable without spawning a process — and makes the disagreement they
 * used to have with `down`'s 2-for-usage impossible to reintroduce silently.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExitCode } from '../cli/exit-codes.js';
import { configure } from '../cli/output.js';
import { CrisisModeError } from '../cli/errors.js';
import { CliUsageError } from '../cli/exit-codes.js';
import type { CheckRegistryEntry } from '../config/check-registry.js';
import type { ReadinessReport } from '../readiness/types.js';
import type * as CheckRegistryModule from '../config/check-registry.js';
import type * as IngestModule from '../framework/evidence-bundle-ingest.js';
import type * as RespondModule from '../framework/evidence-bundle-respond.js';
import type * as BundleToPlanModule from '../framework/bundle-to-plan.js';
import type * as LoaderModule from '../config/loader.js';

// vi.hoisted: `vi.mock` is hoisted above plain module-scope `const`
// declarations, so a factory closing over one only works while the factory
// happens to be evaluated lazily. vi.hoisted runs before static imports are
// evaluated, which is the documented way to make these safely available.
const {
  fetchRegistry, installCheck, getInstalledVersion, runReadiness,
  ingestEvidenceBundle, respondToEvidenceBundle, adapterResponseToPlan,
  detectServices, loadConfigWithDetection,
} = vi.hoisted(() => ({
  fetchRegistry: vi.fn(),
  installCheck: vi.fn(),
  getInstalledVersion: vi.fn(() => null),
  runReadiness: vi.fn(),
  ingestEvidenceBundle: vi.fn(),
  respondToEvidenceBundle: vi.fn(),
  adapterResponseToPlan: vi.fn(),
  detectServices: vi.fn(),
  loadConfigWithDetection: vi.fn(),
}));

vi.mock('../config/check-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof CheckRegistryModule>();
  return { ...actual, fetchRegistry };
});
vi.mock('../framework/check-installer.js', () => ({ installCheck, getInstalledVersion }));

vi.mock('../readiness/run.js', () => ({ runReadiness }));

// bundle's ingest/respond reach a live Claude call; what is under test here
// is bundle.ts's outcome -> ExitCode mapping, not the diagnosis itself
// (covered by evidence-bundle-ingest.test.ts). The JSON.parse and
// missing-path failures below happen before these are reached, so the
// UNHEALTHY/USAGE arms still exercise the real code path.
vi.mock('../framework/evidence-bundle-ingest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof IngestModule>();
  return { ...actual, ingestEvidenceBundle };
});
vi.mock('../framework/evidence-bundle-respond.js', async (importOriginal) => {
  const actual = await importOriginal<typeof RespondModule>();
  return { ...actual, respondToEvidenceBundle };
});
vi.mock('../framework/bundle-to-plan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof BundleToPlanModule>();
  return { ...actual, adapterResponseToPlan };
});

vi.mock('../cli/detect.js', () => ({ detectServices }));

vi.mock('../config/loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof LoaderModule>();
  return { ...actual, loadConfigWithDetection };
});

const { runPlaybook } = await import('../cli/commands/playbook.js');
const { runBundle } = await import('../cli/commands/bundle.js');
const { runRegistry } = await import('../cli/commands/registry.js');
const { runStatus } = await import('../cli/commands/status.js');
const { runAgent } = await import('../cli/commands/agent.js');
const { runReadinessCommand } = await import('../cli/commands/readiness.js');

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const VALID_PLAYBOOK = join(REPO_ROOT, 'playbooks/examples/pg-replication-lag.md');

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cm-exit-'));
  configure({ json: false, noColor: true, mode: 'human' });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.clearAllMocks();
  getInstalledVersion.mockReturnValue(null);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ── playbook ──

describe('runPlaybook', () => {
  it.each([
    ['list', [], ExitCode.OK],
    ['validate', [VALID_PLAYBOOK], ExitCode.OK],
    ['dry-run', [VALID_PLAYBOOK], ExitCode.OK],
  ] as const)('%s on a valid input returns OK', async (subcommand, args, expected) => {
    expect(await runPlaybook({ subcommand, args: [...args] })).toBe(expected);
  });

  it.each([
    // A missing required <path> is a usage error, matching `down`'s 2.
    ['validate', []],
    ['dry-run', []],
    // A path that cannot be read is the user naming a file that isn't there.
    ['validate', ['/nonexistent/playbook.md']],
    ['dry-run', ['/nonexistent/playbook.md']],
  ] as const)('%s %j returns USAGE', async (subcommand, args) => {
    expect(await runPlaybook({ subcommand, args: [...args] })).toBe(ExitCode.USAGE);
  });

  it('an unrecognized subcommand returns USAGE', async () => {
    expect(await runPlaybook({ subcommand: 'bogus', args: [] })).toBe(ExitCode.USAGE);
  });

  it.each([
    ['validate'],
    ['dry-run'],
  ])('%s returns UNHEALTHY for a playbook that does not compile — the work failed, the call was fine', async (subcommand) => {
    const bad = join(tmp, 'broken.md');
    writeFileSync(bad, '# no frontmatter, not a playbook\n', 'utf-8');
    expect(await runPlaybook({ subcommand, args: [bad] })).toBe(ExitCode.UNHEALTHY);
  });

  it('dry-run --json emits a JSON error record for a compile failure, like validate does', async () => {
    const bad = join(tmp, 'broken.md');
    writeFileSync(bad, '# not a playbook\n', 'utf-8');
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runPlaybook({ subcommand: 'dry-run', args: [bad], json: true });
    err.mockRestore();
    expect(code).toBe(ExitCode.UNHEALTHY);
    // Machine consumers got nothing at all from this path before.
    expect(logs.join('')).not.toBe('');
    expect(JSON.parse(logs.join('')) as { error: string }).toMatchObject({
      error: expect.any(String) as unknown as string,
    });
  });

  it('reports the compile failure as JSON when --json is set, still exiting UNHEALTHY', async () => {
    const bad = join(tmp, 'broken.md');
    writeFileSync(bad, '# not a playbook\n', 'utf-8');
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    const code = await runPlaybook({ subcommand: 'validate', args: [bad], json: true });
    expect(code).toBe(ExitCode.UNHEALTHY);
    expect(JSON.parse(logs.join('')) as { valid: boolean }).toMatchObject({ valid: false });
  });

  it('validate --json on a valid playbook returns OK and reports valid: true', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    const code = await runPlaybook({ subcommand: 'validate', args: [VALID_PLAYBOOK], json: true });
    expect(code).toBe(ExitCode.OK);
    expect(JSON.parse(logs.join('')) as { valid: boolean }).toMatchObject({ valid: true });
  });

  it('list --json returns OK', async () => {
    expect(await runPlaybook({ subcommand: 'list', args: [], json: true })).toBe(ExitCode.OK);
  });

  it('list returns OK when playbooks are actually discovered (human table path)', async () => {
    const previous = process.env.CRISISMODE_PLAYBOOK_PATH;
    process.env.CRISISMODE_PLAYBOOK_PATH = join(REPO_ROOT, 'playbooks/examples');
    try {
      expect(await runPlaybook({ subcommand: 'list', args: [] })).toBe(ExitCode.OK);
    } finally {
      if (previous === undefined) delete process.env.CRISISMODE_PLAYBOOK_PATH;
      else process.env.CRISISMODE_PLAYBOOK_PATH = previous;
    }
  });

  it('dry-run --json on a valid playbook returns OK', async () => {
    expect(await runPlaybook({ subcommand: 'dry-run', args: [VALID_PLAYBOOK], json: true })).toBe(ExitCode.OK);
  });

  /**
   * A playbook that parses cleanly but compiles to a plan the safety
   * validator rejects (an elevated-risk step with no `capture:` state
   * preservation) is a *result*, not a usage error: the call was correct and
   * the answer is "this is not safe to run" — UNHEALTHY, the same code an
   * unhealthy scan returns.
   */
  const UNSAFE_PLAYBOOK = [
    '---',
    'name: "unsafe-playbook"',
    'version: "1.0.0"',
    'description: "Compiles, but fails plan safety validation"',
    'agent: pg-replication',
    'severity: elevated',
    'triggers:',
    '  - alert: something',
    '---',
    '',
    '# Unsafe',
    '',
    '### 1. Restart the primary',
    '- type: system_action',
    '- description: Restart without capturing state first',
    '- riskLevel: high',
    '',
    '```bash',
    'systemctl restart postgresql',
    '```',
    '',
  ].join('\n');

  it.each(['validate', 'dry-run'] as const)(
    '%s returns UNHEALTHY for a playbook that compiles but fails safety validation',
    async (subcommand) => {
      const path = join(tmp, 'unsafe.md');
      writeFileSync(path, UNSAFE_PLAYBOOK, 'utf-8');
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const code = await runPlaybook({ subcommand, args: [path] });
      err.mockRestore();
      expect(code).toBe(ExitCode.UNHEALTHY);
    },
  );

  it.each(['validate', 'dry-run'] as const)(
    '%s --json reports the same UNHEALTHY code for an unsafe playbook',
    async (subcommand) => {
      const path = join(tmp, 'unsafe.md');
      writeFileSync(path, UNSAFE_PLAYBOOK, 'utf-8');
      expect(await runPlaybook({ subcommand, args: [path], json: true })).toBe(ExitCode.UNHEALTHY);
    },
  );
});

// ── bundle ──

/** Minimal well-formed AdapterRequest v1 — enough for ingest/respond/execute. */
function minimalBundle(): unknown {
  return {
    schema_version: 'incident-generator.agent-adapter-request/v1',
    request_id: 'req-exit-codes',
    benchmark_set_id: 'exit-code-suite',
    case_id: 'exit-codes',
    created_at: '2026-08-09T00:00:00Z',
    incident_session_id: '20260809-exit-codes',
    collection_mode: 'fixture',
    input_mode: 'redacted_evidence_bundle',
    skill_domains: ['service'],
    visibility: {
      internal_evidence_roles_visible: false,
      expected_hypotheses_visible: false,
      forbidden_hypotheses_visible: false,
      redaction_required: true,
    },
    evidence_items: [
      {
        evidence_id: 'service.errors',
        adapter_id: 'service.logs',
        title: 'Checkout errors',
        source_kind: 'log',
        content_type: 'log_excerpt',
        content: { format: 'log_excerpt', body: 'checkout-api returned 503s', redaction_summary: 'ids removed' },
        time_window: { start: '2026-08-09T00:00:00Z', end: '2026-08-09T00:04:00Z' },
        source_ref: 'test',
        redacted: true,
        untrusted: false,
        metadata: {},
      },
    ],
  };
}

describe('runBundle', () => {
  beforeEach(() => {
    ingestEvidenceBundle.mockResolvedValue({ summary: 'ok', findings: [] });
    respondToEvidenceBundle.mockResolvedValue({ response: { state: 'answered', hypotheses: [] } });
    adapterResponseToPlan.mockReturnValue({ plan: { steps: [] }, rejected: [], warnings: [] });
  });

  it.each(['ingest', 'respond', 'execute'] as const)(
    '%s on a well-formed bundle returns OK',
    async (subcommand) => {
      const path = join(tmp, 'bundle.json');
      writeFileSync(path, JSON.stringify(minimalBundle()), 'utf-8');
      expect(await runBundle({ subcommand, args: [path] })).toBe(ExitCode.OK);
    },
  );

  it('writes to --output when given, still returning OK', async () => {
    const path = join(tmp, 'bundle.json');
    const out = join(tmp, 'result.json');
    writeFileSync(path, JSON.stringify(minimalBundle()), 'utf-8');
    expect(await runBundle({ subcommand: 'ingest', args: [path], output: out })).toBe(ExitCode.OK);
    expect(JSON.parse(readFileSync(out, 'utf-8')) as unknown).toBeTruthy();
  });

  it.each(['ingest', 'respond', 'execute'] as const)(
    '%s with no path returns USAGE (not the old exit 1)',
    async (subcommand) => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const code = await runBundle({ subcommand, args: [] });
      err.mockRestore();
      expect(code).toBe(ExitCode.USAGE);
    },
  );

  it.each(['ingest', 'respond', 'execute'] as const)(
    '%s on a nonexistent path returns USAGE, matching `playbook validate` and the documented matrix',
    async (subcommand) => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const code = await runBundle({ subcommand, args: [join(tmp, 'does-not-exist.json')] });
      err.mockRestore();
      // A path that isn't there is the user naming a file that doesn't
      // exist — the same class as `playbook validate /nope.md` (USAGE), not
      // a bundle that loaded and then failed to process (UNHEALTHY).
      expect(code).toBe(ExitCode.USAGE);
    },
  );

  it('a path that is a directory, not a file, returns USAGE', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runBundle({ subcommand: 'ingest', args: [tmp] });
    err.mockRestore();
    expect(code).toBe(ExitCode.USAGE);
  });

  it.each(['ingest', 'respond', 'execute'] as const)(
    '%s on a file that is not JSON returns UNHEALTHY — the work failed, the call was fine',
    async (subcommand) => {
      const path = join(tmp, 'garbage.json');
      writeFileSync(path, 'this is not json', 'utf-8');
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const code = await runBundle({ subcommand, args: [path] });
      err.mockRestore();
      expect(code).toBe(ExitCode.UNHEALTHY);
    },
  );

  it('an unrecognized subcommand returns USAGE', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runBundle({ subcommand: 'bogus', args: [] });
    err.mockRestore();
    expect(code).toBe(ExitCode.USAGE);
  });

  /**
   * Every unknown error used to become UNHEALTHY, so a genuine tool bug
   * exited 1 — telling a script the *bundle* was bad when CrisisMode was
   * broken. That defeats the UNHEALTHY/INTERNAL distinction this PR exists
   * to create.
   *
   * The split is by JS error type, because it is the only reliable signal
   * available: the bundle framework throws untyped plain `Error`s for
   * validation (evidence-bundle-ingest.ts:45-84), which are bad *input*, not
   * a tool fault. A TypeError/RangeError/ReferenceError can only mean a
   * programming mistake.
   */
  it.each([
    ['TypeError', () => new TypeError("Cannot read properties of undefined (reading 'x')")],
    ['RangeError', () => new RangeError('Maximum call stack size exceeded')],
    ['ReferenceError', () => new ReferenceError('foo is not defined')],
  ])('a %s from the bundle framework is rethrown so the boundary reports INTERNAL', async (_name, make) => {
    const path = join(tmp, 'bundle.json');
    writeFileSync(path, JSON.stringify(minimalBundle()), 'utf-8');
    const thrown = make();
    ingestEvidenceBundle.mockRejectedValue(thrown);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The concrete class, not the broad `Error` base — every one of these is
    // an Error, so `toBeInstanceOf(Error)` would pass even if the rethrow
    // logic misclassified them.
    await expect(runBundle({ subcommand: 'ingest', args: [path] }))
      .rejects.toBeInstanceOf(thrown.constructor as ErrorConstructor);
    await expect(runBundle({ subcommand: 'ingest', args: [path] }))
      .rejects.not.toBeInstanceOf(CliUsageError);
    err.mockRestore();
  });

  it('a plain Error (bundle validation) stays UNHEALTHY — bad input is not a tool bug', async () => {
    const path = join(tmp, 'bundle.json');
    writeFileSync(path, JSON.stringify(minimalBundle()), 'utf-8');
    ingestEvidenceBundle.mockRejectedValueOnce(new Error('evidence_items must be a non-empty array'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runBundle({ subcommand: 'ingest', args: [path] });
    err.mockRestore();
    expect(code).toBe(ExitCode.UNHEALTHY);
  });

  it('a SyntaxError from JSON.parse stays UNHEALTHY — the user\'s file is malformed', async () => {
    const path = join(tmp, 'garbage.json');
    writeFileSync(path, '{not json', 'utf-8');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runBundle({ subcommand: 'ingest', args: [path] });
    err.mockRestore();
    // 70 would claim CrisisMode is broken; the user handed it a bad file.
    expect(code).toBe(ExitCode.UNHEALTHY);
    expect(code).not.toBe(ExitCode.INTERNAL);
  });

  /**
   * `bundle respond -` is a documented workflow (pipe a bundle in, pipe the
   * AdapterResponse out to the judge). The stdin read loop had no coverage.
   */
  it('reads the bundle from stdin when the path is `-`', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'stdin')!;
    const piped = Readable.from([JSON.stringify(minimalBundle())]) as unknown as typeof process.stdin;
    (piped as unknown as { isTTY: boolean }).isTTY = false;
    Object.defineProperty(process, 'stdin', { value: piped, configurable: true });
    try {
      expect(await runBundle({ subcommand: 'ingest', args: ['-'] })).toBe(ExitCode.OK);
      expect(ingestEvidenceBundle).toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'stdin', descriptor);
    }
  });

  it('returns UNHEALTHY when stdin carries something that is not JSON', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'stdin')!;
    const piped = Readable.from(['not json at all']) as unknown as typeof process.stdin;
    (piped as unknown as { isTTY: boolean }).isTTY = false;
    Object.defineProperty(process, 'stdin', { value: piped, configurable: true });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Data arrived and was unusable: the work failed, the call was fine.
      expect(await runBundle({ subcommand: 'ingest', args: ['-'] })).toBe(ExitCode.UNHEALTHY);
    } finally {
      err.mockRestore();
      Object.defineProperty(process, 'stdin', descriptor);
    }
  });

  it('`-` with a TTY on stdin returns USAGE — there is nothing to read', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runBundle({ subcommand: 'ingest', args: ['-'] });
    const message = err.mock.calls.map((c) => c.join(' ')).join('\n');
    err.mockRestore();
    if (descriptor) Object.defineProperty(process.stdin, 'isTTY', descriptor);
    else delete (process.stdin as unknown as Record<string, unknown>).isTTY;
    expect(code).toBe(ExitCode.USAGE);
    expect(message).toContain('stdin');
  });
});

// ── agent ──

describe('runAgent', () => {
  it('list returns OK', async () => {
    expect(await runAgent({ subcommand: 'list', args: [] })).toBe(ExitCode.OK);
  });

  it('info on a real built-in agent returns OK', async () => {
    expect(await runAgent({ subcommand: 'info', args: ['postgresql-replication-recovery'] })).toBe(ExitCode.OK);
  });

  it('info --json on a real built-in agent returns OK', async () => {
    expect(await runAgent({ subcommand: 'info', args: ['postgresql-replication-recovery'], json: true })).toBe(ExitCode.OK);
  });

  it.each([
    // Missing required <name>, unrecognized subcommand, and a name that
    // resolves to nothing — all "you called this wrong", all 2. The last
    // two used to be `process.exit(1)`.
    [{ subcommand: 'info', args: [] }],
    [{ subcommand: 'bogus', args: [] }],
    [{ subcommand: 'info', args: ['no-such-agent'] }],
  ])('%j returns USAGE', async (opts) => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runAgent(opts as { subcommand: string; args: string[] });
    err.mockRestore();
    expect(code).toBe(ExitCode.USAGE);
  });
});

// ── registry ──

const ENTRY: CheckRegistryEntry = {
  name: 'check-certificate-expiry',
  version: '1.0.0',
  description: 'Checks TLS certificate expiry',
  targetKinds: ['tls'],
  url: 'https://example.invalid/check.tar.gz',
  sha256: 'deadbeef',
} as unknown as CheckRegistryEntry;

describe('runRegistry', () => {
  beforeEach(() => {
    fetchRegistry.mockResolvedValue({ checks: [ENTRY], updatedAt: '2026-08-09T00:00:00Z' });
  });

  it.each([
    ['list', []],
    ['search', ['certificate']],
    ['search', ['nothing-matches-this']],
  ] as const)('%s %j returns OK', async (subcommand, args) => {
    expect(await runRegistry({ subcommand, args: [...args] })).toBe(ExitCode.OK);
  });

  it.each([
    ['list', []],
    ['search', ['certificate']],
  ] as const)('%s --json returns OK', async (subcommand, args) => {
    expect(await runRegistry({ subcommand, args: [...args], json: true })).toBe(ExitCode.OK);
  });

  it('search with no query returns USAGE', async () => {
    expect(await runRegistry({ subcommand: 'search', args: [] })).toBe(ExitCode.USAGE);
  });

  it('install with no name returns USAGE', async () => {
    expect(await runRegistry({ subcommand: 'install', args: [] })).toBe(ExitCode.USAGE);
  });

  it.each([
    // Named a check that is not in the registry: a wrong invocation, not a
    // failed install. Both the fuzzy-suggestion and no-suggestion paths.
    [['check-certificate-expiryy']],
    [['zzzzz-nothing-like-this']],
  ])('install %j (unknown name) returns USAGE', async (args) => {
    expect(await runRegistry({ subcommand: 'install', args: [...args] })).toBe(ExitCode.USAGE);
  });

  it('a successful install returns OK', async () => {
    installCheck.mockResolvedValue({ name: ENTRY.name, installedTo: '/tmp/checks/x' });
    expect(await runRegistry({ subcommand: 'install', args: [ENTRY.name] })).toBe(ExitCode.OK);
    expect(installCheck).toHaveBeenCalled();
  });

  it('a failed install returns UNHEALTHY — the name resolved, the work did not', async () => {
    installCheck.mockRejectedValue(new Error('checksum mismatch'));
    expect(await runRegistry({ subcommand: 'install', args: [ENTRY.name] })).toBe(ExitCode.UNHEALTHY);
  });

  it('list --json reports installed state', async () => {
    getInstalledVersion.mockReturnValue('1.0.0' as unknown as null);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    const code = await runRegistry({ subcommand: 'list', args: [], json: true });
    expect(code).toBe(ExitCode.OK);
    // The exit code alone would pass even if the installed state were never
    // rendered — which is the whole point of this test.
    const entries = JSON.parse(logs.join('')) as Array<{ name: string; installed: boolean; installedVersion: string }>;
    expect(entries[0]).toMatchObject({
      name: ENTRY.name,
      installed: true,
      installedVersion: '1.0.0',
    });
  });
});

// ── status ──

describe('runStatus', () => {
  it('returns OK when every configured target is listening', async () => {
    loadConfigWithDetection.mockReturnValue({
      config: { targets: [{ name: 'pg', kind: 'postgresql', primary: { host: 'h', port: 5432 } }] },
      source: 'file',
    });
    detectServices.mockResolvedValue([{ kind: 'postgresql', host: 'h', port: 5432, detected: true }]);
    expect(await runStatus()).toBe(ExitCode.OK);
  });

  it('returns UNHEALTHY when a configured target is not listening', async () => {
    loadConfigWithDetection.mockReturnValue({
      config: { targets: [{ name: 'pg', kind: 'postgresql', primary: { host: 'h', port: 5432 } }] },
      source: 'file',
    });
    detectServices.mockResolvedValue([{ kind: 'postgresql', host: 'h', port: 5432, detected: false }]);
    // C8a: `crisismode status && deploy` used to deploy onto a dead target.
    expect(await runStatus()).toBe(ExitCode.UNHEALTHY);
  });

  it('returns UNHEALTHY when only one of several targets is down', async () => {
    loadConfigWithDetection.mockReturnValue({
      config: {
        targets: [
          { name: 'pg', kind: 'postgresql', primary: { host: 'h', port: 5432 } },
          { name: 'redis', kind: 'redis', primary: { host: 'h', port: 6379 } },
        ],
      },
      source: 'file',
    });
    detectServices
      .mockResolvedValueOnce([{ kind: 'postgresql', host: 'h', port: 5432, detected: true }])
      .mockResolvedValueOnce([{ kind: 'redis', host: 'h', port: 6379, detected: false }]);
    expect(await runStatus()).toBe(ExitCode.UNHEALTHY);
  });

  /**
   * `status` deliberately has no INDETERMINATE case: its data is a TCP probe
   * that either connected or did not. A failed connect is a definite "not
   * listening", not "could not determine" — there is no unknown state to
   * report, so the command stays 0/1.
   */
  it('never returns INDETERMINATE — a failed probe is a definite answer', async () => {
    loadConfigWithDetection.mockReturnValue({
      config: { targets: [{ name: 'pg', kind: 'postgresql', primary: { host: 'h', port: 5432 } }] },
      source: 'file',
    });
    detectServices.mockResolvedValue([{ kind: 'postgresql', host: 'h', port: 5432, detected: false }]);
    const code = await runStatus();
    expect(code).toBe(ExitCode.UNHEALTHY);
    expect(code).not.toBe(ExitCode.INDETERMINATE);
  });

  it('returns OK from raw detection when there is no config', async () => {
    loadConfigWithDetection.mockReturnValue({ config: null, source: 'none' });
    detectServices.mockResolvedValue([{ kind: 'redis', host: 'localhost', port: 6379, detected: true }]);
    expect(await runStatus()).toBe(ExitCode.OK);
  });

  /**
   * A generic `rejects.toThrow()` passes for the wrong reason — any failure
   * anywhere in runStatus satisfies it. Assert the concrete class, and the
   * exit code it actually maps to at the boundary.
   *
   * Note this is `CrisisModeError` (src/cli/errors.ts), NOT `CliUsageError`:
   * `noConfig()` predates this PR. It carries a user-facing `suggestion`, so
   * runCliSafely classifies it as USAGE.
   */
  it('rejects with a CrisisModeError when there is no config and nothing detected', async () => {
    loadConfigWithDetection.mockReturnValue({ config: null, source: 'none' });
    detectServices.mockResolvedValue([]);
    await expect(runStatus()).rejects.toBeInstanceOf(CrisisModeError);
    await expect(runStatus()).rejects.toThrow(/No configuration found/);
  });
});

// ── readiness ──

function report(verdict: ReadinessReport['verdict']): ReadinessReport {
  return {
    verdict,
    score: verdict === 'ready' ? 100 : 40,
    evaluated: 3,
    unknown: 0,
    findings: [],
  } as unknown as ReadinessReport;
}

describe('runReadinessCommand', () => {
  it.each([
    ['ready', ExitCode.OK],
    ['unknown', ExitCode.INDETERMINATE],
    ['at-risk', ExitCode.UNHEALTHY],
    ['not-ready', ExitCode.UNHEALTHY],
  ] as const)('verdict %s -> exit %i (human mode)', async (verdict, expected) => {
    configure({ json: false, noColor: true, mode: 'human' });
    runReadiness.mockResolvedValue(report(verdict));
    expect(await runReadinessCommand()).toBe(expected);
  });

  it.each([
    ['ready', ExitCode.OK],
    ['not-ready', ExitCode.UNHEALTHY],
  ] as const)('verdict %s -> exit %i (--json takes the same code, not a different path)', async (verdict, expected) => {
    configure({ json: true, noColor: true });
    runReadiness.mockResolvedValue(report(verdict));
    expect(await runReadinessCommand()).toBe(expected);
  });
});
