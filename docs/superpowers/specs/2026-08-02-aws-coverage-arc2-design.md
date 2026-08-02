# Vibe-Coder UX, Arc 2: AWS Coverage — RDS Control-Plane Diagnosis

**Date:** 2026-08-02
**Status:** Approved for implementation
**Predecessor:** Arc 1 (`2026-08-01-vibe-coder-ux-arc1-design.md`) — the
visibility section, actionable-hint pattern, and explanation knowledge map
this arc plugs into.

## Problem

CrisisMode's reach is service-level: it diagnoses an RDS Postgres perfectly
through `DATABASE_URL`, but knows nothing about the AWS control plane wrapped
around it. The two failure modes that most often strand the target user:

1. The database's *platform* is the problem (storage-full, maintenance,
   failover, connection saturation at the instance class limit) — data-plane
   probing sees only "down" or "slow".
2. The database is fine but *unreachable* (security group doesn't allow the
   app's traffic on the DB port) — data-plane probing sees a timeout and
   nothing else.

Since Arc 1, every scan with AWS credentials advertises this gap in the
visibility section ("AWS credentials detected — control-plane checks aren't
supported yet"). This arc closes it for RDS.

## Settled decisions (brainstorming)

- **Diagnose + suggest only.** All AWS API usage is read-only
  (`Describe*` / `GetMetricData` / `GetCallerIdentity`). Plans stop at
  escalation level 3 (Suggest) by construction — no `system_action` steps
  against AWS APIs in this arc.
- **Scope: RDS + CloudWatch metrics + EC2 security-group facts.** ElastiCache
  and Aurora-cluster diagnosis are out (Aurora endpoints are *detected* and
  honestly reported as unsupported).
- **Auto-run when detected.** An RDS endpoint parsed from a connection string
  plus working AWS credentials → control-plane checks run in scan with no
  flag or config, disclosed in the visibility section.
- **Architecture: extend the existing `aws-rds` agent** (option B) rather
  than adding a second RDS agent or enriching the pg agent. Its config shape
  (`region`, `instanceId`), SDK dependency, simulator/live-client pattern,
  and registry presence are all reused. Existing mutating backup capabilities
  are untouched and remain gated by the escalation model.

## Components

### 1. RDS endpoint detection (autodiscovery)

New parser in `src/cli/autodiscovery.ts` (or a small sibling module) applied
to hosts already extracted from connection-string env hints:

- `<identifier>.<hash>.<region>.rds.amazonaws.com` → `{ instanceId, region }`
  → derive an `aws-rds` target via the existing `derivedTargets` +
  `derivedNotes` mechanism (note: `from DATABASE_URL endpoint`), only when
  AWS credentials are also detected.
- `<cluster>.cluster-<hash>.<region>.rds.amazonaws.com` (Aurora) → no
  target; visibility blocked-bucket entry: Aurora cluster checks not
  supported yet.
- RDS Proxy (`.proxy-`) and non-RDS hosts → ignored (proxy noted as
  future work).
- Endpoint seen but no credentials → visibility blocked-bucket entry with
  the hint naming the env vars to set (`AWS_ACCESS_KEY_ID` +
  `AWS_SECRET_ACCESS_KEY` (or `AWS_PROFILE`) + `AWS_REGION` —
  `AWS_ACCESS_KEY_ID` alone cannot authenticate).

### 2. Backend extension (`RdsRecoveryBackend`)

Three new read-only methods plus a reachability fact-finder, implemented by
both `simulator.ts` and `live-client.ts`:

- `getInstanceHealth()` — status, engine + version, instance class,
  allocated storage, multi-AZ, pending modifications
  (`DescribeDBInstances`).
- `getRecentEvents(hours)` — recent instance events: failover, storage-full,
  maintenance, snapshots (`DescribeEvents`).
- `getLiveMetrics()` — CloudWatch `GetMetricData`: `DatabaseConnections`
  (with the derived max_connections for the class/engine where derivable),
  `CPUUtilization`, `FreeStorageSpace`, `FreeableMemory`.
- `getPortReachability()` — the instance's VPC security groups and which
  sources (CIDRs / SG references) are allowed on the DB port
  (`DescribeSecurityGroups` via `@aws-sdk/client-ec2`). Reported as facts,
  not a verdict — the scanner cannot always know the app's egress address.

Simulator gains scenario states: `storage_full`, `connection_saturation`,
`sg_blocked`, `maintenance_pending`, plus healthy — so demo mode and tests
run with no AWS account.

### 3. Diagnosis and suggestion plans (agent)

- `assessHealth()` folds instance status + key metrics into the health
  assessment; `diagnose()` emits findings with sources
  `rds_instance_status`, `rds_connection_saturation`, `rds_storage`,
  `rds_security_group`, `rds_events` — each with a knowledge-map entry
  (Arc 1 coverage test extended so these are enforced).
- `plan()` emits suggestion-only plans: `diagnosis_action` +
  `human_notification` steps whose text gives the AWS-console path AND the
  equivalent aws-cli command (e.g. "RDS console → Databases → <id> →
  Modify → Allocated storage", `aws rds modify-db-instance ...`). Never a
  `system_action` against AWS.
- Findings flow into the existing cross-agent root-cause synthesis. Target
  correlations: (a) pg unreachable + RDS storage-full → platform root cause
  with a storage suggestion; (b) pg timeout + RDS status `available` +
  security-group facts showing the DB port closed to the app → reachability
  root cause with an SG suggestion.

### 4. IAM-aware degradation

- Before any other AWS call: STS `GetCallerIdentity` as the cheap
  "credentials work at all" probe.
- Every live-client method catches AccessDenied-family errors and returns a
  typed `{ permissionMissing: '<iam-action>' }` result instead of throwing.
- The agent converts those into visibility blocked-bucket entries naming the
  exact missing IAM action (`rds:DescribeDBInstances`,
  `rds:DescribeEvents`, `cloudwatch:GetMetricData`,
  `ec2:DescribeSecurityGroups`) and hinting the managed read-only policies.
- Degradation is per-check: metrics permission missing must not disable
  instance-status checks.

### 5. Dependencies and footprint

- New: `@aws-sdk/client-cloudwatch`, `@aws-sdk/client-ec2` — both loaded via
  the existing `tryImportAws` dynamic-import pattern, so spokes that never
  target AWS never load them.
- Existing `@aws-sdk/client-rds` / `client-sts` reused.

## Error handling

- Credentials invalid/expired (STS fails): one blocked-bucket entry
  ("AWS credentials found but not working: <reason>"), no further AWS calls,
  scan continues unaffected.
- AWS API throttling or timeout: the affected check reports `unknown` with
  the error in the finding detail; other checks proceed. Scan never fails
  because AWS is slow.
- Endpoint parses but instance not found in the account/region (creds for a
  different account): finding explains the mismatch plainly — this is a
  real vibe-coder scenario (personal creds, company database).
- Detection is pure string parsing — a malformed host simply doesn't match;
  no throw paths.

## Testing

- Unit: endpoint parser (instance, Aurora cluster, proxy, non-RDS,
  malformed); simulator-driven agent tests per scenario state; IAM
  degradation with a fake client returning AccessDenied per method;
  correlation tests feeding pg + rds evidence into the synthesis.
- Real surface (verify skill, keyless AWS): bundle scan with a fake
  RDS-shaped `DATABASE_URL` host and no creds → detection + blocked-bucket
  visibility; with fake creds → STS-failure path.
- Live AWS: one manual verification against a real RDS instance if a
  sandbox account is available; CI relies on the simulator.

## Out of scope (this arc)

- Mutating AWS actions of any kind (future arc, needs its own safety
  design).
- ElastiCache, Aurora cluster diagnosis, RDS Proxy introspection,
  cross-account role assumption.
- IaC awareness (Arc 3 candidate, per Arc 1 spec).
