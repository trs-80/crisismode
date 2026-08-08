// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * ServiceStatusBackend — the read-only contract both the simulator and the
 * live client implement. There are no mutating methods: this agent diagnoses
 * a third-party dependency's status, it never changes one.
 */

import type { ExecutionBackend } from '../../framework/backend.js';
import type { ServiceStatusReport } from '../../framework/service-status/types.js';

export { SERVICE_STATUS_CHECK_IDS } from './check-ids.js';
export type { ServiceStatusCheckId } from './check-ids.js';

export interface ServiceStatusBackend extends ExecutionBackend {
  /**
   * One report per configured service target — in practice a single-element
   * array, since one agent instance checks exactly one configured service
   * (see registration.ts). A provider-level failure is reported as an honest
   * fact inside the report (status_unavailable, a failed probe, ...); this
   * never throws for a network or status-page problem.
   */
  queryServices(): Promise<ServiceStatusReport[]>;

  /** Simulator-only state transitions. */
  transition?(to: string): void;
}
