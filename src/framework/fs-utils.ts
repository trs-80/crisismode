// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { stat } from 'node:fs/promises';

/**
 * Check if a path exists and is a directory.
 * Returns false for missing paths or non-directories.
 */
export async function dirExists(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Check if a path exists and is a regular file.
 * Returns false for missing paths or non-files.
 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isFile();
  } catch {
    return false;
  }
}
