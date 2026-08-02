# IaC Awareness Arc 3: Terraform Drift Detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new read-only `iac-drift` agent that parses `terraform.tfstate` (local or S3 backend, never the terraform CLI), compares intended vs. observed AWS infrastructure (existence everywhere checkable, attribute-level for RDS/S3/DynamoDB), surfaces drift as suggestion-only findings, and feeds unwatchable Terraform-managed resources into the visibility section.

**Architecture:** Standard six-file agent (`src/agent/iac-drift/`) plus a pure state-parser module that autodiscovery and visibility import (the `findEnvExample` precedent). Live client follows Arc 2's aws-rds idioms exactly: `tryImportAws`, STS pre-flight, per-check `PermissionMissing` degradation. One new correlation rule links iac-drift to aws-rds via a new shared-entity-id mechanism.

**Tech Stack:** TypeScript strict/ESM (`.js` import extensions, named exports), vitest. No new dependencies — `@aws-sdk/client-rds`, `client-s3`, `client-dynamodb`, `client-sts` are already optional deps loaded via `tryImportAws`.

**Spec:** `docs/superpowers/specs/2026-08-02-iac-drift-arc3-design.md`

## Global Constraints

- Strictly read-only: never run the terraform binary, never write or lock state, never make a mutating AWS call. Plans contain ONLY `diagnosis_action` and `human_notification` steps.
- The spec's "maxRiskLevel: 'safe'" maps to `maxRiskLevel: 'routine'` — the `RiskLevel` union (`packages/agent-sdk/src/types/common.ts:6`) is `'routine' | 'elevated' | 'high' | 'critical'` and has no `'safe'` literal; `routine` is the floor.
- Tfstate format version 4 only; anything else is a typed error result, never a throw, never partial output.
- Honesty over guessing: unsupported backends / missing SDK / denied IAM / unknown resource types all degrade to `unknown` or visibility entries with the specific reason and an actionable hint.
- Stale state (staleDays > 30 or dirty `*.tf` in git) caps finding severity at `warning` — a stale comparison must never scream critical.
- Machine (`--json`) output changes strictly additive.
- TDD per task: failing test → verify RED → minimal code → verify GREEN → commit. Before each commit: `pnpm test && pnpm run typecheck && pnpm run lint`.
- Conventional commits. Branch: `feat/iac-drift` (create from main at Task 1 Step 1).
- Match surrounding code style; comments only for non-obvious constraints. SPDX header on every new file (see any existing `src/**/*.ts`).

---

### Task 1: Terraform state parser + state-source discovery

**Files:**
- Create: `src/agent/iac-drift/state-parser.ts`
- Create: `src/__tests__/fixtures/iac-tfstate-v4.ts` (shared fixture — Tasks 7, 8, and 10 reuse it)
- Test: `src/__tests__/iac-state-parser.test.ts` (create)

**Interfaces:**
- Consumes: nothing from this arc (pure module; `node:fs/promises`, `node:path` only).
- Produces:

```ts
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
export function parseTfState(raw: string): ParsedState;

export type StateSource =
  | { kind: 'local'; path: string }
  | { kind: 's3-backend'; bucket: string; key: string; region: string }
  | { kind: 'unsupported-backend'; backendType: string }
  | { kind: 'none' };
export function discoverStateSource(cwd: string): Promise<StateSource>;

/** Terraform types CrisisMode can watch, mapped to the agent kind that watches them. */
export const WATCHABLE_TF_TYPES: Record<string, string>;
```

- [ ] **Step 1: Write the fixture and the failing test**

The fixture is shared by Tasks 7, 8, and 10 — one source of truth:

```ts
// src/__tests__/fixtures/iac-tfstate-v4.ts
// SPDX-License-Identifier: Apache-2.0

/** A realistic tfstate v4 fixture: drifted-comparable RDS instance, S3 bucket
 *  with a provider-v4 versioning sub-resource, DynamoDB table, one unwatchable
 *  ElastiCache cluster, plus data-mode and non-aws resources that parsers must skip.
 *  ARN account fields are deliberately empty — the pre-commit hook rejects
 *  12-digit account IDs in ARNs, and the parser only reads the region field. */
export const V4_STATE = JSON.stringify({
  version: 4,
  terraform_version: '1.9.0',
  serial: 42,
  lineage: 'abc',
  resources: [
    {
      mode: 'managed', type: 'aws_db_instance', name: 'main',
      provider: 'provider["registry.terraform.io/hashicorp/aws"]',
      instances: [{ attributes: {
        id: 'prod-db', arn: 'arn:aws:rds:us-east-1::db:prod-db',
        instance_class: 'db.t3.medium', engine: 'postgres', engine_version: '16',
        multi_az: false, backup_retention_period: 7, deletion_protection: true,
        storage_type: 'gp3', allocated_storage: 20,
      } }],
    },
    { mode: 'managed', type: 'aws_s3_bucket', name: 'uploads',
      instances: [{ attributes: { id: 'user-uploads', bucket: 'user-uploads', arn: 'arn:aws:s3:::user-uploads' } }] },
    { mode: 'managed', type: 'aws_s3_bucket_versioning', name: 'uploads',
      instances: [{ attributes: { id: 'user-uploads', bucket: 'user-uploads', versioning_configuration: [{ status: 'Enabled' }] } }] },
    { mode: 'managed', type: 'aws_dynamodb_table', name: 'sessions',
      instances: [{ attributes: {
        id: 'sessions', arn: 'arn:aws:dynamodb:us-east-1::table/sessions',
        billing_mode: 'PAY_PER_REQUEST', point_in_time_recovery: [{ enabled: true }],
      } }] },
    { mode: 'managed', type: 'aws_elasticache_cluster', name: 'cache',
      instances: [{ attributes: { id: 'app-cache', arn: 'arn:aws:elasticache:us-east-1::cluster:app-cache' } }] },
    { mode: 'data', type: 'aws_caller_identity', name: 'me', instances: [{ attributes: { id: 'x' } }] },
    { mode: 'managed', type: 'random_pet', name: 'suffix', instances: [{ attributes: { id: 'pet' } }] },
  ],
});
```

```ts
// src/__tests__/iac-state-parser.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTfState, discoverStateSource, WATCHABLE_TF_TYPES } from '../agent/iac-drift/state-parser.js';
import { V4_STATE } from './fixtures/iac-tfstate-v4.js';

describe('parseTfState', () => {
  it('extracts managed aws_* resources with ids and regions', () => {
    const r = parseTfState(V4_STATE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resources).toHaveLength(5); // db, bucket, versioning, table, elasticache
    expect(r.resources[0]).toMatchObject({
      type: 'aws_db_instance', name: 'main', id: 'prod-db', region: 'us-east-1',
    });
    // s3 ARNs carry no region — region stays undefined, never guessed
    expect(r.resources.find((x) => x.type === 'aws_s3_bucket')!.region).toBeUndefined();
    expect(r.summary).toEqual({
      serial: 42, terraformVersion: '1.9.0',
      resourceCounts: {
        aws_db_instance: 1, aws_s3_bucket: 1, aws_s3_bucket_versioning: 1,
        aws_dynamodb_table: 1, aws_elasticache_cluster: 1,
      },
    });
  });

  it('excludes data-mode and non-aws resources', () => {
    const r = parseTfState(V4_STATE);
    if (!r.ok) throw new Error('expected ok');
    expect(r.resources.map((x) => x.type)).not.toContain('aws_caller_identity');
    expect(r.resources.map((x) => x.type)).not.toContain('random_pet');
  });

  it('rejects unknown format versions with a typed error', () => {
    const r = parseTfState(JSON.stringify({ version: 3, resources: [] }));
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('version 3') });
  });

  it('rejects corrupt JSON without throwing', () => {
    const r = parseTfState('{not json');
    expect(r.ok).toBe(false);
  });
});

describe('discoverStateSource', () => {
  it('finds local terraform.tfstate at the project root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iac-'));
    await writeFile(join(dir, 'terraform.tfstate'), V4_STATE);
    expect(await discoverStateSource(dir)).toEqual({ kind: 'local', path: join(dir, 'terraform.tfstate') });
  });

  it('follows the active non-default workspace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iac-'));
    await mkdir(join(dir, '.terraform'), { recursive: true });
    await writeFile(join(dir, '.terraform', 'environment'), 'staging');
    await mkdir(join(dir, 'terraform.tfstate.d', 'staging'), { recursive: true });
    await writeFile(join(dir, 'terraform.tfstate.d', 'staging', 'terraform.tfstate'), V4_STATE);
    expect(await discoverStateSource(dir)).toEqual({
      kind: 'local', path: join(dir, 'terraform.tfstate.d', 'staging', 'terraform.tfstate'),
    });
  });

  it('reads an s3 backend from .terraform/terraform.tfstate JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iac-'));
    await mkdir(join(dir, '.terraform'), { recursive: true });
    await writeFile(join(dir, '.terraform', 'terraform.tfstate'), JSON.stringify({
      backend: { type: 's3', config: { bucket: 'tf-states', key: 'app/terraform.tfstate', region: 'eu-west-1' } },
    }));
    expect(await discoverStateSource(dir)).toEqual({
      kind: 's3-backend', bucket: 'tf-states', key: 'app/terraform.tfstate', region: 'eu-west-1',
    });
  });

  it('reports non-s3 backends as unsupported', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iac-'));
    await mkdir(join(dir, '.terraform'), { recursive: true });
    await writeFile(join(dir, '.terraform', 'terraform.tfstate'), JSON.stringify({
      backend: { type: 'remote', config: {} },
    }));
    expect(await discoverStateSource(dir)).toEqual({ kind: 'unsupported-backend', backendType: 'remote' });
  });

  it('falls back to scanning *.tf for a backend "s3" block when .terraform/ is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iac-'));
    await writeFile(join(dir, 'main.tf'), [
      'terraform {',
      '  backend "s3" {',
      '    bucket = "tf-states"',
      '    key    = "app/terraform.tfstate"',
      '    region = "us-east-2"',
      '  }',
      '}',
    ].join('\n'));
    expect(await discoverStateSource(dir)).toEqual({
      kind: 's3-backend', bucket: 'tf-states', key: 'app/terraform.tfstate', region: 'us-east-2',
    });
  });

  it('returns none for a directory without terraform', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iac-'));
    expect(await discoverStateSource(dir)).toEqual({ kind: 'none' });
  });
});

describe('WATCHABLE_TF_TYPES', () => {
  it('maps the deep trio to their agent kinds', () => {
    expect(WATCHABLE_TF_TYPES).toEqual({
      aws_db_instance: 'aws-rds',
      aws_s3_bucket: 'aws-s3',
      aws_dynamodb_table: 'aws-dynamodb',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/iac-state-parser.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/agent/iac-drift/state-parser.ts`**

Pure functions; the only I/O is `fs` reads inside `discoverStateSource`. Key logic:

```ts
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

// ... interfaces from the Produces block above ...

export const WATCHABLE_TF_TYPES: Record<string, string> = {
  aws_db_instance: 'aws-rds',
  aws_s3_bucket: 'aws-s3',
  aws_dynamodb_table: 'aws-dynamodb',
};

const ARN_REGION = /^arn:aws[a-z-]*:[^:]*:([a-z0-9-]*):/;

export function parseTfState(raw: string): ParsedState {
  let doc: unknown;
  try { doc = JSON.parse(raw); } catch { return { ok: false, reason: 'state file is not valid JSON' }; }
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
        ...(region !== undefined ? { region } : {}),
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
```

`discoverStateSource(cwd)` resolution order (each step wrapped so fs errors fall through to the next):
1. Read `.terraform/environment`; if it names a workspace other than `default` and `terraform.tfstate.d/<ws>/terraform.tfstate` exists (`access`) → `{ kind: 'local', path }`.
2. `terraform.tfstate` at root exists → `{ kind: 'local', path }`.
3. `.terraform/terraform.tfstate` parses as JSON with `backend.type`:
   - `'s3'` with string `config.bucket`/`config.key` → `{ kind: 's3-backend', bucket, key, region: config.region ?? process.env.AWS_REGION ?? 'us-east-1' }`
   - any other type → `{ kind: 'unsupported-backend', backendType }`.
4. `readdir(cwd)` for `*.tf` files (root only, no recursion); concatenate contents; match `/backend\s+"([a-z0-9_]+)"\s*{([\s\S]*?)}/` — if the backend type is `s3`, extract `bucket`/`key`/`region` each via `/bucket\s*=\s*"([^"]+)"/` style patterns (missing region falls back as in step 3); if it matches a non-s3 type → `unsupported-backend`. This is explicitly NOT an HCL parser — a `backend` block with interpolated values simply won't match and falls through.
5. `{ kind: 'none' }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/iac-state-parser.test.ts` → PASS

- [ ] **Step 5: Full gate and commit**

```bash
git checkout -b feat/iac-drift
pnpm test && pnpm run typecheck && pnpm run lint
git add -A && git commit -m "feat(iac-drift): tfstate v4 parser and state-source discovery"
```

---

### Task 2: Drift comparator (pure)

**Files:**
- Create: `src/agent/iac-drift/drift-compare.ts`
- Test: `src/__tests__/iac-drift-compare.test.ts` (create)

**Interfaces:**
- Consumes: `IacResource` (Task 1).
- Produces:

```ts
export interface AttributeDrift { attribute: string; intended: string; observed: string }
export interface DriftComparison {
  drifts: AttributeDrift[];
  /** Attribute names this comparator actually checked (the honesty disclosure). */
  comparedAttributes: string[];
  /** Total attribute keys recorded in state for this resource — lets output say "compared 8 of 42". */
  intendedAttributeCount: number;
}
export interface ObservedRdsFacts {
  instanceClass: string; engine: string; engineVersion: string; multiAz: boolean;
  backupRetentionPeriod: number; deletionProtection: boolean;
  storageType: string; allocatedStorageGb: number;
}
export function compareRdsInstance(intended: IacResource, observed: ObservedRdsFacts): DriftComparison;
export interface ObservedS3Facts { versioningEnabled: boolean; hasLifecycleRules: boolean }
export function compareS3Bucket(intended: IacResource, allResources: IacResource[], observed: ObservedS3Facts): DriftComparison;
export interface ObservedDynamoFacts { billingMode: string; pitrEnabled: boolean }
export function compareDynamoTable(intended: IacResource, observed: ObservedDynamoFacts): DriftComparison;
```

Note (spec deviation, agreed rationale): the spec's "count of uncompared attribute differences" is not computable — we only fetch the modeled attributes from AWS, so differences in unmodeled ones are unknowable. `comparedAttributes` + `intendedAttributeCount` express the same honesty computably ("compared 8 of 42 recorded attributes").

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/iac-drift-compare.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { compareRdsInstance, compareS3Bucket, compareDynamoTable } from '../agent/iac-drift/drift-compare.js';
import type { IacResource } from '../agent/iac-drift/state-parser.js';

const rds = (attrs: Record<string, unknown>): IacResource => ({
  type: 'aws_db_instance', name: 'main', id: 'prod-db', region: 'us-east-1', attributes: attrs,
});
const RDS_ATTRS = {
  id: 'prod-db', instance_class: 'db.t3.medium', engine: 'postgres', engine_version: '16',
  multi_az: false, backup_retention_period: 7, deletion_protection: true,
  storage_type: 'gp3', allocated_storage: 20, tags: {},
};
const OBSERVED_ALIGNED = {
  instanceClass: 'db.t3.medium', engine: 'postgres', engineVersion: '16.4', multiAz: false,
  backupRetentionPeriod: 7, deletionProtection: true, storageType: 'gp3', allocatedStorageGb: 20,
};

describe('compareRdsInstance', () => {
  it('reports no drift when aligned (engine_version matches by prefix)', () => {
    const r = compareRdsInstance(rds(RDS_ATTRS), OBSERVED_ALIGNED);
    expect(r.drifts).toEqual([]);
    expect(r.comparedAttributes).toContain('instance_class');
    expect(r.intendedAttributeCount).toBe(Object.keys(RDS_ATTRS).length);
  });

  it('reports each drifted attribute with intended and observed values', () => {
    const r = compareRdsInstance(rds(RDS_ATTRS), {
      ...OBSERVED_ALIGNED, instanceClass: 'db.t3.large', deletionProtection: false,
    });
    expect(r.drifts).toEqual([
      { attribute: 'instance_class', intended: 'db.t3.medium', observed: 'db.t3.large' },
      { attribute: 'deletion_protection', intended: 'true', observed: 'false' },
    ]);
  });

  it('skips attributes the state does not record instead of inventing intent', () => {
    const { deletion_protection: _dp, ...rest } = RDS_ATTRS;
    const r = compareRdsInstance(rds(rest), { ...OBSERVED_ALIGNED, deletionProtection: false });
    expect(r.drifts).toEqual([]);
    expect(r.comparedAttributes).not.toContain('deletion_protection');
  });
});

describe('compareS3Bucket', () => {
  const bucket: IacResource = {
    type: 'aws_s3_bucket', name: 'uploads', id: 'user-uploads',
    attributes: { id: 'user-uploads', bucket: 'user-uploads' },
  };
  it('folds aws_s3_bucket_versioning (provider v4+) into the bucket intent', () => {
    const versioning: IacResource = {
      type: 'aws_s3_bucket_versioning', name: 'uploads', id: 'user-uploads',
      attributes: { id: 'user-uploads', bucket: 'user-uploads', versioning_configuration: [{ status: 'Enabled' }] },
    };
    const r = compareS3Bucket(bucket, [bucket, versioning], { versioningEnabled: false, hasLifecycleRules: false });
    expect(r.drifts).toEqual([{ attribute: 'versioning', intended: 'Enabled', observed: 'Suspended' }]);
  });
  it('reads legacy inline versioning (provider v3)', () => {
    const legacy: IacResource = { ...bucket, attributes: { ...bucket.attributes, versioning: [{ enabled: true }] } };
    const r = compareS3Bucket(legacy, [legacy], { versioningEnabled: true, hasLifecycleRules: false });
    expect(r.drifts).toEqual([]);
    expect(r.comparedAttributes).toContain('versioning');
  });
  it('skips versioning when neither inline nor sub-resource intent exists', () => {
    const r = compareS3Bucket(bucket, [bucket], { versioningEnabled: false, hasLifecycleRules: false });
    expect(r.drifts).toEqual([]);
    expect(r.comparedAttributes).not.toContain('versioning');
  });
});

describe('compareDynamoTable', () => {
  const table: IacResource = {
    type: 'aws_dynamodb_table', name: 'sessions', id: 'sessions',
    attributes: { id: 'sessions', billing_mode: 'PAY_PER_REQUEST', point_in_time_recovery: [{ enabled: true }] },
  };
  it('detects PITR drift', () => {
    const r = compareDynamoTable(table, { billingMode: 'PAY_PER_REQUEST', pitrEnabled: false });
    expect(r.drifts).toEqual([{ attribute: 'point_in_time_recovery', intended: 'true', observed: 'false' }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/iac-drift-compare.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/agent/iac-drift/drift-compare.ts`**

Internal helper drives all three:

```ts
interface Pair { attribute: string; intended: unknown; observed: unknown; equal?: (i: unknown, o: unknown) => boolean }

function compare(pairs: Pair[], intendedAttributeCount: number): DriftComparison {
  const drifts: AttributeDrift[] = [];
  const comparedAttributes: string[] = [];
  for (const p of pairs) {
    if (p.intended === undefined || p.intended === null) continue; // state records no intent — skip, never invent
    comparedAttributes.push(p.attribute);
    const eq = p.equal ?? ((i, o) => String(i) === String(o));
    if (!eq(p.intended, p.observed)) {
      drifts.push({ attribute: p.attribute, intended: String(p.intended), observed: String(p.observed) });
    }
  }
  return { drifts, comparedAttributes, intendedAttributeCount };
}
```

- `compareRdsInstance`: pairs for `instance_class`, `engine`, `engine_version` (equal: observed version `String(o).startsWith(String(i))` — Terraform commonly pins only the major version), `multi_az`, `backup_retention_period`, `deletion_protection`, `storage_type`, `allocated_storage`.
- `compareS3Bucket`: versioning intent — first a sub-resource in `allResources` with `type === 'aws_s3_bucket_versioning'` whose `attributes.bucket === intended.id`, reading `versioning_configuration[0].status` (`'Enabled'`/`'Suspended'`); else legacy `intended.attributes.versioning[0].enabled` (boolean → `'Enabled'`/`'Suspended'`); else undefined (skipped). Observed maps `versioningEnabled` to the same strings. Lifecycle intent — sub-resource `aws_s3_bucket_lifecycle_configuration` with matching bucket, or legacy non-empty `lifecycle_rule` array → `'true'`; compare against `hasLifecycleRules`.
- `compareDynamoTable`: `billing_mode` (state default when absent: skip — absent means unknown intent here since older states omit it), `point_in_time_recovery` from `attributes.point_in_time_recovery[0].enabled`.

- [ ] **Step 4: Run test to verify it passes** → `pnpm vitest run src/__tests__/iac-drift-compare.test.ts`

- [ ] **Step 5: Full gate and commit**

```bash
pnpm test && pnpm run typecheck && pnpm run lint
git add -A && git commit -m "feat(iac-drift): pure intended-vs-observed drift comparator for RDS/S3/DynamoDB"
```

---

### Task 3: Backend interface + simulator (and PermissionMissing → aws-common)

**Files:**
- Modify: `src/agent/aws-common.ts` (add `PermissionMissing` + `isPermissionMissing`, moved verbatim from `src/agent/aws-rds/backend.ts:24-30`)
- Modify: `src/agent/aws-rds/backend.ts` (replace the local definitions with re-exports so all existing imports keep working: `export { isPermissionMissing } from '../aws-common.js'; export type { PermissionMissing } from '../aws-common.js';`)
- Create: `src/agent/iac-drift/backend.ts`
- Create: `src/agent/iac-drift/simulator.ts`
- Test: `src/__tests__/iac-drift-simulator.test.ts` (create)

**Interfaces:**
- Consumes: `IacResource`, `StateSource` kinds (Task 1); `DriftComparison` (Task 2); `ExecutionBackend` from `../../framework/backend.js` (`executeCommand(command): Promise<unknown>`, `evaluateCheck(check): Promise<boolean>`, `close(): Promise<void>`); `PermissionMissing` from `../aws-common.js`.
- Produces:

```ts
// src/agent/iac-drift/backend.ts
export type IacDriftScenario = 'drifted' | 'aligned' | 'state_unreadable';
export interface IacStateStatus {
  source: 'local' | 's3-backend' | 'unsupported-backend' | 'none';
  /** Human-readable: file path, bucket/key, or backend type */
  detail: string;
  readable: boolean;
  reason?: string | undefined;          // populated when readable is false
  serial?: number | undefined;
  lastModifiedAt?: string | undefined;  // ISO timestamp
  staleDays?: number | undefined;
  dirtyTfFiles?: boolean | undefined;   // uncommitted *.tf edits in git
  resourceCounts?: Record<string, number> | undefined;
}
export type ResourceExistence =
  | { existence: 'exists' | 'missing' }
  | { existence: 'unknown'; reason: string };
export interface IacDriftBackend extends ExecutionBackend {
  getStateStatus(): Promise<IacStateStatus>;
  listManagedResources(): Promise<IacResource[]>;
  checkResourceExistence(resource: IacResource): Promise<ResourceExistence | PermissionMissing>;
  /** null = resource type has no deep comparator (existence-only tier) */
  getResourceDrift(resource: IacResource): Promise<DriftComparison | PermissionMissing | null>;
  transition?(to: string): void;
}
```

- Simulator: `export class IacDriftSimulator implements IacDriftBackend` with constructor `(scenario: IacDriftScenario = 'drifted')`.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/iac-drift-simulator.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { IacDriftSimulator } from '../agent/iac-drift/simulator.js';

describe('IacDriftSimulator', () => {
  it('drifted: RDS attribute drift, missing bucket, aligned table, unknown elasticache', async () => {
    const sim = new IacDriftSimulator('drifted');
    const resources = await sim.listManagedResources();
    const byType = Object.fromEntries(resources.map((r) => [r.type, r]));

    const rdsDrift = await sim.getResourceDrift(byType.aws_db_instance!);
    expect(rdsDrift).toMatchObject({
      drifts: expect.arrayContaining([
        expect.objectContaining({ attribute: 'instance_class', intended: 'db.t3.medium', observed: 'db.t3.large' }),
      ]),
    });

    expect(await sim.checkResourceExistence(byType.aws_s3_bucket!)).toEqual({ existence: 'missing' });
    expect(await sim.checkResourceExistence(byType.aws_dynamodb_table!)).toEqual({ existence: 'exists' });
    expect(await sim.getResourceDrift(byType.aws_dynamodb_table!)).toMatchObject({ drifts: [] });
    expect(await sim.checkResourceExistence(byType.aws_elasticache_cluster!)).toMatchObject({ existence: 'unknown' });
    expect(await sim.getResourceDrift(byType.aws_elasticache_cluster!)).toBeNull();

    const status = await sim.getStateStatus();
    expect(status.readable).toBe(true);
    expect(status.source).toBe('local');
  });

  it('aligned: no drift and nothing missing', async () => {
    const sim = new IacDriftSimulator('aligned');
    const resources = await sim.listManagedResources();
    for (const r of resources.filter((x) => x.type !== 'aws_elasticache_cluster')) {
      expect(await sim.checkResourceExistence(r)).toEqual({ existence: 'exists' });
      const drift = await sim.getResourceDrift(r);
      if (drift) expect(drift).toMatchObject({ drifts: [] });
    }
  });

  it('state_unreadable: status is unreadable and no resources are listed', async () => {
    const sim = new IacDriftSimulator('state_unreadable');
    const status = await sim.getStateStatus();
    expect(status.readable).toBe(false);
    expect(status.reason).toBeTruthy();
    expect(await sim.listManagedResources()).toEqual([]);
  });

  it('supports transition() and evaluateCheck counters', async () => {
    const sim = new IacDriftSimulator('drifted');
    expect(await sim.evaluateCheck({ type: 'structured_command', statement: 'iac_drift_count', expect: { operator: 'gte', value: 1 } })).toBe(true);
    sim.transition('aligned');
    expect(await sim.evaluateCheck({ type: 'structured_command', statement: 'iac_drift_count', expect: { operator: 'eq', value: 0 } })).toBe(true);
  });
});
```

(Adjust the `evaluateCheck` argument shape to the actual `CheckExpression` type from the SDK — mirror how `src/agent/config-drift/simulator.ts` implements and tests it.)

- [ ] **Step 2: Run test to verify it fails** → FAIL (modules missing).

- [ ] **Step 3: Implement**

`aws-common.ts` gains (verbatim move):

```ts
/** A live-client check that failed because an IAM action is not allowed. */
export interface PermissionMissing {
  permissionMissing: string;
}
export function isPermissionMissing(v: unknown): v is PermissionMissing {
  return typeof v === 'object' && v !== null && 'permissionMissing' in v;
}
```

Simulator holds an embedded fixture tfstate (a `const FIXTURE_STATE = {...}` mirroring Task 1's shape) with:
`aws_db_instance.main` (id `prod-db`, `instance_class: 'db.t3.medium'`, `engine: 'postgres'`, `engine_version: '16'`, `multi_az: false`, `backup_retention_period: 7`, `deletion_protection: true`, `storage_type: 'gp3'`, `allocated_storage: 20`, arn with `us-east-1`), `aws_s3_bucket.uploads` (id `user-uploads`) + `aws_s3_bucket_versioning.uploads` (Enabled), `aws_dynamodb_table.sessions` (id `sessions`, `billing_mode: 'PAY_PER_REQUEST'`, PITR enabled), `aws_elasticache_cluster.cache` (id `app-cache`).

Observed side per scenario (in-memory maps, no I/O):
- `drifted`: prod-db observed `{ instanceClass: 'db.t3.large', deletionProtection: false, ...rest aligned }`; `user-uploads` missing; `sessions` aligned; elasticache → `{ existence: 'unknown', reason: 'no existence check for aws_elasticache_cluster yet' }`.
- `aligned`: everything matches intent; bucket exists.
- `state_unreadable`: `getStateStatus()` → `{ source: 'local', detail: 'terraform.tfstate', readable: false, reason: 'state file is not valid JSON' }`; `listManagedResources()` → `[]`.

`getResourceDrift` calls the Task 2 comparators with the fixture resources — the simulator exercises the real comparison code, not a parallel fake. `executeCommand` handles operation `scan_iac_drift` (returns `{ stateStatus, resourceCount }`); `evaluateCheck` statements: `iac_drift_count`, `iac_missing_count`, `iac_state_readable`. `close()` is a no-op. Follow `src/agent/config-drift/simulator.ts` for the structured-command/check plumbing idioms.

- [ ] **Step 4: Run test to verify it passes**, plus the full suite to prove the `PermissionMissing` move broke nothing:

Run: `pnpm vitest run src/__tests__/iac-drift-simulator.test.ts && pnpm test` → PASS

- [ ] **Step 5: Full gate and commit**

```bash
pnpm run typecheck && pnpm run lint
git add -A && git commit -m "feat(iac-drift): backend contract and scenario simulator; lift PermissionMissing to aws-common"
```

---

### Task 4: Manifest, registration, config plumbing

**Files:**
- Create: `src/agent/iac-drift/manifest.ts`
- Create: `src/agent/iac-drift/registration.ts`
- Modify: `src/config/schema.ts` (add `IacTargetOptions`; `TargetConfig.iac?`; `ResolvedTarget.iac?` — model on the `configDrift` fields at `schema.ts:74-79, 98, 157`)
- Modify: `src/config/resolve.ts:26` (add `iac: target.iac,` beside `configDrift`)
- Modify: `src/config/builtin-agents.ts` (import + append `iacDriftRegistration` after `awsRdsRecoveryRegistration` with a `// IaC awareness` comment)
- Modify: `src/cli/commands/scan.ts` `KIND_PREFIX` map (~line 54): add `'iac-drift': 'IAC'`
- Test: `src/__tests__/iac-drift-registration.test.ts` (create)

**Interfaces:**
- Consumes: `IacDriftSimulator` (Task 3); `AgentRegistration` from `../../config/agent-registration.js`; manifest helpers from `../../framework/manifest-defaults.js`.
- Produces:

```ts
// schema.ts additions
export interface IacTargetOptions {
  /** Project directory containing .tf / terraform.tfstate (default: process.cwd()).
   *  The literal 'simulator' selects the in-memory backend. */
  dir?: string;
}
// registration
export const iacDriftRegistration: AgentRegistration; // kind: 'iac-drift', name: 'iac-drift-recovery'
export const iacDriftManifest: AgentManifest;
```

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/iac-drift-registration.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { builtinAgents } from '../config/builtin-agents.js';
import { resolveTarget } from '../config/resolve.js';

describe('iac-drift registration', () => {
  const reg = builtinAgents.find((r) => r.kind === 'iac-drift');

  it('is registered with a read-only risk profile', () => {
    expect(reg).toBeDefined();
    expect(reg!.name).toBe('iac-drift-recovery');
    expect(reg!.manifest.spec.riskProfile.maxRiskLevel).toBe('routine');
    expect(reg!.manifest.spec.riskProfile.dataLossPossible).toBe(false);
  });

  it('resolveTarget passes the iac options block through', () => {
    const resolved = resolveTarget({
      name: 't', kind: 'iac-drift', primary: { host: 'auto', port: 0 }, iac: { dir: '/tmp/project' },
    });
    expect(resolved.iac).toEqual({ dir: '/tmp/project' });
  });

  it('creates a simulator-backed agent when iac.dir is "simulator"', async () => {
    const resolved = resolveTarget({
      name: 't', kind: 'iac-drift', primary: { host: 'auto', port: 0 }, iac: { dir: 'simulator' },
    });
    const instance = await reg!.createAgent(resolved);
    expect(instance.agent.manifest.metadata.name).toBe('iac-drift-recovery');
    const status = await (instance.backend as { getStateStatus(): Promise<{ readable: boolean }> }).getStateStatus();
    expect(status.readable).toBe(true);
    await instance.backend.close();
  });
});
```

Note: `createAgent` imports `./agent.js`, which does not exist until Task 5. To keep this task independently green, create a **stub** `src/agent/iac-drift/agent.ts` in Step 3 with the class shell (manifest + constructor + `assessHealth`/`diagnose`/`plan` throwing `new Error('implemented in the next task')`, `replan` = `defaultReplan`) — the test above only touches `manifest` and the backend.

- [ ] **Step 2: Run test to verify it fails** → FAIL.

- [ ] **Step 3: Implement**

Manifest (model on `src/agent/aws-dynamodb/manifest.ts`, adjusted):
- metadata: name `iac-drift-recovery`, version `1.0.0`, description "Detects drift between Terraform-managed intent and observed AWS infrastructure. Read-only: suggests reconciliation, never executes terraform.", tags `['terraform', 'iac', 'drift', 'aws']`, plugin id `iac.drift`, kind `domain_pack`, maturity `simulator_only`.
- targetSystems: `[{ technology: 'terraform', versionConstraint: '*', components: ['state', 'aws-resources'] }]`.
- triggerConditions: health_check `iac_alignment_status` degraded; manual.
- failureScenarios: `['resource_missing', 'attribute_drift', 'state_stale', 'state_unreadable']`.
- executionContexts: ONE read context: `{ name: 'iac_read', type: 'structured_command', privilege: 'read', target: 'terraform-state', allowedOperations: ['scan_iac_drift'], capabilities: ['iac.state.read'] }`. No write context — this agent has nothing to execute.
- observabilityDependencies: required `['terraform_state']`, optional `['aws_control_plane']`.
- riskProfile: `{ maxRiskLevel: 'routine', dataLossPossible: false, serviceDisruptionPossible: false }`.
- humanInteraction: copy aws-dynamodb's block.

Registration (model on `src/agent/aws-dynamodb/registration.ts`): `dir = target.iac?.dir ?? process.cwd()`; `dir === 'simulator'` → `IacDriftSimulator`; otherwise dynamic-import `IacDriftLiveClient` (Task 7) in a try/catch that warns and falls back to the simulator exactly like aws-dynamodb's catch. Until Task 7 lands, the live import will throw module-not-found and hit that fallback — acceptable interim behavior, noted in the warn text.

- [ ] **Step 4: Run test to verify it passes** → `pnpm vitest run src/__tests__/iac-drift-registration.test.ts`

- [ ] **Step 5: Full gate and commit**

```bash
pnpm test && pnpm run typecheck && pnpm run lint
git add -A && git commit -m "feat(iac-drift): manifest, registration, and target config plumbing"
```

---

### Task 5: Agent — assessHealth + diagnose + knowledge map

**Files:**
- Modify: `src/agent/iac-drift/agent.ts` (replace Task 4 stub bodies for `assessHealth`/`diagnose`)
- Modify: `packages/agent-sdk/src/types/health.ts` (add optional `entityId?: string` to `HealthSignal`, doc comment: "Stable identifier of the concrete resource this signal is about (e.g. an RDS instance id) — used for cross-agent correlation.")
- Modify: `src/framework/signal-explanations.ts` (two new entries, placed before the generic `backup|snapshot|pitr` entry so `iac_` prefixes win)
- Modify: `src/__tests__/signal-explanations.test.ts` `REPRESENTATIVE_SOURCES` (~line 81)
- Test: `src/__tests__/iac-drift-agent.test.ts` (create)

**Interfaces:**
- Consumes: `IacDriftBackend`, `IacDriftSimulator`, `isPermissionMissing`; `RecoveryAgent`, `defaultReplan` from `../interface.js`; `HealthAssessment`, `DiagnosisResult` from `../../types/index.js`.
- Produces: `export class IacDriftAgent implements RecoveryAgent` (constructor `(backend: IacDriftBackend)`); finding sources `iac_resource_missing`, `iac_attribute_drift`, `iac_state_stale`, `iac_state_unreadable`; health signal source `iac_state` plus per-resource signals carrying `entityId`.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/iac-drift-agent.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { IacDriftAgent } from '../agent/iac-drift/agent.js';
import { IacDriftSimulator } from '../agent/iac-drift/simulator.js';
import type { AgentContext } from '../types/index.js';

const context = {
  trigger: { type: 'health_check', source: 'test', payload: {}, receivedAt: new Date().toISOString() },
} as AgentContext; // mirror how src/__tests__/ existing agent tests build contexts — copy their helper if one exists

describe('IacDriftAgent.assessHealth', () => {
  it('drifted: unhealthy, with entityIds on resource signals', async () => {
    const agent = new IacDriftAgent(new IacDriftSimulator('drifted'));
    const health = await agent.assessHealth(context);
    expect(health.status).toBe('unhealthy'); // a Terraform-managed bucket is GONE
    const missing = health.signals.find((s) => s.source === 'iac_resource_missing');
    expect(missing).toMatchObject({ status: 'critical', entityId: 'user-uploads' });
    const drift = health.signals.find((s) => s.source === 'iac_attribute_drift');
    expect(drift).toMatchObject({ status: 'warning', entityId: 'prod-db' });
    expect(drift!.detail).toContain('instance_class');
    expect(drift!.detail).toContain('db.t3.large');
  });

  it('aligned: healthy', async () => {
    const agent = new IacDriftAgent(new IacDriftSimulator('aligned'));
    expect((await agent.assessHealth(context)).status).toBe('healthy');
  });

  it('state_unreadable: unknown, never a guess', async () => {
    const agent = new IacDriftAgent(new IacDriftSimulator('state_unreadable'));
    const health = await agent.assessHealth(context);
    expect(health.status).toBe('unknown');
    expect(health.signals.find((s) => s.source === 'iac_state')!.detail).toContain('could not');
  });
});

describe('IacDriftAgent.diagnose', () => {
  it('drifted: emits missing + drift findings with resource data', async () => {
    const agent = new IacDriftAgent(new IacDriftSimulator('drifted'));
    const d = await agent.diagnose(context);
    expect(d.scenario).toBe('resource_missing'); // missing outranks drift
    const missing = d.findings.find((f) => f.source === 'iac_resource_missing')!;
    expect(missing.severity).toBe('critical');
    expect(missing.data).toMatchObject({ resourceType: 'aws_s3_bucket', resourceId: 'user-uploads' });
    const drift = d.findings.find((f) => f.source === 'iac_attribute_drift')!;
    expect(drift.severity).toBe('warning');
    expect(drift.observation).toContain('terraform apply'); // names the direction of danger
    expect(drift.data).toMatchObject({ resourceId: 'prod-db' });
  });

  it('state_unreadable: single iac_state_unreadable finding, no partial output', async () => {
    const agent = new IacDriftAgent(new IacDriftSimulator('state_unreadable'));
    const d = await agent.diagnose(context);
    expect(d.findings.map((f) => f.source)).toEqual(['iac_state_unreadable']);
  });
});
```

Also extend `REPRESENTATIVE_SOURCES` in `src/__tests__/signal-explanations.test.ts` with `'iac_attribute_drift'`, `'iac_resource_missing'`, `'iac_state_unreadable'`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/__tests__/iac-drift-agent.test.ts src/__tests__/signal-explanations.test.ts` → FAIL (stub throws / no explanation entries).

- [ ] **Step 3: Implement**

`assessHealth` shape (gather once, share with diagnose via a private `collect()` returning `{ status: IacStateStatus; items: Array<{ resource; existence; drift }> }`):
- `iac_state` signal: unreadable → `warning` with detail "CrisisMode found Terraform but could not read its state: <reason>"; stale (`staleDays! > 30` or `dirtyTfFiles`) → `warning` noting the staleness caveat; otherwise `healthy` with serial + resource count.
- Per missing resource: signal `{ source: 'iac_resource_missing', status: 'critical', entityId: resource.id, detail: '<type> <id> exists in Terraform state but not in AWS' }`.
- Per drifted resource: `{ source: 'iac_attribute_drift', status: 'warning', entityId: resource.id, detail: '<type> <id>: instance_class intended db.t3.medium, observed db.t3.large (+1 more)' }` (first drift verbatim, `+N more`).
- Per `PermissionMissing` result: `{ source: 'iac_iam_permissions', status: 'warning', detail: 'cannot verify <type> <id>: IAM action <action> not allowed' }`.
- **Staleness cap:** when the state is stale, downgrade every `critical` resource signal to `warning` and append "(state may be stale — re-run after terraform refresh)" to its detail.
- Status: any critical signal → `unhealthy`; any warning resource signal → `degraded`; state unreadable/none → `unknown`; else `healthy`. Confidence 0.9 (0.5 when stale). `recommendedActions`: `['Run terraform plan to confirm what apply would change']` when drift/missing exist.

`diagnose` findings (same collect, `diagnosticPlanNeeded: false`):
- `iac_state_unreadable` (severity `warning`) — ONLY finding when unreadable.
- `iac_state_stale` (severity `info`) when stale and readable.
- `iac_resource_missing` — `critical` for types in `WATCHABLE_TF_TYPES`, `warning` otherwise (stale cap applies); observation "`<type>` `<id>` is recorded in Terraform state but no longer exists in AWS. If it was deleted on purpose, remove it from your Terraform config; if not, `terraform apply` can recreate it."; data `{ resourceType, resourceId, region }`.
- `iac_attribute_drift` — `warning`; observation "`<type>` `<id>` was changed outside Terraform (<first drift: attribute intended → observed>). The next `terraform apply` would revert this change."; data `{ resourceType, resourceId, drifts, comparedAttributes, intendedAttributeCount }`.
- scenario priority: `resource_missing` > `attribute_drift` > `state_stale` > `state_unreadable`; confidence 0.9 / 0.5 when stale.

`signal-explanations.ts` new entries (before the `backup|snapshot|pitr` entry):

```ts
{
  match: /^iac_state/,
  explanation: 'CrisisMode reads your terraform.tfstate file to learn what your infrastructure is supposed to look like. If the state is unreadable or stale, drift findings are limited or unavailable — the file, not your infrastructure, is the problem.',
  learnMoreUrl: 'https://developer.hashicorp.com/terraform/language/state',
},
{
  match: /^iac_/,
  explanation: 'Terraform records the intended shape of your infrastructure. Drift means someone changed things outside Terraform — the next terraform apply would silently revert those changes, which can undo an emergency fix.',
  learnMoreUrl: 'https://developer.hashicorp.com/terraform/tutorials/state/resource-drift',
},
```

- [ ] **Step 4: Run tests to verify they pass** → both files PASS.

- [ ] **Step 5: Full gate and commit**

```bash
pnpm test && pnpm run typecheck && pnpm run lint
git add -A && git commit -m "feat(iac-drift): health assessment and drift diagnosis with knowledge-map entries"
```

---

### Task 6: Agent — suggestion-only plan()

**Files:**
- Modify: `src/agent/iac-drift/agent.ts` (implement `plan()`)
- Test: `src/__tests__/iac-drift-plan.test.ts` (create)

**Interfaces:**
- Consumes: `createPlanEnvelope` from `../../framework/plan-helpers.js`; diagnosis findings (Task 5); model the whole method on `buildControlPlaneSuggestionPlan` in `src/agent/aws-rds/agent.ts:789` (the `pushSuggestion` idiom).
- Produces: `plan(context, diagnosis): Promise<RecoveryPlan>` — every step `diagnosis_action` or `human_notification`; `replan` stays `defaultReplan`.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/iac-drift-plan.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { IacDriftAgent } from '../agent/iac-drift/agent.js';
import { IacDriftSimulator } from '../agent/iac-drift/simulator.js';
import { validatePlan } from '../framework/validator.js';
import { iacDriftManifest } from '../agent/iac-drift/manifest.js';
import type { AgentContext } from '../types/index.js';

const context = {
  trigger: { type: 'manual', source: 'test', payload: {}, receivedAt: new Date().toISOString() },
} as AgentContext;

describe('IacDriftAgent.plan', () => {
  it('emits a suggestion-only plan: no system_action, no human_approval', async () => {
    const agent = new IacDriftAgent(new IacDriftSimulator('drifted'));
    const plan = await agent.plan(context, await agent.diagnose(context));
    expect(plan.steps.length).toBeGreaterThanOrEqual(3); // capture + >=2 suggestions
    for (const step of plan.steps) {
      expect(['diagnosis_action', 'human_notification']).toContain(step.type);
    }
  });

  it('presents the terraform-plan-first fork for attribute drift', async () => {
    const agent = new IacDriftAgent(new IacDriftSimulator('drifted'));
    const plan = await agent.plan(context, await agent.diagnose(context));
    const text = JSON.stringify(plan.steps);
    expect(text).toContain('terraform plan');            // confirm first
    expect(text).toContain('reverts the manual change'); // apply direction flagged destructive
    expect(text).toContain('update');                    // backport direction (edit .tf)
  });

  it('suggests the recreate-vs-remove fork for missing resources', async () => {
    const agent = new IacDriftAgent(new IacDriftSimulator('drifted'));
    const plan = await agent.plan(context, await agent.diagnose(context));
    const text = JSON.stringify(plan.steps);
    expect(text).toContain('user-uploads');
    expect(text).toContain('recreate');
  });

  it('passes the plan validator', async () => {
    const agent = new IacDriftAgent(new IacDriftSimulator('drifted'));
    const plan = await agent.plan(context, await agent.diagnose(context));
    const result = validatePlan(plan, iacDriftManifest); // ValidationResult { valid, checks }
    expect(result.checks.filter((c) => !c.passed)).toEqual([]);
    expect(result.valid).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** → FAIL (stub throws).

- [ ] **Step 3: Implement `plan()`**

Mirror `buildControlPlaneSuggestionPlan` (`src/agent/aws-rds/agent.ts:789-870`):
- step-001 `diagnosis_action`: operation `scan_iac_drift`, executionContext `iac_read`, target `'terraform-state'`, outputCapture `current_iac_drift_state`.
- `pushSuggestion(summary, detail)` helper identical in shape to aws-rds's (human_notification, on_call_engineer, high urgency, contextReferences `['current_iac_drift_state']`, actionRequired true).
- Per `iac_attribute_drift` finding: summary `` `Out-of-band change on ${resourceId}` ``; detail: "`<type>` `<id>` differs from Terraform's intent: <drift list>. Confirm first: run `terraform plan` (read-only). Then choose: **Option A — keep the live change:** update the `<type>.<name>` block in your .tf so the next apply doesn't revert it (backports the manual change). **Option B — restore Terraform's intent:** run `terraform apply` — WARNING: this reverts the manual change; if it was an emergency fix, applying undoes it."
- Per `iac_resource_missing` finding: summary `` `Terraform-managed ${resourceId} no longer exists` ``; detail: "Confirm with `terraform plan`. If the deletion was intentional, remove the `<type>.<name>` block (or `terraform state rm <type>.<name>`) so Terraform stops managing it. If not, `terraform apply` can recreate it — review the plan output first; recreation may not restore data."
- Per `iac_state_stale` / `iac_state_unreadable`: one suggestion to run `terraform refresh`/`terraform init` (operator-run, spelled out).
- Envelope: `createPlanEnvelope({ planIdSuffix: 'iac-drift', agentName: 'iac-drift-recovery', agentVersion: '1.0.0', scenario: diagnosis.scenario ?? 'attribute_drift', estimatedDuration: 'PT5M', summary: ... })`; impact block with `dataLossRisk: 'none'`, estimatedUserImpact "No action is taken by CrisisMode — suggestions only."; rollbackStrategy `{ type: 'stepwise', description: 'Read-only plan: CrisisMode executes nothing that needs rolling back. All reconciliation is operator-run terraform.' }`.

- [ ] **Step 4: Run test to verify it passes** → PASS.

- [ ] **Step 5: Full gate and commit**

```bash
pnpm test && pnpm run typecheck && pnpm run lint
git add -A && git commit -m "feat(iac-drift): suggestion-only reconciliation plans with the apply-vs-backport fork"
```

---

### Task 7: Live client

**Files:**
- Create: `src/agent/iac-drift/live-client.ts`
- Test: `src/__tests__/iac-drift-live-client.test.ts` (create)

**Interfaces:**
- Consumes: `discoverStateSource`, `parseTfState` (Task 1); comparators (Task 2); `IacDriftBackend` types (Task 3); `tryImportAws`, `resolveAwsCredentials`, `PermissionMissing` from `../aws-common.js`. Read `src/agent/aws-rds/live-client.ts` first and copy its idioms: lazy memoized `ensure*()` client getters, AccessDenied→PermissionMissing conversion, `close()` destroying clients.
- Produces:

```ts
export interface IacDriftLiveConfig {
  dir: string;
  /** Test seam: pre-built SDK clients; production leaves this undefined. */
  clients?: {
    s3?: { send(cmd: unknown): Promise<unknown> };
    rds?: { send(cmd: unknown): Promise<unknown> };
    dynamo?: { send(cmd: unknown): Promise<unknown> };
  };
}
export class IacDriftLiveClient implements IacDriftBackend
```

(If `src/agent/aws-rds/live-client.ts` / its tests already use a different injection seam, use that idiom instead — consistency beats this signature.)

- [ ] **Step 1: Write the failing test**

Test with no AWS at all (fixture dirs + injected fakes):

```ts
// src/__tests__/iac-drift-live-client.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IacDriftLiveClient } from '../agent/iac-drift/live-client.js';
import { isPermissionMissing } from '../agent/aws-common.js';
import { V4_STATE } from './fixtures/iac-tfstate-v4.js';

async function projectWithState(state = V4_STATE): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'iac-live-'));
  await writeFile(join(dir, 'terraform.tfstate'), state);
  return dir;
}

const accessDenied = () => Object.assign(new Error('User is not authorized'), { name: 'AccessDeniedException' });
const notFound = (name: string) => Object.assign(new Error('not found'), { name });

describe('IacDriftLiveClient state acquisition', () => {
  it('reads local state and reports staleness from mtime', async () => {
    const dir = await projectWithState();
    const old = new Date(Date.now() - 60 * 86400_000);
    await utimes(join(dir, 'terraform.tfstate'), old, old);
    const client = new IacDriftLiveClient({ dir });
    const status = await client.getStateStatus();
    expect(status).toMatchObject({ source: 'local', readable: true, serial: 42 });
    expect(status.staleDays).toBeGreaterThanOrEqual(59);
    expect((await client.listManagedResources()).length).toBeGreaterThan(0);
    await client.close();
  });

  it('reports unreadable state with the parse reason', async () => {
    const dir = await projectWithState('{corrupt');
    const client = new IacDriftLiveClient({ dir });
    const status = await client.getStateStatus();
    expect(status.readable).toBe(false);
    expect(status.reason).toContain('JSON');
    expect(await client.listManagedResources()).toEqual([]);
    await client.close();
  });
});

describe('IacDriftLiveClient existence + drift', () => {
  it('maps NotFound to missing and AccessDenied to PermissionMissing per service', async () => {
    const dir = await projectWithState();
    const client = new IacDriftLiveClient({
      dir,
      clients: {
        rds: { send: async () => { throw accessDenied(); } },
        s3: { send: async () => { throw notFound('NotFound'); } },
      },
    });
    const resources = await client.listManagedResources();
    const db = resources.find((r) => r.type === 'aws_db_instance')!;
    const bucket = resources.find((r) => r.type === 'aws_s3_bucket')!;
    const cache = resources.find((r) => r.type === 'aws_elasticache_cluster')!;

    const dbResult = await client.checkResourceExistence(db);
    expect(isPermissionMissing(dbResult) && dbResult.permissionMissing).toBe('rds:DescribeDBInstances');
    expect(await client.checkResourceExistence(bucket)).toEqual({ existence: 'missing' });
    expect(await client.checkResourceExistence(cache)).toMatchObject({ existence: 'unknown' });
    await client.close();
  });

  it('computes attribute drift from a DescribeDBInstances response', async () => {
    const dir = await projectWithState();
    const client = new IacDriftLiveClient({
      dir,
      clients: {
        rds: { send: async () => ({ DBInstances: [{
          DBInstanceIdentifier: 'prod-db', DBInstanceClass: 'db.t3.large', Engine: 'postgres',
          EngineVersion: '16.4', MultiAZ: false, BackupRetentionPeriod: 7,
          DeletionProtection: true, StorageType: 'gp3', AllocatedStorage: 20,
        }] }) },
      },
    });
    const db = (await client.listManagedResources()).find((r) => r.type === 'aws_db_instance')!;
    const drift = await client.getResourceDrift(db);
    expect(drift).toMatchObject({
      drifts: [{ attribute: 'instance_class', intended: 'db.t3.medium', observed: 'db.t3.large' }],
    });
    await client.close();
  });

  it('returns null drift for types outside the deep trio', async () => {
    const dir = await projectWithState();
    const client = new IacDriftLiveClient({ dir });
    const cache = (await client.listManagedResources()).find((r) => r.type === 'aws_elasticache_cluster')!;
    expect(await client.getResourceDrift(cache)).toBeNull();
    await client.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails** → FAIL.

- [ ] **Step 3: Implement `src/agent/iac-drift/live-client.ts`**

- **State loading** (memoized promise `private loaded?: Promise<{ status: IacStateStatus; resources: IacResource[] }>`):
  - `discoverStateSource(this.cfg.dir)`;
  - `local` → `readFile` + `stat().mtime` → `staleDays = Math.floor((Date.now() - mtime) / 86400_000)`;
  - `s3-backend` → STS pre-flight via `resolveAwsCredentials({ region })` (invalid → status `readable: false`, reason from the credential result, detail names bucket/key); then `tryImportAws<typeof import('@aws-sdk/client-s3')>('@aws-sdk/client-s3')` (null → unreadable, reason "@aws-sdk/client-s3 is not installed"); `GetObjectCommand` → body text + `LastModified`; AccessDenied → unreadable with reason naming `s3:GetObject` on the state bucket;
  - `unsupported-backend` / `none` → `readable: false` with the backend type / "no Terraform state found" as reason; resources `[]`.
  - `parseTfState` failure → `readable: false`, reason from the parse result.
  - `dirtyTfFiles`: `execFile('git', ['status', '--porcelain', '--', '*.tf'], { cwd: dir })` — non-empty stdout → true; any error → undefined (not a lie, just unknown). Use `node:child_process` `execFile` promisified, same as `src/agent/config-drift/live-client.ts` does for git.
- **Clients:** lazy `ensureRds()/ensureS3()/ensureDynamo()` — return the injected test client when `cfg.clients` provides one, else `tryImportAws` + construct with the resource's region (fall back to the state-backend region, then `AWS_REGION`). SDK absent → the check returns `{ existence: 'unknown', reason: '@aws-sdk/client-<x> is not installed' }`.
- **AccessDenied mapping:** copy the aws-rds live-client's error classifier; map to `{ permissionMissing: '<action>' }` with actions `rds:DescribeDBInstances`, `s3:ListBucket` (HeadBucket), `s3:GetBucketVersioning`, `dynamodb:DescribeTable`, `dynamodb:DescribeContinuousBackups`.
- **Existence:** `aws_db_instance` → `DescribeDBInstances({ DBInstanceIdentifier: id })`, `DBInstanceNotFoundFault` → missing. `aws_s3_bucket` → `HeadBucketCommand`, error name `NotFound`/`NoSuchBucket` or `$metadata.httpStatusCode === 404` → missing. `aws_dynamodb_table` → `DescribeTable`, `ResourceNotFoundException` → missing. Everything else → `{ existence: 'unknown', reason: 'no existence check for <type> yet' }`.
- **Drift:** trio only, `null` otherwise. RDS: map the `DBInstances[0]` fields (as in the test above) into `ObservedRdsFacts` → `compareRdsInstance`. S3: `GetBucketVersioning` (`Status === 'Enabled'`) + `GetBucketLifecycleConfiguration` (throws `NoSuchLifecycleConfiguration` → false) → `compareS3Bucket(resource, allResources, observed)`. DynamoDB: `DescribeTable` (`BillingModeSummary?.BillingMode ?? 'PROVISIONED'`) + `DescribeContinuousBackups` (PITR status) → `compareDynamoTable`.
- `executeCommand` (`scan_iac_drift` → `{ stateStatus, resourceCount }`) and `evaluateCheck` (`iac_drift_count`/`iac_missing_count`/`iac_state_readable`) recompute from the memoized load. `close()` destroys any constructed SDK clients (skip injected ones).

- [ ] **Step 4: Run test to verify it passes** → PASS.

- [ ] **Step 5: Full gate and commit**

```bash
pnpm test && pnpm run typecheck && pnpm run lint
git add -A && git commit -m "feat(iac-drift): live client — local/S3 state acquisition and per-check IAM degradation"
```

---

### Task 8: Autodiscovery target + visibility integration

**Files:**
- Modify: `src/cli/autodiscovery.ts` — new exported `deriveIacDetection(cwd)`; `StackProfile.iacDetection?`; wire into `discoverStack()` (~line 430) alongside the gated/RDS derivations
- Modify: `src/cli/visibility.ts` — consume `profile.iacDetection`
- Modify: `src/cli/commands/scan.ts` `iamBlockedEntries` (~line 486) — also lift iac signals into blocked entries (see Step 3)
- Test: `src/__tests__/iac-discovery.test.ts` (create); extend `src/__tests__/visibility.test.ts` (exists — check the name with `ls src/__tests__/ | grep visib` and extend whichever file covers `buildVisibilityReport`); extend the file covering `iamBlockedEntries` (find with `grep -rln iamBlockedEntries src/__tests__/`)

**Interfaces:**
- Consumes: `discoverStateSource`, `parseTfState`, `WATCHABLE_TF_TYPES` (Task 1).
- Produces:

```ts
// autodiscovery.ts additions
export interface IacDetection {
  stateSource: 'local' | 's3-backend' | 'unsupported-backend' | 'none';
  backendType?: string;                    // when unsupported
  /** Managed types in local state with no CrisisMode agent, with counts. */
  unwatchableTypes: Record<string, number>;
}
export async function deriveIacDetection(cwd: string): Promise<{
  target: TargetConfig | null;
  note: string | null;
  iacDetection: IacDetection | null;      // null = no Terraform in this project
}>;
// StackProfile gains: iacDetection?: IacDetection;
```

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/iac-discovery.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveIacDetection } from '../cli/autodiscovery.js';
import { V4_STATE } from './fixtures/iac-tfstate-v4.js';

describe('deriveIacDetection', () => {
  it('derives an iac-drift target when terraform files exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iac-disc-'));
    await writeFile(join(dir, 'terraform.tfstate'), V4_STATE);
    const r = await deriveIacDetection(dir);
    expect(r.target).toMatchObject({ name: 'derived-iac-drift', kind: 'iac-drift', iac: { dir } });
    expect(r.note).toContain('Terraform');
    expect(r.iacDetection).toMatchObject({ stateSource: 'local' });
    expect(r.iacDetection!.unwatchableTypes).toEqual({ aws_elasticache_cluster: 1 });
  });

  it('derives a target from .tf files even without readable state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iac-disc-'));
    await writeFile(join(dir, 'main.tf'), 'resource "aws_s3_bucket" "b" {}');
    const r = await deriveIacDetection(dir);
    expect(r.target).not.toBeNull();
    expect(r.iacDetection!.stateSource).toBe('none');
  });

  it('returns all-null for a project without terraform', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iac-disc-'));
    const r = await deriveIacDetection(dir);
    expect(r).toEqual({ target: null, note: null, iacDetection: null });
  });
});
```

Visibility assertions (add to the existing `buildVisibilityReport` test file):

```ts
it('lists unwatchable Terraform-managed types as invisible', () => {
  const profile = baseProfile(); // reuse the file's existing StackProfile factory
  profile.iacDetection = { stateSource: 'local', unwatchableTypes: { aws_elasticache_cluster: 2 } };
  const report = buildVisibilityReport(profile, ['iac-drift'], 'none');
  expect(report.invisible).toContainEqual(expect.objectContaining({
    label: 'aws_elasticache_cluster',
    detail: expect.stringContaining('2'),
  }));
});

it('reports unsupported state backends as blocked', () => {
  const profile = baseProfile();
  profile.iacDetection = { stateSource: 'unsupported-backend', backendType: 'remote', unwatchableTypes: {} };
  const report = buildVisibilityReport(profile, [], 'none');
  expect(report.blocked).toContainEqual(expect.objectContaining({
    label: 'iac-drift (remote state)',
    detail: expect.stringContaining('remote'),
  }));
});
```

- [ ] **Step 2: Run tests to verify they fail** → FAIL.

- [ ] **Step 3: Implement**

`deriveIacDetection(cwd)`: `discoverStateSource(cwd)`; also check for any root `*.tf` via `readdir`. No state AND no `.tf` → all-null. Otherwise target `{ name: 'derived-iac-drift', kind: 'iac-drift', primary: { host: 'auto', port: 0 }, iac: { dir: cwd } }`, note `'from Terraform files in this project'`. `unwatchableTypes`: only when the source is local — read + `parseTfState`, count types whose base type is missing from `WATCHABLE_TF_TYPES`, skipping sub-resource types (`aws_s3_bucket_versioning`, `aws_s3_bucket_lifecycle_configuration` — they belong to a watchable bucket). S3-backend state is NOT fetched here — autodiscovery must stay fast and offline; the agent fetches at check time.

`iamBlockedEntries` in `scan.ts` (which already lifts `rds_iam_permissions` signals into blocked entries) gains two more lifts, so runtime state failures reach the visibility section:
- signals with `source === 'iac_iam_permissions'` → blocked entry `{ label: 'iac-drift permissions', detail: signal.detail, hint: 'Grant the listed IAM action (read-only) so CrisisMode can compare Terraform intent against live AWS.' }`
- signals with `source === 'iac_state'` whose detail contains `'could not read'` → blocked entry `{ label: 'iac-drift (state unreadable)', detail: signal.detail, hint: 'CrisisMode needs to read terraform.tfstate (s3:GetObject on the state bucket for S3 backends). Drift checks are unavailable until it can.' }`

Test both lifts in the file that already covers `iamBlockedEntries`, following its existing test style with fake findings arrays.

`discoverStack()`: `const iac = await deriveIacDetection(cwd);` → append `iac.target` to `derivedTargets` (and its note), set `iacDetection: iac.iacDetection ?? undefined` on the returned profile. Missing AWS credentials do NOT suppress the target (local state is still readable) — this mirrors the spec, differing deliberately from `deriveAwsRdsTargets`.

`visibility.ts`, after the AWS-detection blocks:

```ts
if (profile.iacDetection) {
  const iac = profile.iacDetection;
  if (iac.stateSource === 'unsupported-backend') {
    blocked.push({
      label: 'iac-drift (remote state)',
      detail: `Terraform state lives in a "${iac.backendType ?? 'unknown'}" backend CrisisMode cannot read yet`,
      hint: 'CrisisMode reads local terraform.tfstate and S3 backends. Drift checks are unavailable for this project until then.',
    });
  }
  for (const [tfType, count] of Object.entries(iac.unwatchableTypes)) {
    invisible.push({
      label: tfType,
      detail: `your Terraform manages ${count} ${tfType} resource${count === 1 ? '' : 's'} — CrisisMode has no agent for this type yet, so only its existence in state is known`,
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass** → PASS.

- [ ] **Step 5: Full gate and commit**

```bash
pnpm test && pnpm run typecheck && pnpm run lint
git add -A && git commit -m "feat(cli): derive iac-drift targets and surface Terraform coverage in visibility"
```

---

### Task 9: Correlation rule with shared-entity matching

**Files:**
- Modify: `src/framework/symptom-router.ts` (`SymptomSignal` gains `entityId?: string | undefined`)
- Modify: `src/framework/health-to-signals.ts` (pass `entityId` through; add `config_mismatch` pattern)
- Modify: `src/framework/root-cause-synthesis.ts` (`AgentEvidence.entityIds?`; `CorrelationRule.requireSharedEntityId?`; matching logic; new rule)
- Modify: `src/cli/commands/scan.ts` `buildScanEvidence` (~line 117) — collect `entityIds` from health signals
- Modify: `src/agent/aws-rds/agent.ts` `assessHealth` — set `entityId` (the instance id it already knows) on the signals it emits
- Test: extend `src/__tests__/root-cause-synthesis.test.ts`

**Interfaces:**
- Consumes: `HealthSignal.entityId` (Task 5); iac-drift signals already carry `entityId` (Task 5).
- Produces: rule `iac-out-of-band-change`; `AgentEvidence.entityIds?: string[]`.

- [ ] **Step 1: Write the failing test** (add to `src/__tests__/root-cause-synthesis.test.ts`, reusing its existing evidence-builder helpers)

```ts
describe('iac-out-of-band-change rule', () => {
  const iacEvidence = (entityIds: string[]): AgentEvidence => ({
    agentKind: 'iac-drift', targetName: 'derived-iac-drift', entityIds,
    signals: [{ type: 'config_mismatch', source: 'iac_attribute_drift', detail: 'aws_db_instance prod-db: instance_class drift', severity: 'warning' }],
  });
  const rdsEvidence = (entityIds: string[]): AgentEvidence => ({
    agentKind: 'aws-rds', targetName: 'rds-us-east-1-prod-db', entityIds,
    signals: [{ type: 'resource_exhaustion', source: 'rds_storage', detail: 'FreeStorageSpace critically low', severity: 'critical' }],
  });

  it('fires when iac-drift and aws-rds report the same instance', () => {
    const result = synthesizeByRules([iacEvidence(['prod-db']), rdsEvidence(['prod-db'])]);
    const cluster = result.clusters.find((c) => c.reasoning.includes('iac-out-of-band-change'));
    expect(cluster).toBeDefined();
    expect(cluster!.investigationOrder[0]).toBe('iac-drift');
  });

  it('does NOT fire when the drifted resource is a different instance', () => {
    const result = synthesizeByRules([iacEvidence(['other-db']), rdsEvidence(['prod-db'])]);
    expect(result.clusters.find((c) => c.reasoning.includes('iac-out-of-band-change'))).toBeUndefined();
  });

  it('does NOT fire when either side lacks entity ids (no guessing)', () => {
    const result = synthesizeByRules([iacEvidence([]), rdsEvidence(['prod-db'])]);
    expect(result.clusters.find((c) => c.reasoning.includes('iac-out-of-band-change'))).toBeUndefined();
  });
});
```

Also assert in a `healthToSignals` test (same file or its own) that a signal `{ source: 'iac_attribute_drift', status: 'warning', detail: 'aws_db_instance prod-db drifted from Terraform intent', entityId: 'prod-db', observedAt: ... }` maps to `{ type: 'config_mismatch', entityId: 'prod-db' }`.

- [ ] **Step 2: Run tests to verify they fail** → FAIL.

- [ ] **Step 3: Implement**

`health-to-signals.ts`: add `{ match: /drift|out-of-band|intended|mismatch/i, type: 'config_mismatch' }` to `TYPE_PATTERNS` **before** the `error rate|failing|failed` entry (drift text often contains neither, but must win when both match); copy `entityId` onto the emitted signal: `...(sig.entityId !== undefined ? { entityId: sig.entityId } : {})`.

`root-cause-synthesis.ts`:
- `AgentEvidence` gains `entityIds?: string[]`.
- `CorrelationRule` gains `requireSharedEntityId?: boolean` with a doc comment: fires only when ≥2 matched agents report a common entity id; agents with no ids fail the requirement — the rule prefers silence over a guessed pairing (the Arc 2 co-firing lesson).
- In `synthesizeByRules`, after the `signalMatches < 2` check:

```ts
if (rule.requireSharedEntityId) {
  const idSets = matchingAgents.map((a) => new Set(a.entityIds ?? []));
  const shared = [...(idSets[0] ?? [])].some((id) => idSets.every((s) => s.has(id)));
  if (!shared) continue;
}
```

- New rule appended to `CORRELATION_RULES`:

```ts
{
  name: 'iac-out-of-band-change',
  agentKinds: ['iac-drift', 'aws-rds'],
  sharedSignalTypes: ['config_mismatch', 'resource_exhaustion', 'connection', 'timeout', 'error_rate'],
  // iac-drift counts only on an actual drift signal; aws-rds on any of its
  // platform signals. Same-entity matching below is what makes the pairing safe.
  requiredTypesByKind: { 'iac-drift': ['config_mismatch'] },
  requireSharedEntityId: true,
  sharedPatterns: [],
  rootCauseTemplate: 'The degraded RDS instance was changed outside Terraform — the out-of-band change is the likely cause; reconcile it (terraform plan first) before deeper platform debugging',
  investigationOrder: ['iac-drift', 'aws-rds'],
  confidenceBoost: 0.3,
},
```

`scan.ts` `buildScanEvidence`: in the assessed branch, add `entityIds: [...new Set(r.health.signals.map((s) => s.entityId).filter((x): x is string => typeof x === 'string'))]` (omit the property when empty).

`aws-rds/agent.ts` `assessHealth`: additive — every signal it builds that concerns the instance gets `entityId: <instanceId>` (the method already has the id in scope; if a helper builds the signals, thread it through).

- [ ] **Step 4: Run tests to verify they pass**, then the full suite (the aws-rds signal change must not break its existing tests) → PASS.

- [ ] **Step 5: Full gate and commit**

```bash
pnpm test && pnpm run typecheck && pnpm run lint
git add -A && git commit -m "feat(synthesis): iac-out-of-band-change rule with shared-entity-id matching"
```

---

### Task 10: Docs + real-surface verification

**Files:**
- Modify: `CLAUDE.md` (Key Files table: `src/agent/iac-drift/` row "Terraform drift detection agent (intended vs. observed)")
- Modify: `docs/architecture.md` and `README.md` — run `grep -n "aws-rds" README.md docs/architecture.md docs/*.md` and add an equivalent iac-drift line wherever agents are enumerated
- No new test files — this task's verification is the real surface.

- [ ] **Step 1: Docs**

Add the agent everywhere agents are listed (grep as above). Keep descriptions to one line, matching each file's existing style. Commit:

```bash
git add -A && git commit -m "docs: register the iac-drift agent in architecture and agent listings"
```

- [ ] **Step 2: Real-surface verify (use the project `verify` skill)**

Build the bundle first (per the verify skill), then drive the built CLI against a scratch project — no AWS credentials needed:

```bash
SCRATCH=$(mktemp -d)
# Write a local state file from the shared fixture (single source of truth):
node --input-type=module -e "
  import { V4_STATE } from './src/__tests__/fixtures/iac-tfstate-v4.ts';
  import { writeFileSync } from 'node:fs';
  writeFileSync(process.argv[1], V4_STATE);
" "$SCRATCH/terraform.tfstate"
# (If node can't load .ts directly in this environment, copy the JSON out of
#  src/__tests__/fixtures/iac-tfstate-v4.ts into the file by hand — same content.)
cd "$SCRATCH" && node <path-to-built-crisismode> scan
```

Confirm, keylessly:
1. Scan discovers and runs the `iac-drift` agent (a finding row with the `IAC` prefix appears).
2. With no AWS SDK reachability/credentials, resource checks degrade to `unknown` with honest reasons — no crash, no fake "missing".
3. The visibility section shows `aws_elasticache_cluster` under invisible.
4. `scan --json` includes the new findings and visibility entries (additive only).
5. `crisismode demo` (or the simulator path via a target with `iac: { dir: simulator }` in a scratch `crisismode.yaml`) renders the drift findings and the suggestion plan text with the apply-vs-backport fork.

Record actual command output in the PR description (the verify skill's honesty contract).

- [ ] **Step 3: Full gate**

```bash
pnpm test && pnpm run typecheck && pnpm run lint
```

- [ ] **Step 4: Finish the branch**

Push, open the PR (rebase-merge convention; CodeRabbit will review — verify its findings on the merits before fixing):

```bash
git push -u origin feat/iac-drift
gh pr create --title "feat: iac-drift agent — Terraform drift detection (Arc 3)" --body "..."
```
