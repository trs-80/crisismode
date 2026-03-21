// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * DiskBackend — interface for monitoring local disk/filesystem health.
 * Both the simulator and live client implement this.
 */

import type { ExecutionBackend } from '../../framework/backend.js';

/** Usage statistics for a single mounted filesystem */
export interface FilesystemUsage {
  mountPoint: string;
  device: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usagePercent: number;
  totalInodes: number;
  usedInodes: number;
  inodeUsagePercent: number;
}

/** A large file or directory entry consuming disk space */
export interface LargeEntry {
  path: string;
  sizeBytes: number;
  type: 'file' | 'directory';
  modifiedAt: string;
}

/** Log rotation status for a directory */
export interface LogRotationStatus {
  path: string;
  totalSizeBytes: number;
  fileCount: number;
  oldestFile: string | null;
  newestFile: string | null;
  compressedCount: number;
  uncompressedCount: number;
}

export interface DiskBackend extends ExecutionBackend {
  /** Get usage statistics for all mounted filesystems */
  getDiskUsage(): Promise<FilesystemUsage[]>;

  /** Find the largest entries in a directory (top N) */
  getLargestEntries(path: string, limit?: number): Promise<LargeEntry[]>;

  /** Check log rotation health for a log directory */
  getLogRotationStatus(path: string): Promise<LogRotationStatus>;

  /** Simulator-only state transition hook */
  transition?(to: string): void;
}
