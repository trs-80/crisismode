// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { ExecutionLogEntry } from '../types/forensic-record.js';

/**
 * Forensic log entry emitted by graph nodes.
 * Matches the existing ForensicRecorder entry shape.
 */
export type ForensicLogEntry = ExecutionLogEntry;
