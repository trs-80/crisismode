// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

/** Format a byte count as a human-readable string (e.g. "2.5GB", "128.0MB"). */
export function formatBytes(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)}GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

/** Format a duration in milliseconds as a human-readable string (e.g. "850ms", "4.2s", "2m 5s"). */
export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/** Format a duration in seconds as a human-readable string (e.g. "4.2h", "30m"). */
export function formatDuration(seconds: number): string {
  if (seconds >= 86400) return `${(seconds / 86400).toFixed(1)}d`;
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)}h`;
  if (seconds >= 60) return `${(seconds / 60).toFixed(0)}m`;
  return `${Math.round(seconds)}s`;
}
