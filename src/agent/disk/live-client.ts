// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * DiskLiveClient — monitors real local filesystem usage using node:fs.
 *
 * Uses statfs() for block/inode stats and readdir for large file detection.
 * Zero external dependencies.
 */

import { statfs, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  DiskBackend,
  FilesystemUsage,
  LargeEntry,
  LogRotationStatus,
} from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';
import { compareCheckValue } from '../../framework/check-helpers.js';

export interface DiskLiveConfig {
  /** Mount points to monitor (default: ['/', '/var/log', '/boot', '/tmp']) */
  mountPoints?: string[];
  /** Maximum depth for large file scanning (default: 2) */
  scanDepth?: number;
}

const DEFAULT_MOUNT_POINTS = ['/', '/var/log', '/boot', '/tmp'];

export class DiskLiveClient implements DiskBackend {
  private config: DiskLiveConfig;

  constructor(config?: DiskLiveConfig) {
    this.config = config ?? {};
  }

  async getDiskUsage(): Promise<FilesystemUsage[]> {
    const mountPoints = this.config.mountPoints ?? DEFAULT_MOUNT_POINTS;
    const results: FilesystemUsage[] = [];
    const seenDevices = new Set<string>();

    for (const mp of mountPoints) {
      try {
        const stats = await statfs(mp);

        // Block usage — use bavail (not bfree) to match df behavior and account for reserved blocks
        const blockSize = stats.bsize;
        const totalBytes = stats.blocks * blockSize;
        const availableBytes = stats.bavail * blockSize;
        const usedBytes = (stats.blocks - stats.bavail) * blockSize;
        const usagePercent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;

        // Inode usage — Node.js statfs exposes ffree (no favail equivalent)
        const totalInodes = stats.files;
        const freeInodes = stats.ffree;
        const usedInodes = totalInodes - freeInodes;
        const inodeUsagePercent = totalInodes > 0 ? (usedInodes / totalInodes) * 100 : 0;

        // Deduplicate by device (same underlying filesystem mounted at multiple points)
        const deviceKey = `${totalBytes}-${stats.files}`;
        if (seenDevices.has(deviceKey) && mp !== '/') continue;
        seenDevices.add(deviceKey);

        results.push({
          mountPoint: mp,
          device: 'unknown',
          totalBytes,
          usedBytes,
          availableBytes,
          usagePercent: Math.round(usagePercent * 10) / 10,
          totalInodes,
          usedInodes,
          inodeUsagePercent: Math.round(inodeUsagePercent * 10) / 10,
        });
      } catch {
        // Mount point doesn't exist or isn't accessible — skip
        continue;
      }
    }

    return results;
  }

  async getLargestEntries(path: string, limit: number = 10): Promise<LargeEntry[]> {
    const entries: LargeEntry[] = [];
    const maxDepth = this.config.scanDepth ?? 2;

    await this.scanDirectory(path, entries, 0, maxDepth);

    entries.sort((a, b) => b.sizeBytes - a.sizeBytes);
    return entries.slice(0, limit);
  }

  async getLogRotationStatus(path: string): Promise<LogRotationStatus> {
    let totalSizeBytes = 0;
    let fileCount = 0;
    let compressedCount = 0;
    let uncompressedCount = 0;
    let oldestTime = Infinity;
    let newestTime = 0;
    let oldestFile: string | null = null;
    let newestFile: string | null = null;

    try {
      const entries = await readdir(path, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isFile()) continue;

        try {
          const fullPath = join(path, entry.name);
          const fileStat = await stat(fullPath);

          totalSizeBytes += fileStat.size;
          fileCount++;

          if (entry.name.endsWith('.gz') || entry.name.endsWith('.bz2') || entry.name.endsWith('.xz') || entry.name.endsWith('.zst')) {
            compressedCount++;
          } else {
            uncompressedCount++;
          }

          const mtime = fileStat.mtime.getTime();
          if (mtime < oldestTime) {
            oldestTime = mtime;
            oldestFile = new Date(mtime).toISOString();
          }
          if (mtime > newestTime) {
            newestTime = mtime;
            newestFile = new Date(mtime).toISOString();
          }
        } catch {
          continue;
        }
      }
    } catch {
      // Directory not accessible
    }

    return {
      path,
      totalSizeBytes,
      fileCount,
      oldestFile,
      newestFile,
      compressedCount,
      uncompressedCount,
    };
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'api_call') {
      throw new Error(`Unsupported disk live client command type: ${command.type}`);
    }

    switch (command.operation) {
      case 'check_disk_usage':
        return { filesystems: await this.getDiskUsage() };
      case 'find_large_entries':
        return {
          entries: await this.getLargestEntries(
            String(command.parameters?.path ?? '/'),
            Number(command.parameters?.limit ?? 10),
          ),
        };
      case 'check_log_rotation':
        return {
          status: await this.getLogRotationStatus(
            String(command.parameters?.path ?? '/var/log'),
          ),
        };
      default:
        return { executed: false, operation: command.operation };
    }
  }

  async evaluateCheck(check: CheckExpression): Promise<boolean> {
    const stmt = check.statement ?? '';

    if (stmt === 'disk_usage_percent') {
      const usage = await this.getDiskUsage();
      if (usage.length === 0) return true;
      const maxUsage = Math.max(...usage.map((fs) => fs.usagePercent));
      return compareCheckValue(maxUsage, check.expect.operator, check.expect.value);
    }

    if (stmt === 'inode_usage_percent') {
      const usage = await this.getDiskUsage();
      if (usage.length === 0) return true;
      const maxInode = Math.max(...usage.map((fs) => fs.inodeUsagePercent));
      return compareCheckValue(maxInode, check.expect.operator, check.expect.value);
    }

    if (stmt === 'log_dir_size_bytes') {
      const logStatus = await this.getLogRotationStatus('/var/log');
      return compareCheckValue(logStatus.totalSizeBytes, check.expect.operator, check.expect.value);
    }

    if (stmt === 'available_bytes') {
      const usage = await this.getDiskUsage();
      if (usage.length === 0) return true;
      const minAvail = Math.min(...usage.map((fs) => fs.availableBytes));
      return compareCheckValue(minAvail, check.expect.operator, check.expect.value);
    }

    return true;
  }

  listCapabilityProviders(): CapabilityProviderDescriptor[] {
    return [
      {
        id: 'disk-live-read',
        kind: 'capability_provider',
        name: 'Disk Live Read Provider',
        maturity: 'live_validated',
        capabilities: ['disk.usage.read', 'disk.files.inspect', 'disk.logs.inspect'],
        executionContexts: ['disk_read'],
        targetKinds: ['disk'],
        commandTypes: ['api_call'],
        supportsDryRun: true,
        supportsExecute: true,
      },
    ];
  }

  transition(_to: string): void {
    // No-op for live client
  }

  async close(): Promise<void> {
    // No persistent state to clean up
  }

  // --- Private helpers ---

  private async scanDirectory(
    dirPath: string,
    results: LargeEntry[],
    depth: number,
    maxDepth: number,
  ): Promise<void> {
    if (depth > maxDepth) return;

    try {
      const entries = await readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dirPath, entry.name);

        try {
          const entryStat = await stat(fullPath);

          if (entry.isFile()) {
            results.push({
              path: fullPath,
              sizeBytes: entryStat.size,
              type: 'file',
              modifiedAt: entryStat.mtime.toISOString(),
            });
          } else if (entry.isDirectory() && depth < maxDepth) {
            // For directories, estimate size from immediate children
            if (depth === maxDepth - 1) {
              results.push({
                path: fullPath,
                sizeBytes: entryStat.size,
                type: 'directory',
                modifiedAt: entryStat.mtime.toISOString(),
              });
            } else {
              await this.scanDirectory(fullPath, results, depth + 1, maxDepth);
            }
          }
        } catch {
          continue; // Permission denied or symlink loop
        }
      }
    } catch {
      // Directory not accessible
    }
  }
}
