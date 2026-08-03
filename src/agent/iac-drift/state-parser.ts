// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Terraform state parsing and state-source discovery.
 *
 * Read-only by contract: this module never writes or locks state and never
 * runs the terraform binary. Only tfstate format version 4 (Terraform >= 0.12)
 * is understood; anything else returns a typed error, never a throw.
 *
 * Exported for reuse by autodiscovery/visibility (same precedent as
 * findEnvExample in the config-drift agent).
 */

import { readFile, access, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface IacResource {
  /** Terraform resource type, e.g. 'aws_db_instance' */
  type: string;
  /** Terraform resource name within its module */
  name: string;
  /** Cloud identifier (attributes.id), '' when the state lacks one */
  id: string;
  /** Region parsed from attributes.arn when possible */
  region?: string | undefined;
  attributes: Record<string, unknown>;
}

export interface StateSummary {
  serial: number;
  terraformVersion: string;
  /** Managed aws_* resource count by Terraform type */
  resourceCounts: Record<string, number>;
}

export type ParsedState =
  | { ok: true; resources: IacResource[]; summary: StateSummary }
  | { ok: false; reason: string };

export type StateSource =
  | { kind: 'local'; path: string }
  | { kind: 's3-backend'; bucket: string; key: string; region: string }
  | { kind: 'unsupported-backend'; backendType: string }
  | { kind: 'none' };

/** Terraform types CrisisMode can watch, mapped to the agent kind that watches them. */
export const WATCHABLE_TF_TYPES: Record<string, string> = {
  aws_db_instance: 'aws-rds',
  aws_s3_bucket: 'aws-s3',
  aws_dynamodb_table: 'aws-dynamodb',
};

const ARN_REGION = /^arn:aws[a-z-]*:[^:]*:([a-z0-9-]*):/;

export function parseTfState(raw: string): ParsedState {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'state file is not valid JSON' };
  }
  const state = doc as { version?: unknown; terraform_version?: unknown; serial?: unknown; resources?: unknown };
  if (state.version !== 4) {
    return { ok: false, reason: `unsupported state format version ${String(state.version)} (only version 4, Terraform >= 0.12)` };
  }
  const resources: IacResource[] = [];
  const resourceCounts: Record<string, number> = {};
  for (const r of Array.isArray(state.resources) ? state.resources : []) {
    const res = r as { mode?: unknown; type?: unknown; name?: unknown; instances?: unknown };
    if (res.mode !== 'managed' || typeof res.type !== 'string' || !res.type.startsWith('aws_')) continue;
    for (const inst of Array.isArray(res.instances) ? res.instances : []) {
      const attributes = ((inst as { attributes?: unknown }).attributes ?? {}) as Record<string, unknown>;
      const arn = typeof attributes.arn === 'string' ? attributes.arn : '';
      const regionMatch = ARN_REGION.exec(arn);
      const region = regionMatch?.[1] || undefined;
      resources.push({
        type: res.type,
        name: typeof res.name === 'string' ? res.name : '',
        id: typeof attributes.id === 'string' ? attributes.id : '',
        region,
        attributes,
      });
      resourceCounts[res.type] = (resourceCounts[res.type] ?? 0) + 1;
    }
  }
  return {
    ok: true,
    resources,
    summary: {
      serial: typeof state.serial === 'number' ? state.serial : 0,
      terraformVersion: typeof state.terraform_version === 'string' ? state.terraform_version : 'unknown',
      resourceCounts,
    },
  };
}

/** Read a small JSON file, returning undefined on any I/O or parse failure. */
async function tryReadJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return undefined;
  }
}

/** Read a small text file, returning undefined on any I/O failure. */
async function tryReadText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

interface S3BackendConfig {
  bucket: string;
  key: string;
  region: string | undefined;
}

function parseS3BackendJson(backend: unknown): S3BackendConfig | undefined {
  const b = backend as { type?: unknown; config?: unknown } | undefined;
  if (!b || b.type !== 's3') return undefined;
  const config = (b.config ?? {}) as { bucket?: unknown; key?: unknown; region?: unknown };
  if (typeof config.bucket !== 'string' || typeof config.key !== 'string') return undefined;
  return {
    bucket: config.bucket,
    key: config.key,
    region: typeof config.region === 'string' ? config.region : undefined,
  };
}

const BACKEND_BLOCK = /backend\s+"([a-z0-9_]+)"\s*{([\s\S]*?)}/;
const HCL_BUCKET = /bucket\s*=\s*"([^"]+)"/;
const HCL_KEY = /key\s*=\s*"([^"]+)"/;
const HCL_REGION = /region\s*=\s*"([^"]+)"/;

function parseS3BackendHcl(body: string): S3BackendConfig | undefined {
  const bucket = HCL_BUCKET.exec(body)?.[1];
  const key = HCL_KEY.exec(body)?.[1];
  if (!bucket || !key) return undefined;
  return { bucket, key, region: HCL_REGION.exec(body)?.[1] };
}

function resolveRegion(region: string | undefined): string {
  return region ?? process.env.AWS_REGION ?? 'us-east-1';
}

/**
 * Locate the active Terraform state for a project directory. Read-only:
 * every step is a probe (existence check or best-effort parse) that falls
 * through to the next candidate on any failure.
 */
export async function discoverStateSource(cwd: string): Promise<StateSource> {
  // 1. Active non-default workspace.
  const environment = await tryReadText(join(cwd, '.terraform', 'environment'));
  const workspace = environment?.trim();
  if (workspace && workspace !== 'default') {
    const workspacePath = join(cwd, 'terraform.tfstate.d', workspace, 'terraform.tfstate');
    if (await exists(workspacePath)) {
      return { kind: 'local', path: workspacePath };
    }
  }

  // 2. Local state at the project root.
  const rootPath = join(cwd, 'terraform.tfstate');
  if (await exists(rootPath)) {
    return { kind: 'local', path: rootPath };
  }

  // 3. Backend config recorded by `terraform init`.
  const backendDoc = await tryReadJson(join(cwd, '.terraform', 'terraform.tfstate'));
  if (backendDoc && typeof backendDoc === 'object') {
    const backend = (backendDoc as { backend?: unknown }).backend;
    if (backend && typeof backend === 'object') {
      const backendType = (backend as { type?: unknown }).type;
      const s3Config = parseS3BackendJson(backend);
      if (s3Config) {
        return { kind: 's3-backend', bucket: s3Config.bucket, key: s3Config.key, region: resolveRegion(s3Config.region) };
      }
      if (typeof backendType === 'string') {
        return { kind: 'unsupported-backend', backendType };
      }
    }
  }

  // 4. Fall back to scanning root-level *.tf files for a backend block. Not
  //    an HCL parser — interpolated or unusually formatted values simply
  //    won't match and fall through to 'none'.
  let entries: string[];
  try {
    entries = (await readdir(cwd)).filter((f) => f.endsWith('.tf'));
  } catch {
    entries = [];
  }
  let tfContent = '';
  for (const entry of entries) {
    const content = await tryReadText(join(cwd, entry));
    if (content) tfContent += `${content}\n`;
  }
  const blockMatch = BACKEND_BLOCK.exec(tfContent);
  if (blockMatch) {
    const [, backendType, body] = blockMatch;
    if (backendType === 's3') {
      const s3Config = parseS3BackendHcl(body!);
      if (s3Config) {
        return { kind: 's3-backend', bucket: s3Config.bucket, key: s3Config.key, region: resolveRegion(s3Config.region) };
      }
    } else {
      return { kind: 'unsupported-backend', backendType: backendType! };
    }
  }

  // 5. No discoverable Terraform state.
  return { kind: 'none' };
}
