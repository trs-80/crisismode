// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type {
  DiskBackend,
  FilesystemUsage,
  LargeEntry,
  LogRotationStatus,
} from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';
import { compareCheckValue } from '../../framework/check-helpers.js';

export type SimulatorState = 'disk_critical' | 'disk_warning' | 'healthy';

export class DiskSimulator implements DiskBackend {
  private state: SimulatorState = 'disk_critical';

  transition(to: string): void {
    this.state = to as SimulatorState;
  }

  async getDiskUsage(): Promise<FilesystemUsage[]> {
    const GB = 1024 * 1024 * 1024;

    switch (this.state) {
      case 'disk_critical':
        return [
          {
            mountPoint: '/',
            device: '/dev/sda1',
            totalBytes: 50 * GB,
            usedBytes: 48.5 * GB,
            availableBytes: 1.5 * GB,
            usagePercent: 97,
            totalInodes: 3_276_800,
            usedInodes: 1_200_000,
            inodeUsagePercent: 37,
          },
          {
            mountPoint: '/var/log',
            device: '/dev/sda2',
            totalBytes: 10 * GB,
            usedBytes: 9.8 * GB,
            availableBytes: 0.2 * GB,
            usagePercent: 98,
            totalInodes: 655_360,
            usedInodes: 45_000,
            inodeUsagePercent: 7,
          },
          {
            mountPoint: '/boot',
            device: '/dev/sda3',
            totalBytes: 0.5 * GB,
            usedBytes: 0.48 * GB,
            availableBytes: 0.02 * GB,
            usagePercent: 96,
            totalInodes: 65_536,
            usedInodes: 320,
            inodeUsagePercent: 0.5,
          },
          {
            mountPoint: '/tmp',
            device: 'tmpfs',
            totalBytes: 4 * GB,
            usedBytes: 3.9 * GB,
            availableBytes: 0.1 * GB,
            usagePercent: 97.5,
            totalInodes: 1_000_000,
            usedInodes: 985_000,
            inodeUsagePercent: 98.5,
          },
        ];
      case 'disk_warning':
        return [
          {
            mountPoint: '/',
            device: '/dev/sda1',
            totalBytes: 50 * GB,
            usedBytes: 44 * GB,
            availableBytes: 6 * GB,
            usagePercent: 88,
            totalInodes: 3_276_800,
            usedInodes: 1_200_000,
            inodeUsagePercent: 37,
          },
          {
            mountPoint: '/var/log',
            device: '/dev/sda2',
            totalBytes: 10 * GB,
            usedBytes: 7.5 * GB,
            availableBytes: 2.5 * GB,
            usagePercent: 75,
            totalInodes: 655_360,
            usedInodes: 45_000,
            inodeUsagePercent: 7,
          },
          {
            mountPoint: '/boot',
            device: '/dev/sda3',
            totalBytes: 0.5 * GB,
            usedBytes: 0.25 * GB,
            availableBytes: 0.25 * GB,
            usagePercent: 50,
            totalInodes: 65_536,
            usedInodes: 200,
            inodeUsagePercent: 0.3,
          },
        ];
      case 'healthy':
        return [
          {
            mountPoint: '/',
            device: '/dev/sda1',
            totalBytes: 50 * GB,
            usedBytes: 20 * GB,
            availableBytes: 30 * GB,
            usagePercent: 40,
            totalInodes: 3_276_800,
            usedInodes: 500_000,
            inodeUsagePercent: 15,
          },
          {
            mountPoint: '/var/log',
            device: '/dev/sda2',
            totalBytes: 10 * GB,
            usedBytes: 2 * GB,
            availableBytes: 8 * GB,
            usagePercent: 20,
            totalInodes: 655_360,
            usedInodes: 10_000,
            inodeUsagePercent: 1.5,
          },
        ];
    }
  }

  async getLargestEntries(_path: string, limit: number = 10): Promise<LargeEntry[]> {
    const MB = 1024 * 1024;
    const GB = 1024 * 1024 * 1024;
    const now = new Date();

    switch (this.state) {
      case 'disk_critical':
        return [
          { path: '/var/log/syslog.1', sizeBytes: 4.2 * GB, type: 'file' as const, modifiedAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString() },
          { path: '/var/log/kern.log', sizeBytes: 2.8 * GB, type: 'file' as const, modifiedAt: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString() },
          { path: '/var/lib/docker/overlay2', sizeBytes: 15 * GB, type: 'directory' as const, modifiedAt: new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString() },
          { path: '/tmp/core.12345', sizeBytes: 1.2 * GB, type: 'file' as const, modifiedAt: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString() },
          { path: '/var/cache/apt/archives', sizeBytes: 800 * MB, type: 'directory' as const, modifiedAt: new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString() },
        ].slice(0, limit);
      case 'disk_warning':
        return [
          { path: '/var/log/syslog', sizeBytes: 1.5 * GB, type: 'file' as const, modifiedAt: now.toISOString() },
          { path: '/var/lib/docker/overlay2', sizeBytes: 12 * GB, type: 'directory' as const, modifiedAt: now.toISOString() },
        ].slice(0, limit);
      case 'healthy':
        return [
          { path: '/var/log/syslog', sizeBytes: 50 * MB, type: 'file' as const, modifiedAt: now.toISOString() },
        ].slice(0, limit);
    }
  }

  async getLogRotationStatus(path: string): Promise<LogRotationStatus> {
    const MB = 1024 * 1024;
    const GB = 1024 * 1024 * 1024;
    const now = new Date();

    switch (this.state) {
      case 'disk_critical':
        return {
          path,
          totalSizeBytes: 9.8 * GB,
          fileCount: 245,
          oldestFile: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString(),
          newestFile: now.toISOString(),
          compressedCount: 30,
          uncompressedCount: 215,
        };
      case 'disk_warning':
        return {
          path,
          totalSizeBytes: 3.5 * GB,
          fileCount: 120,
          oldestFile: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
          newestFile: now.toISOString(),
          compressedCount: 60,
          uncompressedCount: 60,
        };
      case 'healthy':
        return {
          path,
          totalSizeBytes: 200 * MB,
          fileCount: 25,
          oldestFile: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
          newestFile: now.toISOString(),
          compressedCount: 20,
          uncompressedCount: 5,
        };
    }
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'api_call') {
      throw new Error(`Unsupported disk simulator command type: ${command.type}`);
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
        return { simulated: true, operation: command.operation, parameters: command.parameters };
    }
  }

  async evaluateCheck(check: CheckExpression): Promise<boolean> {
    const stmt = check.statement ?? '';

    if (stmt === 'disk_usage_percent') {
      const usage = await this.getDiskUsage();
      const maxUsage = Math.max(...usage.map((fs) => fs.usagePercent));
      return compareCheckValue(maxUsage, check.expect.operator, check.expect.value);
    }

    if (stmt === 'inode_usage_percent') {
      const usage = await this.getDiskUsage();
      const maxInode = Math.max(...usage.map((fs) => fs.inodeUsagePercent));
      return compareCheckValue(maxInode, check.expect.operator, check.expect.value);
    }

    if (stmt === 'log_dir_size_bytes') {
      const logStatus = await this.getLogRotationStatus('/var/log');
      return compareCheckValue(logStatus.totalSizeBytes, check.expect.operator, check.expect.value);
    }

    if (stmt === 'available_bytes') {
      const usage = await this.getDiskUsage();
      const minAvail = Math.min(...usage.map((fs) => fs.availableBytes));
      return compareCheckValue(minAvail, check.expect.operator, check.expect.value);
    }

    return true;
  }

  listCapabilityProviders(): CapabilityProviderDescriptor[] {
    return [
      {
        id: 'disk-simulator-read',
        kind: 'capability_provider',
        name: 'Disk Simulator Read Provider',
        maturity: 'simulator_only',
        capabilities: ['disk.usage.read', 'disk.files.inspect', 'disk.logs.inspect'],
        executionContexts: ['disk_read'],
        targetKinds: ['disk'],
        commandTypes: ['api_call'],
        supportsDryRun: true,
        supportsExecute: true,
      },
    ];
  }

  async close(): Promise<void> {}
}
