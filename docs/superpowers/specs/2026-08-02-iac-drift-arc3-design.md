# Vibe-Coder UX, Arc 3: IaC Awareness — Terraform Drift Detection

**Date:** 2026-08-02
**Status:** Approved for implementation
**Predecessors:** Arc 1 (`2026-08-01-vibe-coder-ux-arc1-design.md`) — the
visibility section, actionable-hint pattern, and knowledge-map coverage test;
Arc 2 (`2026-08-02-aws-coverage-arc2-design.md`) — AWS credential handling,
per-check IAM degradation, suggestion-only plan shape, pairwise correlation
rules.

## Problem

CrisisMode observes live infrastructure but has no notion of what that
infrastructure is *supposed* to look like. For the target user, the gap bites
in two ways:

1. Someone (often the user themselves, mid-incident) changes infrastructure
   by hand — resizes an RDS instance in the console, deletes a bucket, flips
   a setting. Terraform still records the old intent. The next
   `terraform apply` silently reverts the manual change, sometimes
   destructively. No mainstream tool watches for this anymore (driftctl was
   deprecated in 2023).
2. CrisisMode discovers the stack by probing. Terraform state already *knows*
   the shape of the stack — including resources CrisisMode has no agent for —
   and today that knowledge is ignored, weakening the coverage honesty story.

This arc gives CrisisMode read-only Terraform awareness: intended vs.
observed drift findings, plus state-derived entries in the "What CrisisMode
can see" visibility section.

## Settled decisions (brainstorming)

- **Primary job: drift detection.** Intended state (Terraform) vs. observed
  state (live AWS), surfaced as findings through the normal agent pipeline.
- **Truth source: the state file, never the terraform CLI.** Parse
  `terraform.tfstate` JSON directly — local file or S3 backend. State has
  fully resolved values and reading it works in a degraded environment where
  running `terraform` may not. Staleness is handled honestly (below), not
  ignored.
- **Tiered comparison depth.** Existence-level checks for managed AWS
  resources in the state wherever an SDK client is loadable (existence
  `unknown`, with the reason, elsewhere); attribute-level drift only for
  the three types CrisisMode can already describe: RDS instances, S3
  buckets, DynamoDB tables. Depth limits are disclosed, not hidden.
- **State also feeds visibility.** Managed resources with no agent appear as
  *invisible* entries ("your Terraform manages an ElastiCache cluster;
  CrisisMode can't watch ElastiCache yet"); unreadable state appears as
  *blocked* with a hint.
- **Suggest-only (escalation level 3).** Plans are `diagnosis_action` +
  `human_notification` steps only — no `system_action` steps at all.
  CrisisMode never runs terraform, never writes or locks state, never
  mutates AWS. `maxRiskLevel: 'safe'`.
- **Architecture: a new `iac-drift` agent** (standard six-file pattern), not
  an extension of `config-drift`. config-drift owns per-key *application*
  config (env vars, secrets, files); iac-drift owns resource-shaped
  *infrastructure* drift and needs AWS clients config-drift doesn't have.
  The pairing survives as a correlation rule, not a merged agent.

## Components

### 1. State parser (`src/agent/iac-drift/state-parser.ts`)

Pure functions with no ambient I/O, exported for reuse by autodiscovery and
visibility (the `findEnvExample` precedent — autodiscovery already imports
from an agent package):

- `parseTfState(json)` — accepts state format **version 4** (Terraform
  ≥ 0.12). Extracts `resources[]` with `mode: "managed"` and an `aws_`
  provider prefix into a normalized
  `IacResource { type, name, id, region?, attributes }` list, plus
  `StateSummary { serial, terraformVersion, resourceCounts }`. Unknown
  format versions or unparseable JSON return a typed error result — never a
  throw, never partial output.
- `discoverStateSource(cwd)` — returns one of:
  - `local` — `terraform.tfstate` in the project root (plus
    `terraform.tfstate.d/<workspace>/terraform.tfstate` for non-default
    workspaces);
  - `s3-backend` — backend config read from `.terraform/terraform.tfstate`
    (plain JSON after `terraform init` — no HCL parsing needed); fallback
    when `.terraform/` is absent: a minimal regex scan of `*.tf` for a
    `backend "s3"` block only (bucket, key, region) — explicitly not a
    general HCL parser;
  - `unsupported-backend` — Terraform Cloud / GCS / azurerm / etc. detected;
    reported, never guessed at;
  - `none` — `.tf` files exist but no state is discoverable.

### 2. Backend (`IacDriftBackend extends ExecutionBackend`)

Implemented by both `simulator.ts` and `live-client.ts`:

- `getStateStatus()` — source kind, serial, last-modified time, resource
  counts by type.
- `listManagedResources()` — the normalized `IacResource[]`.
- `checkResourceExistence(resource)` — `exists | missing | unknown` (with
  reason). Only checked where an SDK client is already loadable for the
  resource's service; otherwise `unknown` with an honest reason.
- `getResourceDrift(resource)` — attribute-level comparison for the deep
  trio; returns per-attribute `{ attribute, intended, observed }` diffs plus
  `comparedAttributes` (the attribute names actually checked) and
  `intendedAttributeCount` (the total attribute keys recorded in state), so
  callers can disclose coverage honestly (e.g. "compared 8 of 42 recorded
  attributes") — the agent never pretends to understand attributes it
  doesn't model.

Compared attributes (v1), each chosen for a crisp could-go-wrong story:

- **RDS** (`aws_db_instance`): instance class, engine + version, multi-AZ,
  backup retention period, deletion protection, storage type + allocated
  size — via `DescribeDBInstances`.
- **S3** (`aws_s3_bucket`): existence (`HeadBucket`), versioning
  (`GetBucketVersioning`), lifecycle-configuration presence. In AWS
  provider v4+, versioning and lifecycle live in the separate
  `aws_s3_bucket_versioning` / `aws_s3_bucket_lifecycle_configuration`
  resources — the comparator folds those into the bucket's intended state
  by bucket id before diffing.
- **DynamoDB** (`aws_dynamodb_table`): existence, billing mode, PITR status
  — via `DescribeTable` + `DescribeContinuousBackups`.

The live client follows the Arc 2 pattern exactly: lazy per-service clients,
`tryImportAws` dynamic imports, STS `GetCallerIdentity` pre-flight,
per-check `isPermissionMissing` degradation naming the exact IAM action
(`s3:GetObject` on the state bucket, `rds:DescribeDBInstances`, …).

Simulator scenario states: `drifted` (RDS instance class changed manually +
deleted S3 bucket + in-sync DynamoDB table + one unwatchable ElastiCache
resource), `aligned`, `state_unreadable`.

### 3. Diagnosis and suggestion plans (agent)

Finding sources, each with a knowledge-map entry enforced by the Arc 1
coverage test:

- `iac_resource_missing` — in state, gone live. Severity scaled by resource
  type (a deleted bucket outranks a missing tag-like resource).
- `iac_attribute_drift` — live differs from intended. The explanation names
  the direction of danger: "the next `terraform apply` would revert this."
- `iac_state_stale` — staleness caveat finding (see Error handling).
- `iac_state_unreadable` — state discovered but not parseable/fetchable.

`plan()` emits suggestion-only plans. Every drift suggestion presents the
fork explicitly, in plain language:

1. Run `terraform plan` to confirm what apply would change (exact command
   text, run by the user, not by CrisisMode).
2. Either **apply Terraform** (reverts the manual change — flagged
   destructive when the manual change may have been the emergency fix), or
   **update the .tf to match live** (backports the change; the suggestion
   names the resource block and attribute to edit).

### 4. Autodiscovery and visibility integration

- `deriveGatedTargets` (`src/cli/autodiscovery.ts`) gains one heuristic:
  `*.tf` files or `terraform.tfstate` present in the project → derive an
  `iac-drift` target. Missing AWS credentials do not suppress the target
  (local state may still be readable); they gate only the observed side and
  the S3 state fetch, which degrade per-check.
- Visibility (`src/cli/visibility.ts`, via the `extraBlocked` mechanism from
  Arc 2 plus a new invisible-entry feed):
  - state-managed resources with no CrisisMode agent → *invisible*, one
    entry per service type, with an honest "no agent yet" hint;
  - unsupported backend / unreadable state / denied state fetch → *blocked*
    with the specific reason and hint.
- Correlation: one pairwise rule via Arc 2's `requiredTypesByKind` —
  aws-rds instance finding + iac-drift finding on the **same instance id**
  → synthesis names the out-of-band change as a likely cause. Same-id
  matching is required (the Arc 2 co-firing lesson).

### 5. Dependencies and footprint

- No new runtime dependencies. `@aws-sdk/client-s3`, `client-rds`,
  `client-dynamodb`, `client-sts` are already optional deps loaded via
  `tryImportAws`; spokes that never see Terraform load nothing new.
- State files can be large; the parser reads and normalizes once per scan
  and holds only the normalized resource list.

## Error handling

Every failure degrades to honesty, never to a crash or a guess:

- `.tf` files but no readable state → visibility *blocked*: "Terraform
  detected but no readable state (run `terraform init`, or state lives in a
  backend CrisisMode can't read yet)."
- S3 state fetch fails (no SDK, no creds, AccessDenied) → *blocked* with the
  specific reason and the `s3:GetObject` hint. Scan continues unaffected.
- Observed-side describe denied → that resource reports `unknown` with the
  IAM hint; every other resource still compares (per-check degradation).
- Stale state — state serial/mtime old, or `*.tf` files dirty in git →
  findings still emit but carry a staleness caveat, and severity is capped
  below critical: a stale comparison must not scream.
- Unknown state version / corrupt JSON → a single `iac_state_unreadable`
  finding; no partial output.
- Never: write or lock state, run the terraform binary, mutate AWS.

## Testing

- Unit: state parser against fixture tfstate files (v4, workspace layout,
  S3 backend config in `.terraform/`, `backend "s3"` block fallback,
  unsupported backends, corrupt JSON, unknown version); attribute comparator
  for the deep trio; staleness logic; severity capping.
- Simulator: full diagnose → plan flow per scenario state; knowledge-map
  coverage test extended to the four new finding sources.
- Integration: autodiscovery derives the target from a fixture directory;
  visibility invisible/blocked entries; correlation rule fires only on
  matching instance ids (pairwise regression, per Arc 2).
- Real surface (verify skill): built CLI against a scratch project with a
  realistic tfstate fixture — confirm scan findings, visibility section,
  and suggestion plan text. Live AWS drift check manually if a sandbox
  account is available; CI relies on the simulator.

## Out of scope (this arc)

- Running the terraform CLI (`show` / `plan`) — Arc 4 candidate for
  backends this arc can't read.
- Terraform Cloud, GCS, azurerm, and other non-S3 remote backends
  (detected and reported as blocked, never read).
- Automated backport — writing `.tf` changes to absorb a manual fix. The
  market-gap feature, but it is a write and needs this arc's detection
  layer first.
- HCL parsing beyond the minimal `backend "s3"` block scan; module
  resolution; variable interpolation.
- Non-AWS providers, CloudFormation, Pulumi.
- Attribute-level drift beyond the RDS/S3/DynamoDB trio.
