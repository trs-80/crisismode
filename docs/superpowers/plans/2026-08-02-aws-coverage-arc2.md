# AWS Coverage Arc 2: RDS Control-Plane Diagnosis — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect RDS endpoints in connection strings, auto-run read-only control-plane diagnosis (instance health, events, CloudWatch metrics, security-group facts) through the existing `aws-rds` agent, and surface suggestions in AWS-console terms.

**Architecture:** Extend, don't add: the existing `aws-rds` agent gains live-health backend methods (simulator + live client), autodiscovery gains an RDS endpoint parser that derives `aws-rds` targets when credentials exist, visibility (Arc 1) reports Aurora/no-creds/missing-IAM cases, and two new correlation rules link RDS control-plane findings to data-plane pg failures. All AWS calls are read-only; plans stop at suggestions.

**Tech Stack:** TypeScript strict/ESM (`.js` import extensions, named exports), vitest, AWS SDK v3 via the existing `tryImportAws` dynamic-import pattern. Two new deps: `@aws-sdk/client-cloudwatch`, `@aws-sdk/client-ec2`.

**Spec:** `docs/superpowers/specs/2026-08-02-aws-coverage-arc2-design.md`

## Global Constraints

- ALL AWS API usage read-only: `Describe*`, `GetMetricData`, `GetCallerIdentity`. Never a mutating call, never a `system_action` step against AWS APIs.
- Zero-config auto-run: RDS endpoint detected + AWS creds present → checks run in scan; every state (no creds, Aurora, missing IAM) surfaces honestly in the Arc 1 visibility section with an actionable hint.
- New SDK packages load only via `tryImportAws` (dynamic import, graceful null when absent).
- Machine (`--json`) output changes strictly additive.
- TDD per task: failing test → verify RED → minimal code → verify GREEN → commit. Before each commit: `pnpm test && pnpm run typecheck && pnpm run lint`.
- Conventional commits. Branch: `feat/aws-rds-control-plane` (create from the docs branch containing this plan at Task 1 Step 1, or from main if this plan is already merged).
- Match surrounding code style; comments only for non-obvious constraints.

---

### Task 1: RDS endpoint parser

**Files:**
- Create: `src/cli/aws-endpoint.ts`
- Test: `src/__tests__/aws-endpoint.test.ts` (create)

**Interfaces:**
- Produces:

```ts
export interface RdsEndpointInfo {
  type: 'instance' | 'cluster' | 'proxy';
  /** DB instance identifier (first hostname label) — instance type only */
  instanceId?: string;
  region: string;
  host: string;
}
export function parseRdsEndpoint(host: string): RdsEndpointInfo | null
```

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/aws-endpoint.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { parseRdsEndpoint } from '../cli/aws-endpoint.js';

describe('parseRdsEndpoint', () => {
  it('parses an instance endpoint into id + region', () => {
    expect(parseRdsEndpoint('mydb.c9akciq32rza.us-east-1.rds.amazonaws.com')).toEqual({
      type: 'instance',
      instanceId: 'mydb',
      region: 'us-east-1',
      host: 'mydb.c9akciq32rza.us-east-1.rds.amazonaws.com',
    });
  });

  it('recognises an Aurora cluster endpoint without an instanceId', () => {
    const r = parseRdsEndpoint('prod.cluster-c9akciq32rza.eu-west-2.rds.amazonaws.com');
    expect(r).toMatchObject({ type: 'cluster', region: 'eu-west-2' });
    expect(r!.instanceId).toBeUndefined();
  });

  it('recognises a cluster reader endpoint as cluster', () => {
    expect(parseRdsEndpoint('prod.cluster-ro-c9akciq32rza.us-west-2.rds.amazonaws.com'))
      .toMatchObject({ type: 'cluster', region: 'us-west-2' });
  });

  it('recognises an RDS Proxy endpoint', () => {
    expect(parseRdsEndpoint('myproxy.proxy-c9akciq32rza.us-east-2.rds.amazonaws.com'))
      .toMatchObject({ type: 'proxy', region: 'us-east-2' });
  });

  it('returns null for non-RDS hosts', () => {
    expect(parseRdsEndpoint('db.example.com')).toBeNull();
    expect(parseRdsEndpoint('localhost')).toBeNull();
    expect(parseRdsEndpoint('rds.amazonaws.com')).toBeNull();
    expect(parseRdsEndpoint('mydb.c9akciq32rza.us-east-1.rds.amazonaws.com.evil.com')).toBeNull();
  });

  it('handles gov/long region names', () => {
    expect(parseRdsEndpoint('x.abc123.us-gov-west-1.rds.amazonaws.com'))
      .toMatchObject({ type: 'instance', region: 'us-gov-west-1' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/aws-endpoint.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/cli/aws-endpoint.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * RDS endpoint recognition. Pure string parsing — a host that doesn't match
 * simply returns null; there are no throw paths.
 *
 * Endpoint shapes (aws partition only; .amazonaws.com.cn is out of scope):
 *   instance: <identifier>.<hash>.<region>.rds.amazonaws.com
 *   cluster:  <name>.cluster-<hash>.<region>.rds.amazonaws.com  (also cluster-ro-, cluster-custom-)
 *   proxy:    <name>.proxy-<hash>.<region>.rds.amazonaws.com
 */

export interface RdsEndpointInfo {
  type: 'instance' | 'cluster' | 'proxy';
  instanceId?: string;
  region: string;
  host: string;
}

const RDS_HOST = /^([a-z0-9-]+)\.([a-z0-9-]+)\.([a-z]{2}(?:-[a-z]+)+-\d)\.rds\.amazonaws\.com$/i;

export function parseRdsEndpoint(host: string): RdsEndpointInfo | null {
  const m = RDS_HOST.exec(host);
  if (!m) return null;
  const [, first, second, region] = m;

  if (second!.startsWith('cluster-')) return { type: 'cluster', region: region!, host };
  if (second!.startsWith('proxy-')) return { type: 'proxy', region: region!, host };
  return { type: 'instance', instanceId: first!, region: region!, host };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/aws-endpoint.test.ts` → PASS

- [ ] **Step 5: Full gate and commit**

```bash
pnpm test && pnpm run typecheck && pnpm run lint
git add -A && git commit -m "feat(cli): RDS endpoint parser (instance/cluster/proxy recognition)"
```

---

### Task 2: Autodiscovery derives aws-rds targets

**Files:**
- Modify: `src/cli/autodiscovery.ts` (`StackProfile` interface ~line 35; `discoverStack`'s derived-target assembly — find the `derivedTargets = [...buildTargetsFromEnvHints(envHints), ...gated.targets]` block ~line 372)
- Test: `src/__tests__/aws-rds-discovery.test.ts` (create)

**Interfaces:**
- Consumes: `parseRdsEndpoint` (Task 1); `parseConnectionString`, `EnvHint`, `TargetConfig` already in autodiscovery/schema; `TargetConfig.aws?: { region, instanceId?, ... }` from `src/config/schema.ts:46`.
- Produces:

```ts
// added to StackProfile (all optional/additive):
awsDetection?: {
  /** Aurora cluster/proxy endpoints seen (not diagnosable this arc) */
  unsupportedEndpoints: Array<{ host: string; type: 'cluster' | 'proxy' }>;
  /** RDS instance endpoints seen while no AWS credentials were detected */
  uncredentialedHosts: string[];
};
// exported pure helper:
export function deriveAwsRdsTargets(
  hints: EnvHint[],
  env: NodeJS.ProcessEnv,
  hasAwsCredentials: boolean,
): { targets: TargetConfig[]; notes: Record<string, string>; awsDetection: NonNullable<StackProfile['awsDetection']> }
```

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/aws-rds-discovery.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { deriveAwsRdsTargets } from '../cli/autodiscovery.js';
import type { EnvHint } from '../cli/autodiscovery.js';

const dbHint: EnvHint = { name: 'DATABASE_URL', present: true, kind: 'database_url', inferredService: 'postgresql' };

describe('deriveAwsRdsTargets', () => {
  it('derives an aws-rds target from an RDS instance endpoint when creds exist', () => {
    const env = { DATABASE_URL: 'postgres://u:p@mydb.c9akciq32rza.us-east-1.rds.amazonaws.com:5432/app' };
    const r = deriveAwsRdsTargets([dbHint], env, true);
    expect(r.targets).toHaveLength(1);
    expect(r.targets[0]).toMatchObject({
      kind: 'aws-rds',
      aws: { region: 'us-east-1', instanceId: 'mydb' },
    });
    expect(r.notes[r.targets[0]!.name]).toContain('DATABASE_URL');
  });

  it('records the host as uncredentialed instead when creds are absent', () => {
    const env = { DATABASE_URL: 'postgres://u:p@mydb.c9akciq32rza.us-east-1.rds.amazonaws.com:5432/app' };
    const r = deriveAwsRdsTargets([dbHint], env, false);
    expect(r.targets).toHaveLength(0);
    expect(r.awsDetection.uncredentialedHosts).toEqual(['mydb.c9akciq32rza.us-east-1.rds.amazonaws.com']);
  });

  it('records Aurora cluster endpoints as unsupported, never as targets', () => {
    const env = { DATABASE_URL: 'postgres://u:p@prod.cluster-c9akciq32rza.us-east-1.rds.amazonaws.com:5432/app' };
    const r = deriveAwsRdsTargets([dbHint], env, true);
    expect(r.targets).toHaveLength(0);
    expect(r.awsDetection.unsupportedEndpoints).toEqual([
      { host: 'prod.cluster-c9akciq32rza.us-east-1.rds.amazonaws.com', type: 'cluster' },
    ]);
  });

  it('ignores non-RDS hosts entirely', () => {
    const env = { DATABASE_URL: 'postgres://u:p@localhost:5432/app' };
    const r = deriveAwsRdsTargets([dbHint], env, true);
    expect(r.targets).toHaveLength(0);
    expect(r.awsDetection.unsupportedEndpoints).toHaveLength(0);
    expect(r.awsDetection.uncredentialedHosts).toHaveLength(0);
  });

  it('dedupes multiple env vars pointing at the same instance', () => {
    const env = {
      DATABASE_URL: 'postgres://u:p@mydb.c9akciq32rza.us-east-1.rds.amazonaws.com:5432/app',
      POSTGRES_URL: 'postgres://u:p@mydb.c9akciq32rza.us-east-1.rds.amazonaws.com:5432/app',
    };
    const pgHint: EnvHint = { name: 'POSTGRES_URL', present: true, kind: 'database_url', inferredService: 'postgresql' };
    const r = deriveAwsRdsTargets([dbHint, pgHint], env, true);
    expect(r.targets).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/aws-rds-discovery.test.ts`
Expected: FAIL — `deriveAwsRdsTargets` is not exported.

- [ ] **Step 3: Implement**

In `src/cli/autodiscovery.ts`: add the `awsDetection` field to `StackProfile`
(optional, exactly as in Interfaces above); import `parseRdsEndpoint` from
`./aws-endpoint.js`; add:

```ts
/**
 * Derive aws-rds control-plane targets from RDS endpoints found in
 * connection-string env vars. Aurora/proxy endpoints and endpoints seen
 * without AWS credentials are recorded for visibility instead of targeted.
 * SECURITY: never logs connection-string values.
 */
export function deriveAwsRdsTargets(
  hints: EnvHint[],
  env: NodeJS.ProcessEnv,
  hasAwsCredentials: boolean,
): { targets: TargetConfig[]; notes: Record<string, string>; awsDetection: NonNullable<StackProfile['awsDetection']> } {
  const targets: TargetConfig[] = [];
  const notes: Record<string, string> = {};
  const awsDetection: NonNullable<StackProfile['awsDetection']> = {
    unsupportedEndpoints: [],
    uncredentialedHosts: [],
  };
  const seen = new Set<string>();

  for (const hint of hints) {
    if (!hint.present || hint.kind !== 'database_url') continue;
    const value = env[hint.name];
    if (!value) continue;
    const conn = parseConnectionString(value);
    if (!conn) continue;
    const endpoint = parseRdsEndpoint(conn.host);
    if (!endpoint || seen.has(endpoint.host)) continue;
    seen.add(endpoint.host);

    if (endpoint.type !== 'instance') {
      awsDetection.unsupportedEndpoints.push({ host: endpoint.host, type: endpoint.type });
      continue;
    }
    if (!hasAwsCredentials) {
      awsDetection.uncredentialedHosts.push(endpoint.host);
      continue;
    }
    const name = `rds-${endpoint.instanceId}`;
    targets.push({
      name,
      kind: 'aws-rds',
      aws: { region: endpoint.region, instanceId: endpoint.instanceId! },
    });
    notes[name] = `from ${hint.name} endpoint`;
  }
  return { targets, notes, awsDetection };
}
```

Wire into `discoverStack` where `derivedTargets`/`derivedNotes` are
assembled: compute
`const hasAwsCreds = envHints.some((h) => h.present && (h.kind === 'aws_credentials' || h.kind === 'aws_profile'));`
then
`const rds = deriveAwsRdsTargets(envHints, process.env, hasAwsCreds);`
and include `rds.targets` in `derivedTargets`, merge `rds.notes` into
`derivedNotes`, and set `awsDetection: rds.awsDetection` on the returned
profile.

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm vitest run src/__tests__/aws-rds-discovery.test.ts src/__tests__/autodiscovery.test.ts`
Expected: PASS (fix any autodiscovery test that constructs StackProfile
literals only if typecheck demands it — the new field is optional).

- [ ] **Step 5: Full gate and commit**

```bash
pnpm test && pnpm run typecheck && pnpm run lint
git add -A && git commit -m "feat(autodiscovery): derive aws-rds targets from RDS endpoints in connection strings"
```

---

### Task 3: Visibility integration for AWS detection states

**Files:**
- Modify: `src/cli/visibility.ts`
- Test: `src/__tests__/visibility.test.ts` (extend)

**Interfaces:**
- Consumes: `StackProfile.awsDetection` (Task 2).
- Produces: `buildVisibilityReport` gains an optional 4th parameter
  `extraBlocked?: VisibilityEntry[]` (appended to the blocked bucket —
  Task 9 feeds IAM-permission entries through it). Behavior changes:
  1. Aurora/proxy endpoints → blocked entry per endpoint: label
     `aws-rds (Aurora)` / `aws-rds (RDS Proxy)`, detail naming the host and
     that cluster/proxy checks aren't supported yet, hint that the
     underlying database is still checked via its connection string.
  2. Uncredentialed RDS hosts → blocked entry: detail
     `found RDS endpoint <host> but no AWS credentials`, hint naming
     `AWS_ACCESS_KEY_ID`/`AWS_PROFILE` + `AWS_REGION`.
  3. The Arc 1 generic entry ("AWS credentials detected — control-plane
     checks (RDS, ElastiCache) aren't supported yet") must NOT appear when
     an `aws-rds` kind is in `ranKinds` — it is now partially wrong; when
     creds exist and no aws-rds ran, reword it to name ElastiCache and
     other services as the remaining unsupported set.

- [ ] **Step 1: Write the failing tests** (extend `src/__tests__/visibility.test.ts`)

```ts
  it('reports Aurora endpoints as blocked with an honest hint', () => {
    const profile = profileWith({
      awsDetection: {
        unsupportedEndpoints: [{ host: 'prod.cluster-abc.us-east-1.rds.amazonaws.com', type: 'cluster' }],
        uncredentialedHosts: [],
      },
    });
    const report = buildVisibilityReport(profile, [], 'none');
    const aurora = report.blocked.find((e) => e.label.includes('Aurora'));
    expect(aurora).toBeDefined();
    expect(aurora!.detail).toContain('prod.cluster-abc');
    expect(aurora!.hint).toBeTruthy();
  });

  it('reports RDS endpoints seen without credentials', () => {
    const profile = profileWith({
      awsDetection: { unsupportedEndpoints: [], uncredentialedHosts: ['mydb.abc.us-east-1.rds.amazonaws.com'] },
    });
    const report = buildVisibilityReport(profile, [], 'none');
    const entry = report.blocked.find((e) => e.detail.includes('mydb.abc'));
    expect(entry).toBeDefined();
    expect(entry!.hint).toMatch(/AWS_ACCESS_KEY_ID|AWS_PROFILE/);
  });

  it('suppresses the generic AWS-unsupported entry when aws-rds ran', () => {
    const profile = profileWith({
      envHints: [{ name: 'AWS_ACCESS_KEY_ID', present: true, kind: 'aws_credentials' }],
    });
    const report = buildVisibilityReport(profile, ['aws-rds'], 'env-fallback');
    expect(report.blocked.find((e) => e.label === 'AWS control plane')).toBeUndefined();
  });

  it('appends extraBlocked entries to the blocked bucket', () => {
    const profile = profileWith({});
    const report = buildVisibilityReport(profile, [], 'none', [
      { label: 'aws-rds permissions', detail: 'missing rds:DescribeDBInstances', hint: 'attach AmazonRDSReadOnlyAccess' },
    ]);
    expect(report.blocked.find((e) => e.detail.includes('rds:DescribeDBInstances'))).toBeDefined();
  });
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `pnpm vitest run src/__tests__/visibility.test.ts`
Expected: the four new tests FAIL; all pre-existing ones still pass.

- [ ] **Step 3: Implement** in `src/cli/visibility.ts`: add the optional
  4th param, the two `awsDetection`-driven entry builders, the
  suppress-when-ran condition on the existing AWS entry (reword its detail
  to `AWS control-plane checks for other services (ElastiCache, Aurora) are
  not supported yet` when shown), and `blocked.push(...(extraBlocked ?? []))`
  last.

- [ ] **Step 4: Verify pass** — `pnpm vitest run src/__tests__/visibility.test.ts` → all PASS.

- [ ] **Step 5: Full gate and commit**

```bash
pnpm test && pnpm run typecheck && pnpm run lint
git add -A && git commit -m "feat(visibility): AWS detection states — aurora, missing creds, extra blocked entries"
```

---

### Task 4: Backend contract + simulator scenarios

**Files:**
- Modify: `src/agent/aws-rds/backend.ts`
- Modify: `src/agent/aws-rds/simulator.ts`
- Test: `src/__tests__/aws-rds-simulator.test.ts` (create; check first whether an aws-rds simulator test already exists and extend it instead)

**Interfaces:**
- Produces (in `backend.ts`, alongside the existing `InstanceBackupConfig`):

```ts
/** A live-client check that failed because an IAM action is not allowed. */
export interface PermissionMissing { permissionMissing: string }
export function isPermissionMissing(v: unknown): v is PermissionMissing;

export interface RdsInstanceHealth {
  instanceId: string;
  status: string;              // 'available' | 'storage-full' | 'rebooting' | ...
  engine: string;
  engineVersion: string;
  instanceClass: string;       // e.g. 'db.t3.micro'
  allocatedStorageGb: number;
  multiAz: boolean;
  pendingModifications: string[];
  endpointPort: number;
  vpcSecurityGroupIds: string[];
}
export interface RdsEvent { at: string; message: string; category: string }
export interface RdsLiveMetrics {
  databaseConnections: number | null;
  approxMaxConnections: number | null;  // derived from instance class; null when class unknown
  cpuUtilizationPct: number | null;
  freeStorageBytes: number | null;
  freeableMemoryBytes: number | null;
}
export interface RdsPortReachability {
  port: number;
  /** CIDR ranges and security-group ids allowed to reach the DB port */
  openTo: string[];
}

// RdsRecoveryBackend gains:
getInstanceHealth(): Promise<RdsInstanceHealth | PermissionMissing>;
getRecentEvents(hours: number): Promise<RdsEvent[] | PermissionMissing>;
getLiveMetrics(): Promise<RdsLiveMetrics | PermissionMissing>;
getPortReachability(): Promise<RdsPortReachability | PermissionMissing>;
```

- Simulator gains `scenario` support via its existing `transition?(to)` hook
  with states: `healthy` (default), `storage_full`, `connection_saturation`,
  `sg_blocked`, `maintenance_pending`, plus `iam_denied` (every new method
  returns `{ permissionMissing: '<action>' }`).

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/aws-rds-simulator.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { RdsRecoverySimulator } from '../agent/aws-rds/simulator.js';
import { isPermissionMissing } from '../agent/aws-rds/backend.js';

describe('RdsRecoverySimulator control-plane scenarios', () => {
  it('healthy scenario reports available status and sane metrics', async () => {
    const sim = new RdsRecoverySimulator();
    const health = await sim.getInstanceHealth();
    expect(isPermissionMissing(health)).toBe(false);
    if (!isPermissionMissing(health)) {
      expect(health.status).toBe('available');
      expect(health.vpcSecurityGroupIds.length).toBeGreaterThan(0);
    }
    const metrics = await sim.getLiveMetrics();
    if (!isPermissionMissing(metrics)) {
      expect(metrics.databaseConnections).not.toBeNull();
      expect(metrics.approxMaxConnections).not.toBeNull();
    }
  });

  it('storage_full scenario reports the status and near-zero free storage', async () => {
    const sim = new RdsRecoverySimulator();
    sim.transition!('storage_full');
    const health = await sim.getInstanceHealth();
    if (!isPermissionMissing(health)) expect(health.status).toBe('storage-full');
    const metrics = await sim.getLiveMetrics();
    if (!isPermissionMissing(metrics)) expect(metrics.freeStorageBytes).toBeLessThan(1024 * 1024 * 1024);
  });

  it('connection_saturation reports connections near the derived max', async () => {
    const sim = new RdsRecoverySimulator();
    sim.transition!('connection_saturation');
    const metrics = await sim.getLiveMetrics();
    if (!isPermissionMissing(metrics)) {
      expect(metrics.databaseConnections! / metrics.approxMaxConnections!).toBeGreaterThan(0.9);
    }
  });

  it('sg_blocked reports the DB port open to nothing relevant', async () => {
    const sim = new RdsRecoverySimulator();
    sim.transition!('sg_blocked');
    const reach = await sim.getPortReachability();
    if (!isPermissionMissing(reach)) expect(reach.openTo).toHaveLength(0);
  });

  it('maintenance_pending surfaces a pending modification and an event', async () => {
    const sim = new RdsRecoverySimulator();
    sim.transition!('maintenance_pending');
    const health = await sim.getInstanceHealth();
    if (!isPermissionMissing(health)) expect(health.pendingModifications.length).toBeGreaterThan(0);
    const events = await sim.getRecentEvents(24);
    if (!isPermissionMissing(events)) expect(events.length).toBeGreaterThan(0);
  });

  it('iam_denied returns typed permission results from every method', async () => {
    const sim = new RdsRecoverySimulator();
    sim.transition!('iam_denied');
    expect(isPermissionMissing(await sim.getInstanceHealth())).toBe(true);
    expect(isPermissionMissing(await sim.getRecentEvents(24))).toBe(true);
    expect(isPermissionMissing(await sim.getLiveMetrics())).toBe(true);
    expect(isPermissionMissing(await sim.getPortReachability())).toBe(true);
  });
});
```

- [ ] **Step 2: Verify RED** — `pnpm vitest run src/__tests__/aws-rds-simulator.test.ts` fails (methods missing).

- [ ] **Step 3: Implement.** In `backend.ts` add the types above plus:

```ts
export function isPermissionMissing(v: unknown): v is PermissionMissing {
  return typeof v === 'object' && v !== null && 'permissionMissing' in v;
}
```

In `simulator.ts`: read the existing simulator's state pattern first (it
already implements `getInstanceBackupConfig` and `transition?`); add a
scenario field and implement the four methods returning fixture data per
scenario. Healthy baseline: status `available`, class `db.t3.micro`,
20 GB allocated, port 5432, one sg id, ~12 connections of ~85 max,
free storage ~10 GB. Keep existing backup behavior untouched.

- [ ] **Step 4: Verify GREEN** — the new test file passes AND all existing
aws-rds tests still pass (`pnpm vitest run src/__tests__ --silent` or full `pnpm test`).

- [ ] **Step 5: Full gate and commit**

```bash
pnpm test && pnpm run typecheck && pnpm run lint
git add -A && git commit -m "feat(aws-rds): control-plane backend contract and simulator scenarios"
```

---

### Task 5: Live client — RDS/CloudWatch/EC2 read paths

**Files:**
- Modify: `package.json` (add `@aws-sdk/client-cloudwatch`, `@aws-sdk/client-ec2` at the same `^3.x` line as the existing @aws-sdk deps; run `pnpm install`)
- Modify: `src/agent/aws-rds/live-client.ts`
- Create: `src/agent/aws-rds/control-plane-helpers.ts` (pure helpers, unit-testable without AWS)
- Test: `src/__tests__/aws-rds-control-plane-helpers.test.ts` (create)

**Interfaces:**
- Consumes: backend types from Task 4; `tryImportAws` from `../aws-common.js`.
- Produces (helpers module — pure functions the live client calls):

```ts
export function approxMaxConnections(instanceClass: string): number | null;
export function summarizeSgRules(
  dbPort: number,
  permissions: Array<{ FromPort?: number; ToPort?: number; IpProtocol?: string;
    IpRanges?: Array<{ CidrIp?: string }>; UserIdGroupPairs?: Array<{ GroupId?: string }> }>,
): string[];   // CIDRs + sg-ids whose rule covers dbPort (tcp or all-protocol '-1')
export function isAccessDeniedError(err: unknown): boolean;  // AccessDenied / AccessDeniedException / UnauthorizedOperation / not authorized
```

- `approxMaxConnections` uses the RDS default formula
  `LEAST(memBytes / 9531392, 5000)` over a static class→memory map covering
  common classes (db.t3.micro .5? — use 1 GiB for t3.micro per AWS docs
  value {1 GiB}, t3.small 2, t3.medium 4, t3.large 8, t4g.* same as t3,
  m5.large 8, m5.xlarge 16, m5.2xlarge 32, m6g.large 8, m6g.xlarge 16,
  r5.large 16, r5.xlarge 32, r6g.large 16, r6g.xlarge 32); unknown class →
  null. Values are approximations and documented as such.

- [ ] **Step 1: Write the failing helper tests**

```ts
// src/__tests__/aws-rds-control-plane-helpers.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import {
  approxMaxConnections, summarizeSgRules, isAccessDeniedError,
} from '../agent/aws-rds/control-plane-helpers.js';

describe('approxMaxConnections', () => {
  it('derives the documented formula value for known classes', () => {
    // db.t3.micro: 1 GiB → LEAST(1073741824/9531392, 5000) ≈ 112
    expect(approxMaxConnections('db.t3.micro')).toBe(112);
    // db.m5.large: 8 GiB → ≈ 901
    expect(approxMaxConnections('db.m5.large')).toBe(901);
  });
  it('returns null for unknown classes', () => {
    expect(approxMaxConnections('db.z99.mega')).toBeNull();
  });
});

describe('summarizeSgRules', () => {
  it('collects CIDRs and sg refs whose port range covers the DB port', () => {
    const out = summarizeSgRules(5432, [
      { FromPort: 5432, ToPort: 5432, IpProtocol: 'tcp', IpRanges: [{ CidrIp: '10.0.0.0/16' }] },
      { FromPort: 0, ToPort: 65535, IpProtocol: 'tcp', UserIdGroupPairs: [{ GroupId: 'sg-abc' }] },
      { FromPort: 443, ToPort: 443, IpProtocol: 'tcp', IpRanges: [{ CidrIp: '0.0.0.0/0' }] },
    ]);
    expect(out).toContain('10.0.0.0/16');
    expect(out).toContain('sg-abc');
    expect(out).not.toContain('0.0.0.0/0');
  });
  it('treats IpProtocol -1 as all ports', () => {
    expect(summarizeSgRules(5432, [{ IpProtocol: '-1', IpRanges: [{ CidrIp: '0.0.0.0/0' }] }]))
      .toEqual(['0.0.0.0/0']);
  });
  it('returns empty for no matching rules', () => {
    expect(summarizeSgRules(5432, [])).toEqual([]);
  });
});

describe('isAccessDeniedError', () => {
  it('matches the AWS access-denied error family by name and message', () => {
    expect(isAccessDeniedError(Object.assign(new Error('x'), { name: 'AccessDenied' }))).toBe(true);
    expect(isAccessDeniedError(Object.assign(new Error('x'), { name: 'AccessDeniedException' }))).toBe(true);
    expect(isAccessDeniedError(Object.assign(new Error('x'), { name: 'UnauthorizedOperation' }))).toBe(true);
    expect(isAccessDeniedError(new Error('User ... is not authorized to perform rds:DescribeDBInstances'))).toBe(true);
    expect(isAccessDeniedError(new Error('connect ETIMEDOUT'))).toBe(false);
  });
});
```

- [ ] **Step 2: Verify RED**, then implement the helpers module. For the
formula: `Math.min(Math.floor((gib * 1024 ** 3) / 9531392), 5000)`.

- [ ] **Step 3: Extend the live client.** Follow the existing
`ensureClient()` lazy-import pattern in `live-client.ts` (read it first);
add analogous `ensureCloudWatch()` / `ensureEc2()` using
`tryImportAws('@aws-sdk/client-cloudwatch')` / `tryImportAws('@aws-sdk/client-ec2')`.
Implement the four backend methods:

- `getInstanceHealth()` — `DescribeDBInstancesCommand({ DBInstanceIdentifier })`;
  map to `RdsInstanceHealth` (status `DBInstanceStatus`, class
  `DBInstanceClass`, `AllocatedStorage`, `MultiAZ`,
  `PendingModifiedValues` keys as strings, `Endpoint.Port`,
  `VpcSecurityGroups[].VpcSecurityGroupId`). Verify exact field names
  against the installed `@aws-sdk/client-rds` type declarations, not from
  memory.
- `getRecentEvents(hours)` — `DescribeEventsCommand({ SourceIdentifier,
  SourceType: 'db-instance', Duration: hours * 60 })` → map Date/Message/
  Categories.
- `getLiveMetrics()` — CloudWatch `GetMetricDataCommand`, namespace
  `AWS/RDS`, dimension `DBInstanceIdentifier`, last 15 minutes, period 300,
  stat `Average`, metric ids for `DatabaseConnections`, `CPUUtilization`,
  `FreeStorageSpace`, `FreeableMemory`; take the most recent datapoint per
  series (null when the series is empty); `approxMaxConnections` from the
  instance class (call `getInstanceHealth()` result — cache it per client
  instance to avoid duplicate Describe calls in one scan).
- `getPortReachability()` — from cached instance health: port + sg ids →
  EC2 `DescribeSecurityGroupsCommand({ GroupIds })` → flatten
  `SecurityGroups[].IpPermissions` → `summarizeSgRules(port, permissions)`.

Every method wraps its AWS calls: `catch (err) { if (isAccessDeniedError(err))
return { permissionMissing: '<the-iam-action>' }; throw err; }` with the
action strings `rds:DescribeDBInstances`, `rds:DescribeEvents`,
`cloudwatch:GetMetricData`, `ec2:DescribeSecurityGroups`. If
`tryImportAws` returns null for cloudwatch/ec2, return
`{ permissionMissing: 'sdk:@aws-sdk/client-cloudwatch not installed' }`-style
results (same shape; the agent renders them as blocked entries too).

- [ ] **Step 4: Verify** — helper tests pass; full `pnpm test` green
(live-client AWS paths are exercised by type-checking + Task 6's agent tests
via simulator; no live AWS in CI).

- [ ] **Step 5: Full gate and commit**

```bash
pnpm test && pnpm run typecheck && pnpm run lint
git add -A && git commit -m "feat(aws-rds): live control-plane reads — instance health, events, metrics, security groups"
```

---

### Task 6: Agent diagnosis + suggestion plans

**Files:**
- Modify: `src/agent/aws-rds/agent.ts` (extend `assessHealth` and `diagnose`; extend `plan`)
- Test: `src/__tests__/aws-rds-agent-control-plane.test.ts` (create)

**Interfaces:**
- Consumes: Task 4 backend methods + `isPermissionMissing`; simulator scenarios for tests.
- Produces findings/signals with these sources (exact strings — Tasks 7-9 depend on them):
  `rds_instance_status`, `rds_storage`, `rds_connection_saturation`,
  `rds_security_group`, `rds_events`, `rds_iam_permissions`.
- Signal detail phrasing constraint (feeds `healthToSignals` regexes in
  `src/framework/health-to-signals.ts` for correlation):
  storage findings include the word "full" (→ `resource_exhaustion`);
  security-group findings include the word "connections"/"connect"
  (→ `connection`); saturation findings include "connection" (→ `connection`).

- [ ] **Step 1: Write the failing tests** (simulator-driven; read the
existing `agent.ts` assessHealth/diagnose structure first and mirror its
AgentContext construction from existing aws-rds tests if present):

```ts
// src/__tests__/aws-rds-agent-control-plane.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { AwsRdsRecoveryAgent } from '../agent/aws-rds/agent.js';
import { RdsRecoverySimulator } from '../agent/aws-rds/simulator.js';

function makeAgent(scenario?: string) {
  const sim = new RdsRecoverySimulator();
  if (scenario) sim.transition!(scenario);
  return { agent: new AwsRdsRecoveryAgent(sim), sim };
}
// Build AgentContext the same way existing aws-rds tests do — check
// src/__tests__ for an existing aws-rds agent test and reuse its helper.
declare function makeContext(): unknown;

describe('aws-rds control-plane diagnosis', () => {
  it('healthy scenario yields a healthy assessment with an rds_instance_status signal', async () => {
    const { agent } = makeAgent();
    const health = await agent.assessHealth(makeContext() as never);
    expect(health.signals.some((s) => s.source === 'rds_instance_status')).toBe(true);
  });

  it('storage_full yields an unhealthy assessment whose detail says full', async () => {
    const { agent } = makeAgent('storage_full');
    const health = await agent.assessHealth(makeContext() as never);
    expect(health.status).not.toBe('healthy');
    const sig = health.signals.find((s) => s.source === 'rds_storage');
    expect(sig).toBeDefined();
    expect(sig!.status).toBe('critical');
    expect(sig!.detail.toLowerCase()).toContain('full');
  });

  it('connection_saturation flags rds_connection_saturation with connection wording', async () => {
    const { agent } = makeAgent('connection_saturation');
    const health = await agent.assessHealth(makeContext() as never);
    const sig = health.signals.find((s) => s.source === 'rds_connection_saturation');
    expect(sig).toBeDefined();
    expect(sig!.detail.toLowerCase()).toContain('connection');
  });

  it('sg_blocked produces an rds_security_group finding mentioning connections', async () => {
    const { agent } = makeAgent('sg_blocked');
    const diagnosis = await agent.diagnose(makeContext() as never);
    const f = diagnosis.findings.find((x) => x.source === 'rds_security_group');
    expect(f).toBeDefined();
    expect(f!.observation.toLowerCase()).toMatch(/connect/);
  });

  it('iam_denied surfaces rds_iam_permissions signals naming the action, without failing health', async () => {
    const { agent } = makeAgent('iam_denied');
    const health = await agent.assessHealth(makeContext() as never);
    const iam = health.signals.filter((s) => s.source === 'rds_iam_permissions');
    expect(iam.length).toBeGreaterThan(0);
    expect(iam[0]!.detail).toMatch(/rds:|cloudwatch:|ec2:/);
    // permission problems are 'unknown', not failures of the database itself
    expect(iam[0]!.status).toBe('unknown');
  });

  it('plans stay at suggestion level: no system_action steps from control-plane findings', async () => {
    const { agent } = makeAgent('storage_full');
    const diagnosis = await agent.diagnose(makeContext() as never);
    const plan = await agent.plan(makeContext() as never, diagnosis);
    expect(plan.steps.some((s) => s.type === 'system_action')).toBe(false);
    const text = JSON.stringify(plan.steps);
    expect(text).toContain('RDS console');       // console path present
    expect(text).toContain('aws rds');           // CLI equivalent present
  });
});
```

Replace the `declare function makeContext` stub with the real context
helper found in the existing aws-rds tests (search `src/__tests__` for
`AwsRdsRecoveryAgent`); if none exists, build a minimal `AgentContext` per
`src/agent/interface.ts`.

- [ ] **Step 2: Verify RED** (assertions fail — sources absent).

- [ ] **Step 3: Implement in `agent.ts`.** Extend `assessHealth`:
after the existing backup signals, call the four new backend methods
(`Promise.all`); permission results → signals
`{ source: 'rds_iam_permissions', status: 'unknown', detail: 'AWS check skipped — missing <action>' }`;
otherwise derive signals:

- status !== 'available' → `rds_instance_status` critical (detail: `RDS instance status is '<status>'` + ` — storage is full` when storage-full)
- freeStorageBytes < 2 GiB or status storage-full → `rds_storage` critical, detail contains "storage is full/nearly full"
- databaseConnections/approxMaxConnections > 0.85 → `rds_connection_saturation` warning (>0.95 critical), detail `<n> of ~<max> connections in use`
- openTo empty → `rds_security_group` critical, detail `security group allows no sources on port <port> — clients cannot connect`
- recent events with category including 'failure'/'failover'/'low storage' → `rds_events` warning with the event message

`diagnose()` mirrors these as findings (source/observation/severity + data
payload with the raw values). `plan()` — for control-plane findings emit
`human_notification` suggestion steps (reuse the plan-building style already
in this agent): storage → "Increase allocated storage: RDS console →
Databases → <id> → Modify → Allocated storage" + `aws rds
modify-db-instance --db-instance-identifier <id> --allocated-storage <n>`;
saturation → connection pooling / RDS Proxy / larger class suggestion + CLI;
sg → "open the DB port to your app's security group: EC2 console → Security
Groups → <sg-id> → Inbound rules" + `aws ec2 authorize-security-group-ingress ...`.
Keep every step `diagnosis_action` or `human_notification` — the test
asserts no `system_action`.

- [ ] **Step 4: Verify GREEN**, run the full aws-rds test set + `pnpm test`.

- [ ] **Step 5: Full gate and commit**

```bash
pnpm test && pnpm run typecheck && pnpm run lint
git add -A && git commit -m "feat(aws-rds): control-plane health, diagnosis, and AWS-console suggestion plans"
```

---

### Task 7: Knowledge-map entries + coverage enforcement

**Files:**
- Modify: `src/framework/signal-explanations.ts`
- Modify: `src/__tests__/explanation-coverage.test.ts` (extend the `aws-rds` entry)
- Modify: `src/__tests__/signal-explanations.test.ts` (extend)

- [ ] **Step 1: Failing tests.** In `explanation-coverage.test.ts`, change the
`'aws-rds'` representative sources to
`['rds_backup_retention', 'rds_instance_status', 'rds_connection_saturation', 'rds_storage', 'rds_security_group', 'rds_iam_permissions']`.
In `signal-explanations.test.ts` add these sources to the covered-sources
block with the same >40-char + https assertions used there.

- [ ] **Step 2: Verify RED** (new sources match no entry — note
`rds_backup_retention` already matches the generic backup entry and
`rds_storage`/`rds_instance_status` may partially collide with existing
regexes; run the test to see which genuinely fail before writing entries).

- [ ] **Step 3: Add EXPLANATIONS entries** (before the generic backup entry;
most-specific-first — mind the Task 4 Arc 1 lesson about `/backup|.../`
shadowing):

```ts
  {
    match: /^rds_instance_status|^rds_events/,
    explanation: 'The AWS-managed status of your database instance. When AWS reports a non-available state (storage-full, rebooting, maintenance), the platform itself — not your application — is the reason the database misbehaves.',
    learnMoreUrl: 'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/accessing-monitoring.html',
  },
  {
    match: /^rds_connection_saturation/,
    explanation: 'Each RDS instance size allows a limited number of simultaneous database connections. Near the limit, new connections fail even though the database is healthy — common with serverless apps that open a connection per request. Connection pooling or RDS Proxy fixes this.',
    learnMoreUrl: 'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html',
  },
  {
    match: /^rds_storage/,
    explanation: 'RDS instances have a fixed allocated storage size. When it fills up, the database stops accepting writes until storage is increased — a one-click change in the RDS console (Modify → Allocated storage).',
    learnMoreUrl: 'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_PIOPS.StorageTypes.html',
  },
  {
    match: /^rds_security_group/,
    explanation: 'AWS security groups are firewalls around your database. If no rule allows your app\'s address on the database port, every connection times out even though the database is running fine — the most common cause of "my app can\'t reach RDS".',
    learnMoreUrl: 'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Overview.RDSSecurityGroups.html',
  },
  {
    match: /^rds_iam_permissions/,
    explanation: 'CrisisMode\'s AWS credentials lack permission for a read-only check. The database itself may be fine — grant the listed IAM action (the AmazonRDSReadOnlyAccess and CloudWatchReadOnlyAccess managed policies cover all checks) to see the full picture.',
    learnMoreUrl: 'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/security_iam_id-based-policy-examples.html',
  },
```

- [ ] **Step 4: Verify GREEN** including full suite (regex-ordering
regressions surface in the Arc 1 tests).

- [ ] **Step 5: Full gate and commit**

```bash
pnpm test && pnpm run typecheck && pnpm run lint
git add -A && git commit -m "feat(explanations): RDS control-plane knowledge-map entries with coverage enforcement"
```

---

### Task 8: Correlation rules — platform and reachability

**Files:**
- Modify: `src/framework/root-cause-synthesis.ts` (`CORRELATION_RULES` array)
- Test: `src/__tests__/root-cause-synthesis.test.ts` (extend; check filename by searching for existing synthesis tests first)

**Interfaces:**
- Consumes: `AgentEvidence`/`synthesizeByRules` as-is; scan derives
  SymptomSignal types via `healthToSignals` (Task 6's detail phrasing makes
  storage → `resource_exhaustion`, sg/saturation → `connection`).

- [ ] **Step 1: Failing tests** — two cases through `synthesizeByRules`:

```ts
  it('correlates pg unreachable with RDS platform exhaustion', () => {
    const result = synthesizeByRules([
      { agentKind: 'postgresql', targetName: 'db', signals: [
        { type: 'connection', source: 'pg_connection', detail: 'connection refused', severity: 'critical' },
      ]},
      { agentKind: 'aws-rds', targetName: 'rds-mydb', signals: [
        { type: 'resource_exhaustion', source: 'rds_storage', detail: 'storage is full', severity: 'critical' },
      ]},
    ]);
    const cluster = result.clusters.find((c) => c.agents.includes('aws-rds') && c.agents.includes('postgresql'));
    expect(cluster).toBeDefined();
    expect(cluster!.investigationOrder[0]).toBe('aws-rds');
  });

  it('correlates pg timeout with RDS security-group facts', () => {
    const result = synthesizeByRules([
      { agentKind: 'postgresql', targetName: 'db', signals: [
        { type: 'timeout', source: 'pg_connection', detail: 'timed out', severity: 'critical' },
      ]},
      { agentKind: 'aws-rds', targetName: 'rds-mydb', signals: [
        { type: 'connection', source: 'rds_security_group', detail: 'security group allows no sources on port 5432 — clients cannot connect', severity: 'critical' },
      ]},
    ]);
    const cluster = result.clusters.find((c) => c.agents.includes('aws-rds'));
    expect(cluster).toBeDefined();
    expect(cluster!.investigationOrder[0]).toBe('aws-rds');
  });
```

Adapt the evidence literals to the real `SymptomSignal` field set
(`src/framework/symptom-router.ts:26`) if `severity` naming differs — read
it first.

- [ ] **Step 2: Verify RED** (no rule links `aws-rds`).

- [ ] **Step 3: Add two rules** to `CORRELATION_RULES` (same shape as
existing entries):

```ts
  {
    name: 'rds-platform-degraded',
    agentKinds: ['aws-rds', 'postgresql', 'managed-database'],
    sharedSignalTypes: ['resource_exhaustion', 'connection'],
    sharedPatterns: [],
    rootCauseTemplate: 'The AWS RDS platform under the database is degraded — fix the instance (storage/limits) before debugging the database itself',
    investigationOrder: ['aws-rds', 'postgresql', 'managed-database'],
    confidenceBoost: 0.3,
  },
  {
    name: 'rds-reachability',
    agentKinds: ['aws-rds', 'postgresql'],
    sharedSignalTypes: ['connection', 'timeout'],
    sharedPatterns: [],
    rootCauseTemplate: 'The database looks down but AWS reports it healthy — network path (security groups) is the likely cause',
    investigationOrder: ['aws-rds', 'postgresql'],
    confidenceBoost: 0.25,
  },
```

Read `synthesizeByRules`'s matching logic before finalizing: if rule
selection requires the shared signal type to appear in BOTH agents'
evidence, adjust `sharedSignalTypes` accordingly (e.g. the platform rule may
need `'connection'` listed so the pg side matches) — make the tests pass by
correct rule design, not by loosening assertions.

- [ ] **Step 4: Verify GREEN** + full suite.

- [ ] **Step 5: Full gate and commit**

```bash
pnpm test && pnpm run typecheck && pnpm run lint
git add -A && git commit -m "feat(synthesis): correlate RDS control-plane findings with database-agent failures"
```

---

### Task 9: Scan wiring — IAM findings into visibility

**Files:**
- Modify: `src/cli/commands/scan.ts` (visibility construction, currently `result.visibility = buildVisibilityReport(stackProfile, ranKinds, configSource)`)
- Test: `src/__tests__/scan-aws-visibility.test.ts` (create)

**Interfaces:**
- Consumes: `ScanFinding.signals[].source` (retained since Arc 1);
  `buildVisibilityReport(..., extraBlocked)` (Task 3).
- Produces: exported pure helper in `scan.ts`:

```ts
export function iamBlockedEntries(
  findings: Array<{ service: string; signals: Array<{ source?: string; detail: string }> }>,
): VisibilityEntry[]
```

Collects, deduped by detail, every signal with source
`rds_iam_permissions` into
`{ label: 'aws-rds permissions', detail: <signal detail>, hint: 'Attach the AmazonRDSReadOnlyAccess and CloudWatchReadOnlyAccess policies to let CrisisMode see the full picture.' }`.

- [ ] **Step 1: Failing test**

```ts
// src/__tests__/scan-aws-visibility.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { iamBlockedEntries } from '../cli/commands/scan.js';

describe('iamBlockedEntries', () => {
  it('maps rds_iam_permissions signals to blocked entries with hints', () => {
    const entries = iamBlockedEntries([
      { service: 'aws-rds (rds-mydb)', signals: [
        { source: 'rds_iam_permissions', detail: 'AWS check skipped — missing cloudwatch:GetMetricData' },
        { source: 'rds_instance_status', detail: 'available' },
      ]},
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.detail).toContain('cloudwatch:GetMetricData');
    expect(entries[0]!.hint).toBeTruthy();
  });

  it('dedupes identical permission gaps across findings and returns empty when none', () => {
    const sig = { source: 'rds_iam_permissions', detail: 'AWS check skipped — missing rds:DescribeEvents' };
    expect(iamBlockedEntries([
      { service: 'a', signals: [sig] }, { service: 'b', signals: [sig] },
    ])).toHaveLength(1);
    expect(iamBlockedEntries([{ service: 'a', signals: [{ source: 'pg_connection', detail: 'x' }] }])).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Verify RED**, implement the helper, and change the
visibility construction in `runScan` to
`buildVisibilityReport(stackProfile, ranKinds, configSource, iamBlockedEntries(findings))`.

- [ ] **Step 3: Verify GREEN** + full suite.

- [ ] **Step 4: Full gate and commit**

```bash
pnpm test && pnpm run typecheck && pnpm run lint
git add -A && git commit -m "feat(scan): surface missing IAM permissions in the visibility blocked bucket"
```

---

### Task 10: Real-surface verification, docs, PR prep

**Files:**
- Modify: `CLAUDE.md` (agent table row for `src/agent/aws-rds/` — extend its description to "AWS RDS control-plane health, metrics, reachability, and backup agent")
- Modify: `docs/architecture.md` only if it lists agent capabilities (check; skip otherwise)

- [ ] **Step 1: Drive the bundle** (verify-skill conventions; all keyless
for AWS — no real account needed for these paths):

```bash
pnpm run build:bundle
BUNDLE=$PWD/dist/crisismode.bundle.cjs
WORK=$(mktemp -d)
cd "$WORK"

# 1. RDS endpoint + NO AWS creds → visibility blocked entry naming the host and the env vars to set.
env -u AWS_ACCESS_KEY_ID -u AWS_PROFILE -u ANTHROPIC_API_KEY \
  DATABASE_URL='postgres://u:p@mydb.c9akciq32rza.us-east-1.rds.amazonaws.com:5432/app' \
  node "$BUNDLE" scan | grep -iA2 "rds"

# 2. RDS endpoint + fake creds → aws-rds target derived (watching bucket shows evidence);
#    STS fails → credential blocked entry; scan completes, exit code usable.
env -u ANTHROPIC_API_KEY AWS_ACCESS_KEY_ID=AKIAFAKE AWS_SECRET_ACCESS_KEY=fake AWS_REGION=us-east-1 \
  DATABASE_URL='postgres://u:p@mydb.c9akciq32rza.us-east-1.rds.amazonaws.com:5432/app' \
  node "$BUNDLE" scan | grep -iA2 "aws"

# 3. Aurora endpoint → blocked bucket 'Aurora' entry, no aws-rds target.
env -u ANTHROPIC_API_KEY AWS_ACCESS_KEY_ID=AKIAFAKE \
  DATABASE_URL='postgres://u:p@prod.cluster-c9akciq32rza.us-east-1.rds.amazonaws.com:5432/app' \
  node "$BUNDLE" scan | grep -i aurora

# 4. Simulator demo: aws-rds scenarios render control-plane findings with explanations
#    and suggestion plans with console paths + aws-cli lines.
node "$BUNDLE" demo 2>&1 | grep -iB1 -A3 "rds" | head -40

# 5. --json additive: aws-rds finding fields + visibility record intact.
env -u ANTHROPIC_API_KEY AWS_ACCESS_KEY_ID=AKIAFAKE \
  DATABASE_URL='postgres://u:p@mydb.c9akciq32rza.us-east-1.rds.amazonaws.com:5432/app' \
  node "$BUNDLE" scan --json | head -5
```

Check the demo runner includes an aws-rds scenario; if `demo` has a fixed
scenario list that omits aws-rds, drive the simulator through
`node $BUNDLE diagnose` against a `crisismode.yaml` with an
`aws-rds` target using `aws: { region: 'simulator' }` instead, and record
that in the report. Fix anything that fails (with tests where appropriate)
before proceeding.

- [ ] **Step 2: Behavior check on a real timeout path** — confirm AWS
throttling/timeout cannot fail the scan: temporarily point `AWS_REGION` at a
black-holed endpoint is NOT reliably testable offline; instead assert by
reading `checkTargetHealth`'s timeout race covers the aws-rds agent like any
other (it does — 2s `AGENT_TIMEOUT_MS`); note this reasoning in the report.

- [ ] **Step 3: Docs** — CLAUDE.md agent-table row update as above.

- [ ] **Step 4: Full gate and final commit**

```bash
pnpm test && pnpm run typecheck && pnpm run lint
git add -A && git commit -m "docs: aws-rds agent covers control-plane health and reachability"
```

Do NOT create the PR — the controller session runs the final whole-branch
review first, then opens the PR.

---

## Self-Review Notes

- Spec §1 (detection) → Tasks 1-2; §2 (backend) → Tasks 4-5; §3
  (diagnosis/plans/correlation) → Tasks 6+8; §4 (IAM degradation) → Tasks
  4 (simulator scenario), 5 (typed results), 6 (signals), 9 (visibility);
  visibility states (Aurora/no-creds) → Task 3; §5 (deps/footprint) →
  Task 5 (tryImportAws only); error handling: STS-invalid path is
  pre-existing `resolveAwsCredentials` + registration fallback (verified in
  code — live-client init failure falls back to simulator with a loud
  warning; Task 10 exercises it); throttling/timeout → scan's existing
  2s per-agent race (Task 10 Step 2); wrong-account instance-not-found →
  live client's non-AccessDenied errors propagate into the existing
  catch-path finding (`Error: ...` summary), acceptable and observable.
- Type names verified against the codebase on 2026-08-02:
  `RdsRecoveryBackend`/`transition?` (`src/agent/aws-rds/backend.ts`),
  `AwsTargetConfig` (`src/config/schema.ts:46`), `tryImportAws`/
  `resolveAwsCredentials` (`src/agent/aws-common.ts`), registration
  live/simulator fallback (`src/agent/aws-rds/registration.ts`),
  `derivedTargets`/`derivedNotes` assembly (`src/cli/autodiscovery.ts`
  ~line 372), `buildVisibilityReport(profile, ranKinds, configSource)`
  (`src/cli/visibility.ts`), `CORRELATION_RULES`/`AgentEvidence`
  (`src/framework/root-cause-synthesis.ts:70-160`), `healthToSignals`
  regexes (`src/framework/health-to-signals.ts:12-18`),
  `SymptomSignal.type` union (`src/framework/symptom-router.ts:26`),
  `ScanFinding.signals[].source` (Arc 1).
- Deliberate scope guards: no mutating AWS calls anywhere (Task 6 test
  asserts no system_action); Aurora/proxy/ElastiCache/cross-account out.
