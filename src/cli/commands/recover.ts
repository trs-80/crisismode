// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * `crisismode recover` — full recovery flow.
 * Wraps the existing live.ts logic in a callable function.
 * Default: dry-run. Use --execute for real mutations.
 */

import { runRecovery } from '../../live.js';

export interface RecoverOptions {
  configPath?: string | undefined;
  targetName?: string | undefined;
  execute: boolean;
  healthOnly: boolean;
}

export async function runRecover(opts: RecoverOptions): Promise<void> {
  await runRecovery({
    ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
    ...(opts.targetName !== undefined ? { targetName: opts.targetName } : {}),
    execute: opts.execute,
    healthOnly: opts.healthOnly,
  });
}
