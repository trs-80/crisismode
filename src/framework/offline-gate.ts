// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * The single seam between the recovery agents and the triage module.
 *
 * When triage has already localised a failure to this machine or its network,
 * a downstream check would only report "the target is unreachable" — which is
 * true but useless and reads as "the target is down". This gate lets a caller
 * skip those checks and repeat triage's explanation instead.
 *
 * If PR 2's triage exports change shape, this file is the only one to update.
 *
 * Deliberate non-use: triage also populates the cached NetworkProfile
 * singleton, so `getNetworkProfile()?.internet.status` is a second offline
 * signal — and the only one available under `crisismode diagnose`, which runs
 * probeNetwork but not triage. It is not consulted here on purpose: it cannot
 * tell "this machine" from "this network", so it would degrade the very
 * distinction this gate exists to report. Without a triage verdict the checks
 * run and report their own per-check "could not be reached" unknowns, which is
 * already honest.
 */

import { getTriageReport } from './triage.js';

export interface ObserverOffline {
  /** Which side triage localised the failure to. */
  verdict: 'local' | 'network';
  /** Triage's plain-language explanation, repeated verbatim in findings. */
  explanation: string;
}

export type OfflineGate = () => Promise<ObserverOffline | null>;

/**
 * Reads the triage report already computed in this process (scan runs triage
 * as step 0, which caches it).
 *
 * Never calls runTriage(): that runs live probes for several seconds, and
 * callers such as scan invoke assessHealth once per target, so probing here
 * would multiply triage's cost by the number of targets.
 *
 * Two non-deferral cases that are correct, not oversights:
 * - `null` — triage has not run in this process (the normal case for
 *   `crisismode diagnose`). No information is not evidence of being offline.
 * - `mixed` — triage could not localise the failure. Deferring to a verdict
 *   that says "unclear" would be a guess dressed up as an explanation.
 */
export const defaultOfflineGate: OfflineGate = async () => {
  try {
    const report = getTriageReport();
    if (!report) return null;
    if (report.verdict !== 'local' && report.verdict !== 'network') return null;
    return { verdict: report.verdict, explanation: report.explanation };
  } catch {
    // A gate failure must never break the checks it is only meant to skip.
    return null;
  }
};
