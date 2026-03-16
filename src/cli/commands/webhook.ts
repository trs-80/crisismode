// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * `crisismode webhook` — start AlertManager webhook receiver.
 */

import { startWebhookServer } from '../../webhook.js';

export interface WebhookOptions {
  configPath?: string;
  execute: boolean;
}

export async function runWebhookCommand(opts: WebhookOptions): Promise<void> {
  await startWebhookServer({
    configPath: opts.configPath,
    execute: opts.execute,
  });
}
