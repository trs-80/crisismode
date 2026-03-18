// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { CaptureType } from '../types/common.js';

/**
 * Metadata for a stored capture artifact.
 */
export interface CaptureMetadata {
  /** Unique capture ID */
  id: string;
  /** Human-readable name from the CaptureDirective */
  name: string;
  /** Type of capture (sql_query, file_snapshot, etc.) */
  captureType: CaptureType;
  /** ISO timestamp when the capture was taken */
  capturedAt: string;
  /** Recovery plan ID that triggered this capture */
  planId?: string;
  /** Step ID within the plan */
  stepId?: string;
  /** Agent that produced the capture */
  agentId?: string;
  /** Size of the captured data in bytes */
  sizeBytes: number;
  /** Optional retention policy (e.g., "24h", "7d") */
  retention?: string;
  /** Whether rollback commands can be derived from this capture */
  rollbackCapable: boolean;
  /** Tags for filtering */
  tags?: string[];
}

/**
 * A stored capture with its data.
 */
export interface StoredCapture {
  metadata: CaptureMetadata;
  data: unknown;
}

/**
 * The index file structure persisted to disk.
 */
interface CaptureIndex {
  version: 1;
  captures: CaptureMetadata[];
}

const DEFAULT_BASE_DIR = join(homedir(), '.crisismode', 'captures');
const INDEX_FILE = 'index.json';

/**
 * Local file-based capture store.
 *
 * Stores capture artifacts at ~/.crisismode/captures/ with a JSON metadata
 * index for fast listing and lookup. Each capture's data is written to its
 * own file identified by capture ID.
 */
export class CaptureStore {
  private baseDir: string;
  private indexPath: string;
  private indexCache: CaptureIndex | null = null;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? DEFAULT_BASE_DIR;
    this.indexPath = join(this.baseDir, INDEX_FILE);
  }

  /**
   * Ensure the capture directory exists.
   */
  async initialize(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
    try {
      await fs.access(this.indexPath);
    } catch {
      await this.writeIndex({ version: 1, captures: [] });
    }
  }

  /**
   * Store a capture artifact and return its metadata.
   */
  async store(params: {
    name: string;
    captureType: CaptureType;
    data: unknown;
    planId?: string;
    stepId?: string;
    agentId?: string;
    retention?: string;
    rollbackCapable?: boolean;
    tags?: string[];
  }): Promise<CaptureMetadata> {
    await this.initialize();

    const id = randomUUID();
    const serialized = JSON.stringify(params.data, null, 2);
    const dataPath = this.dataPath(id);

    await fs.writeFile(dataPath, serialized, 'utf-8');

    const metadata: CaptureMetadata = {
      id,
      name: params.name,
      captureType: params.captureType,
      capturedAt: new Date().toISOString(),
      planId: params.planId,
      stepId: params.stepId,
      agentId: params.agentId,
      sizeBytes: Buffer.byteLength(serialized, 'utf-8'),
      retention: params.retention,
      rollbackCapable: params.rollbackCapable ?? false,
      tags: params.tags,
    };

    const index = await this.readIndex();
    index.captures.push(metadata);
    await this.writeIndex(index);

    return metadata;
  }

  /**
   * Retrieve a capture by ID.
   */
  async get(id: string): Promise<StoredCapture | null> {
    const index = await this.readIndex();
    const metadata = index.captures.find((c) => c.id === id);
    if (!metadata) return null;

    try {
      const raw = await fs.readFile(this.dataPath(id), 'utf-8');
      return { metadata, data: JSON.parse(raw) };
    } catch {
      return null;
    }
  }

  /**
   * List captures, optionally filtered.
   */
  async list(filter?: {
    planId?: string;
    stepId?: string;
    agentId?: string;
    captureType?: CaptureType;
    rollbackCapable?: boolean;
    tag?: string;
  }): Promise<CaptureMetadata[]> {
    const index = await this.readIndex();
    let results = index.captures;

    if (filter) {
      results = results.filter((c) => {
        if (filter.planId && c.planId !== filter.planId) return false;
        if (filter.stepId && c.stepId !== filter.stepId) return false;
        if (filter.agentId && c.agentId !== filter.agentId) return false;
        if (filter.captureType && c.captureType !== filter.captureType) return false;
        if (filter.rollbackCapable !== undefined && c.rollbackCapable !== filter.rollbackCapable) return false;
        if (filter.tag && !(c.tags ?? []).includes(filter.tag)) return false;
        return true;
      });
    }

    return results.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  }

  /**
   * Find the most recent capture matching the filter.
   */
  async findLatest(filter?: {
    planId?: string;
    stepId?: string;
    captureType?: CaptureType;
    rollbackCapable?: boolean;
  }): Promise<StoredCapture | null> {
    const matches = await this.list(filter);
    if (matches.length === 0) return null;
    return this.get(matches[0].id);
  }

  /**
   * Delete a capture by ID.
   */
  async delete(id: string): Promise<boolean> {
    const index = await this.readIndex();
    const idx = index.captures.findIndex((c) => c.id === id);
    if (idx === -1) return false;

    index.captures.splice(idx, 1);
    await this.writeIndex(index);

    try {
      await fs.unlink(this.dataPath(id));
    } catch {
      // Data file may already be gone
    }

    return true;
  }

  /**
   * Remove captures older than the given duration.
   * Duration format: "24h", "7d", "30d"
   */
  async cleanup(maxAge: string): Promise<number> {
    const ms = parseDuration(maxAge);
    if (ms <= 0) return 0;

    const cutoff = new Date(Date.now() - ms).toISOString();
    const index = await this.readIndex();
    const toDelete = index.captures.filter((c) => c.capturedAt < cutoff);

    for (const capture of toDelete) {
      try {
        await fs.unlink(this.dataPath(capture.id));
      } catch {
        // Ignore missing files
      }
    }

    index.captures = index.captures.filter((c) => c.capturedAt >= cutoff);
    await this.writeIndex(index);

    return toDelete.length;
  }

  /**
   * Get total storage size in bytes.
   */
  async totalSize(): Promise<number> {
    const index = await this.readIndex();
    return index.captures.reduce((sum, c) => sum + c.sizeBytes, 0);
  }

  private dataPath(id: string): string {
    return join(this.baseDir, `${id}.json`);
  }

  private async readIndex(): Promise<CaptureIndex> {
    if (this.indexCache) return this.indexCache;
    try {
      const raw = await fs.readFile(this.indexPath, 'utf-8');
      this.indexCache = JSON.parse(raw) as CaptureIndex;
      return this.indexCache;
    } catch {
      const empty: CaptureIndex = { version: 1, captures: [] };
      this.indexCache = empty;
      return empty;
    }
  }

  private async writeIndex(index: CaptureIndex): Promise<void> {
    this.indexCache = index;
    await fs.writeFile(this.indexPath, JSON.stringify(index, null, 2), 'utf-8');
  }
}

/**
 * Parse a duration string like "24h", "7d", "30m" to milliseconds.
 */
export function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)\s*(ms|s|m|h|d)$/);
  if (!match) return 0;

  const value = parseInt(match[1], 10);
  const unit = match[2];

  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };

  return value * (multipliers[unit] ?? 0);
}
