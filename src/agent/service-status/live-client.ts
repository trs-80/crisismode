// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * ServiceStatusLiveClient — thin ExecutionBackend wrapper around the shared
 * Task 3 checker (`checkServices`). One instance checks exactly the
 * ServiceTarget(s) it was constructed with — in practice exactly one, since
 * `serviceTargetsFromConfig` (src/cli/service-targets.ts) gives each
 * configured service its own TargetConfig and createLiveRegistration creates
 * one agent instance per target.
 *
 * Offline handling is deliberately NOT here — the agent's OfflineGate decides
 * whether to probe at all, using triage's cached verdict, exactly as the
 * vector-store and llm-provider agents do. (checkServices() also consults its
 * own OfflineGate internally, but that path is only reachable if this client
 * is ever called directly while offline; the agent-level gate keeps that from
 * happening in practice.)
 */

import type { CheckExpression, Command } from '../../types/common.js';
import { compareCheckValue } from '../../framework/check-helpers.js';
import { checkServices } from '../../framework/service-status/checker.js';
import type { ServiceTarget } from '../../framework/service-status/checker.js';
import type { ServiceStatusReport } from '../../framework/service-status/types.js';
import type { ServiceStatusBackend } from './backend.js';
import { isUnreachableVerdict, worstVerdict } from './verdict-rank.js';

export class ServiceStatusLiveClient implements ServiceStatusBackend {
  constructor(private readonly targets: ServiceTarget[]) {}

  async queryServices(): Promise<ServiceStatusReport[]> {
    return checkServices(this.targets);
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'structured_command') {
      throw new Error(`Unsupported service-status command type: ${command.type}`);
    }
    if (command.operation === 'query_services') {
      return { reports: await this.queryServices() };
    }
    throw new Error(`Unsupported service-status operation: ${command.operation}`);
  }

  /** Same dispatch and fail-closed default as the simulator (Step 1). */
  async evaluateCheck(check: CheckExpression): Promise<boolean> {
    const statement = check.statement ?? '';
    const reports = await this.queryServices();

    if (statement === 'service_verdict') {
      return compareCheckValue(worstVerdict(reports), check.expect.operator, check.expect.value);
    }
    if (statement === 'unreachable_service_count') {
      const count = reports.filter((r) => isUnreachableVerdict(r.verdict)).length;
      return compareCheckValue(count, check.expect.operator, check.expect.value);
    }
    return false;
  }

  async close(): Promise<void> {}
}
