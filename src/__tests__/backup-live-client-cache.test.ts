// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Regression coverage for N1 (re-review of the fail-closed sweep,
 * .superpowers/sdd/fail-closed-sweep/final-review-report.md): the
 * `lastVerification` cache added to BackupLiveClient for I3 was poisoned by
 * the backup plan's own diagnosis step. Plan step-002 is a `diagnosis_action`
 * whose command is `{ operation: 'verify_backups', parameters: {} }` — no
 * `configs`. `executeCommand()` reads `command.parameters?.configs ?? []`
 * and calls `verifyAll([])`, which returns `{ providers: [], ... }` and (at
 * the time of the I3 fix) cached that empty report unconditionally.
 * `evaluateCheck('all_verifications_passed')` then treated the cached empty
 * report as a hit (`if (!report)` is false for a truthy empty object) and
 * skipped the real file_directory fallback, so the check was always `false`
 * on live infrastructure — even with healthy backups — which pages
 * on-call/DBA/eng-lead at critical urgency via the plan's elseStep.
 *
 * This drives the REAL sequence the plan produces (unlike the existing
 * live-client-evaluate-check.test.ts stubs, which inject `lastVerification`
 * directly and never exercise the write path): a real temp directory with
 * one valid gzip backup, a real executeCommand('verify_backups', {}) call,
 * then evaluateCheck('all_verifications_passed').
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { BackupLiveClient } from '../agent/backup/live-client.js';
import type { CheckExpression } from '../types/common.js';

function allVerificationsPassedCheck(
  operator: CheckExpression['expect']['operator'] = 'eq',
  value: unknown = true,
): CheckExpression {
  return { type: 'sql', statement: 'all_verifications_passed', expect: { operator, value } };
}

describe('BackupLiveClient lastVerification cache — not poisoned by an empty verifyAll() run', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'backup-live-cache-'));
    // A real, valid gzip archive so checkIntegrity()'s `gzip -t` passes.
    await writeFile(join(dir, 'backup-2026-01-01.sql.gz'), gzipSync(Buffer.from('SELECT 1;')));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is true on a fresh client with no prior verifyAll() call', async () => {
    const client = new BackupLiveClient({ locations: [dir] });
    expect(await client.evaluateCheck(allVerificationsPassedCheck())).toBe(true);
  });

  it("is not poisoned by the plan's own step-002 diagnosis action (verify_backups with no configs)", async () => {
    const client = new BackupLiveClient({ locations: [dir] });

    // Mirrors src/agent/backup/agent.ts step-002 and
    // BackupLiveClient.executeCommand()'s verify_backups handling: a
    // diagnosis_action command that carries no `configs` parameter, so
    // executeCommand calls verifyAll([]).
    await client.executeCommand({ type: 'api_call', operation: 'verify_backups', parameters: {} });

    expect(await client.evaluateCheck(allVerificationsPassedCheck())).toBe(true);
  });

  it('a genuine verifyAll() result is not overwritten by a later empty-config run (reviewer row C)', async () => {
    const client = new BackupLiveClient({ locations: [dir] });

    // A real verification against the configured location runs first and
    // finds everything healthy...
    await client.verifyAll([{ kind: 'file_directory', locations: [dir], source: 'default' }]);
    expect(await client.evaluateCheck(allVerificationsPassedCheck())).toBe(true);

    // ...then the plan's diagnosis step runs verify_backups with no
    // configs. This must not flip a genuine "healthy" result to "false".
    await client.executeCommand({ type: 'api_call', operation: 'verify_backups', parameters: {} });

    expect(await client.evaluateCheck(allVerificationsPassedCheck())).toBe(true);
  });
});
