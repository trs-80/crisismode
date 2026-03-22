# Backup Verification Agent

The backup verification agent proactively verifies that backups exist, are recent, are intact, and cover all critical systems. Unlike most CrisisMode agents that respond to failures, this agent surfaces disaster recovery risks **before** disaster strikes.

## Why backup verification matters

Industry data paints a stark picture:

- **36% of organizations** fail to meet Recovery Time Objectives during actual disasters
- **77%** report slower cyber attack recovery year-over-year
- **31%** haven't updated their DR plans in over a year
- The most common pattern behind catastrophic data loss isn't a failed system — it's a backup that was never tested

CrisisMode's backup verification agent continuously answers five questions about your backups:

1. **Existence** — does a backup exist where you expect it?
2. **Recency** — is it fresh enough to meet your Recovery Point Objective (RPO)?
3. **Integrity** — is the backup complete and uncorrupted?
4. **Coverage** — are all critical systems backed up, or are there gaps?
5. **Restorability** — can recovery happen within your Recovery Time Objective (RTO)?

## Quick start

Add a backup target to your `crisismode.yaml`:

```yaml
targets:
  - name: db-backups
    kind: backup
    primary:
      host: /var/backups/postgres    # backup directory path
      port: 0
      database: orders_db            # source system name
```

Then run a scan:

```bash
crisismode scan
```

The agent appears in scan results with finding ID prefix `BKUP`:

```
BKUP-001  unhealthy  Backup failures detected. Missing or corrupted backups require immediate attention.
```

For deeper analysis:

```bash
crisismode diagnose --target db-backups
```

## Configuration

### Basic: single backup directory

```yaml
targets:
  - name: db-backups
    kind: backup
    primary:
      host: /var/backups/postgres
      port: 0
      database: orders_db
```

### Multiple backup sources

Configure separate targets for each system you want to verify:

```yaml
targets:
  - name: postgres-backups
    kind: backup
    primary:
      host: /var/backups/postgres
      port: 0
      database: orders_db

  - name: app-config-backups
    kind: backup
    primary:
      host: /var/backups/configs
      port: 0
      database: app-config       # "database" field is used as the source name
```

### Configuration fields

| Field | Description | Default |
|---|---|---|
| `host` | Comma-separated backup directory paths | `/var/backups` |
| `port` | Unused (set to `0`) | `0` |
| `database` | Source system name (used in reports and RPO tracking) | `default` |

### RPO/RTO targets

RPO and RTO targets can be passed via the trigger payload when invoking the agent programmatically:

```typescript
const config: BackupProviderConfig = {
  kind: 'file_directory',
  locations: ['/var/backups/postgres'],
  source: 'orders_db',
  rpoSeconds: 3600,    // 1-hour RPO
  rtoSeconds: 1800,    // 30-minute RTO target
};
```

The default RPO is **24 hours** (86,400 seconds).

## Failure scenarios

The agent detects six failure scenarios, ordered by severity:

### `no_backups_found`

No backup files found at any configured location. Your disaster recovery capability is non-existent.

**Typical causes:** backup job never configured, credentials expired, storage unmounted, cron job removed.

**Agent response:** Critical alert to on-call engineer and DBA with investigation checklist.

### `integrity_failure`

Backup files exist but fail integrity checks. The data is corrupted and unusable for recovery.

**Typical causes:** disk corruption, interrupted transfer, compression errors, storage media failure.

**Agent response:** Critical alert. Advises preserving the corrupted file for forensics and running a fresh backup immediately.

### `size_anomaly`

The most recent backup is significantly smaller than the previous one (>50% size drop). This often indicates a truncated dump, a failed job that wrote partial output, or a changed backup scope.

**Typical causes:** backup job killed mid-run, disk full during dump, database tables dropped, backup scope misconfigured.

**Agent response:** High-priority alert with guidance to compare against previous backups and attempt a test restore.

### `stale_backup`

Backups exist and pass integrity checks, but the newest one exceeds the configured RPO target.

**Typical causes:** backup schedule paused, job hanging on a lock, storage quota exceeded, silent cron failure.

**Agent response:** High-priority alert with guidance to check job schedules, lock files, and storage capacity.

### `incomplete_coverage`

Some configured sources have working backups, but other sources have no backup provider configured at all.

**Typical causes:** new database added without backup job, team oversight, misconfigured source list.

**Agent response:** Medium-priority alert identifying which sources are uncovered.

### `rto_at_risk`

Backups are healthy, but their size means estimated restore time may exceed recovery objectives. Based on a conservative 35MB/s restore throughput estimate.

**Typical causes:** database growth outpacing restore infrastructure, no incremental backup strategy, single-threaded restore.

**Agent response:** Advisory with recommendations for incremental backups, parallel restore, and DR drills.

## Architecture

### Provider pattern

The agent uses a **strategy pattern** where backup technologies are pluggable providers:

```
BackupVerificationAgent (coordinator)
  └── BackupBackend
        └── verifyAll(configs[]) → BackupVerificationReport
              ├── Provider: file_directory
              ├── Provider: pg_dump
              └── Provider: ... (future)
```

The agent itself is technology-agnostic. It iterates over configured providers and aggregates results. Each provider implements discovery, inventory, and verification for its backup type.

### BackupProvider interface

```typescript
interface BackupProvider {
  kind: BackupProviderKind;
  detect(config: BackupProviderConfig): Promise<boolean>;
  inventory(config: BackupProviderConfig): Promise<BackupInventoryItem[]>;
  verify(item: BackupInventoryItem, config: BackupProviderConfig): Promise<BackupVerification>;
  estimateRecoveryTime?(item: BackupInventoryItem): Promise<RtoEstimate>;
}
```

### Supported provider kinds

Currently implemented:

| Kind | Description | Detection |
|---|---|---|
| `file_directory` | Backup files in a directory (tar, gz, sql dumps) | Scans directory for files with backup extensions |
| `pg_dump` | PostgreSQL logical backups | Same as file_directory, tuned for `.sql.gz` naming |

Registered but not yet implemented (ready for expansion):

| Kind | Description |
|---|---|
| `pg_basebackup` | PostgreSQL physical backups |
| `zfs_snapshot` | ZFS filesystem snapshots |
| `lvm_snapshot` | LVM logical volume snapshots |
| `etcd_snapshot` | etcd cluster snapshots |
| `velero` | Kubernetes backup via Velero |

The `BackupProviderKind` type is string-extensible, so cloud providers (`aws_rds`, `gcp_cloudsql`, `azure_sql`) can be added without modifying existing code.

### Verification checks

The live client runs four checks against each backup:

| Check | What it does | Failure severity |
|---|---|---|
| `exists` | Confirms the backup file is present | info (always passes if inventoried) |
| `recency` | Compares backup age against RPO target | critical |
| `size_trend` | Compares size to previous backup, flags >50% drops | critical |
| `integrity` | Runs `gzip -t` for `.gz` files, `tar -tf` for `.tar` files | critical |

### Health signals

The agent reports four health signals during `assessHealth`:

| Signal | Healthy | Warning | Critical |
|---|---|---|---|
| `backup_existence` | All sources have backups | — | Any source has no backup |
| `backup_recency` | All within RPO | Any exceeds RPO | — |
| `backup_integrity` | All pass verification | — | Any fails verification |
| `backup_coverage` | All sources covered | Uncovered sources exist | — |

### Recognized backup file extensions

The live client recognizes these file patterns:

```
.sql  .sql.gz  .sql.bz2  .sql.xz  .sql.zst
.dump  .dump.gz
.tar  .tar.gz  .tgz  .tar.bz2  .tar.xz  .tar.zst
.gz  .bz2  .xz  .zst
.bak  .backup
```

## Recovery plans

Recovery plans generated by this agent are **read-only and notification-based**. The agent does not execute backup jobs or restore data. Its role is to detect and alert — recovery actions are left to operators or future agents with appropriate write capabilities.

A typical plan includes:

1. **Enumerate providers** — list configured backup providers
2. **Verify all backups** — run full verification across all providers
3. **Notify on-call** — send findings to on-call engineer and DBA
4. **Checkpoint** — capture verification state for audit trail
5. **Conditional routing** — escalate if verifications failed
6. **Replanning checkpoint** — re-check after notifications
7. **Summary** — final assessment notification

Risk level is `routine` — no system mutations, no service disruption possible.

## Capabilities

Five capabilities are registered in the capability registry:

| Capability | Action | Description |
|---|---|---|
| `backup.inventory.list` | read | Enumerate backup artifacts across providers |
| `backup.verify.integrity` | read | Verify backup completeness and consistency |
| `backup.verify.restore_test` | mutate | Test restore to scratch environment (future) |
| `backup.rpo.evaluate` | read | Evaluate recency against RPO targets |
| `backup.schedule.check` | read | Verify backup job scheduling |

## Adding a new backup provider

To add support for a new backup technology (e.g., AWS RDS snapshots):

### 1. Implement the BackupProvider interface

```typescript
// src/agent/backup/providers/aws-rds.ts
import type { BackupProvider, BackupProviderConfig, BackupInventoryItem, BackupVerification, RtoEstimate } from '../backend.js';

export class AwsRdsBackupProvider implements BackupProvider {
  kind = 'aws_rds' as const;

  async detect(config: BackupProviderConfig): Promise<boolean> {
    // Check for AWS credentials and RDS access
    // e.g., call DescribeDBInstances
  }

  async inventory(config: BackupProviderConfig): Promise<BackupInventoryItem[]> {
    // Call DescribeDBSnapshots / DescribeDBClusterSnapshots
    // Map results to BackupInventoryItem
  }

  async verify(item: BackupInventoryItem, config: BackupProviderConfig): Promise<BackupVerification> {
    // Check snapshot status, age, size trends
    // Return BackupVerification with checks
  }

  async estimateRecoveryTime(item: BackupInventoryItem): Promise<RtoEstimate> {
    // Estimate based on snapshot size + target instance class
  }
}
```

### 2. Register the provider in the live client

The live client would be updated to accept a list of providers and route configs to the appropriate one based on `config.kind`.

### 3. Add capabilities (optional)

If the new provider has unique operations:

```typescript
// In src/framework/capability-registry.ts
{
  id: 'backup.aws.rds.verify',
  actionKind: 'read',
  description: 'Verify AWS RDS automated backup and snapshot status.',
  targetKinds: ['backup'],
  manualFallback: 'Check RDS snapshots manually via AWS Console or aws rds describe-db-snapshots.',
}
```

## Cloud provider readiness

The architecture is designed for cloud expansion. Key properties that enable this:

- **Auth follows conventions** — AWS SDK auto-resolves credentials from `AWS_PROFILE`, IAM roles, IRSA. No special auth plumbing needed.
- **Detection works the same way** — `autodiscovery.ts` already detects AWS/GCP/Azure via env vars.
- **BackupInventoryItem has region/account fields** — ready for cross-region and cross-account verification.
- **RPO/RTO evaluation is provider-agnostic** — the same age comparison and throughput estimation works regardless of backup source.

## Demo mode

The simulator supports all six failure scenarios for demos and testing:

```bash
crisismode demo --agent backup-verification
```

Simulator states: `no_backups_found`, `stale_backup`, `size_anomaly`, `integrity_failure`, `incomplete_coverage`, `rto_at_risk`, `healthy`.

## File structure

```
src/agent/backup/
  backend.ts          # BackupBackend + BackupProvider interfaces
  simulator.ts        # In-memory simulator (7 states, 6 failure scenarios)
  live-client.ts      # Real filesystem verification client
  manifest.ts         # Agent manifest
  agent.ts            # BackupVerificationAgent coordinator
  registration.ts     # Lazy factory for agent registry
```

## Integration points

| Integration | How it works |
|---|---|
| `crisismode scan` | Appears as `BKUP` findings when backup targets are configured |
| `crisismode diagnose` | Full verification with RPO/RTO analysis |
| `crisismode watch` | Continuous backup health monitoring |
| Prometheus alerts | Triggers on `BackupStale` and `BackupFailed` alert names |
| Slack notifications | Sends Block Kit alerts via the notification framework |
| Incident reports | Verification results included in postmortem data |
