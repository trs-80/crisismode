// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

// Moved to src/framework/offline-gate.ts — framework is where the seam
// between agents and triage belongs. Re-exported here so existing imports
// (this agent's constructor default, its tests) keep working unchanged.
export { defaultOfflineGate, type ObserverOffline, type OfflineGate } from '../../framework/offline-gate.js';
