// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { CheckExpression, Command } from '../types/common.js';
import type { CapabilityProviderDescriptor } from '../types/plugin.js';

/**
 * ExecutionBackend captures the minimal contract the framework needs to
 * execute a recovery plan regardless of the underlying system.
 */
export interface ExecutionBackend {
  executeCommand(command: Command): Promise<unknown>;
  evaluateCheck(check: CheckExpression): Promise<boolean>;
  listCapabilityProviders?(): CapabilityProviderDescriptor[];
  transition?(to: string): void;
  /**
   * Optional: discover the target system's version at runtime.
   * E.g. PostgreSQL: `SHOW server_version`, Redis: `INFO server`.
   * Used to auto-populate version when the config omits it.
   */
  discoverVersion?(): Promise<string>;
  close(): Promise<void>;
}
