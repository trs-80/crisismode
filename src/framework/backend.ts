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
  close(): Promise<void>;
}
