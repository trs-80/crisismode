---
name: "pg-replication-lag-recovery"
version: "1.0.0"
description: "Automated recovery for PostgreSQL replication lag exceeding thresholds"
agent: pg-replication
provider: aws
severity: elevated
triggers:
  - alert: pg_replication_lag_seconds
    condition: "> 300"
    duration: 5m
  - alert: pg_wal_sender_timeout
    duration: 2m
requires:
  contexts:
    - type: database_read
      target: primary
    - type: database_write
      target: primary
    - type: database_read
      target: replica
  tools:
    - psql
tags:
  - postgresql
  - replication
  - aws
  - rds
author: "crisismode"
estimatedDuration: "30m"
---

# PostgreSQL Replication Lag Recovery

Recovery procedure for PostgreSQL replication lag exceeding safe thresholds.
This playbook handles detection, notification, traffic redirection, and
resynchronization of lagging replicas.

### 1. Assess replication lag
- type: diagnosis_action
- description: Query replication status on primary and replica
- target: primary
- executionContext: pg-primary-readonly

```sql
SELECT client_addr, state, sent_lsn, write_lsn, replay_lsn,
       extract(epoch from replay_lag) as lag_seconds
FROM pg_stat_replication;
```

### 2. Notify on-call DBA
- type: human_notification
- channel: pagerduty
- message: "Replication lag detected: {diagnosis.lag_seconds}s on replica"

### 3. Pre-recovery state capture
- type: checkpoint
- description: Capture current replication state before intervention

### 4. Disconnect lagging replica
- type: system_action
- risk: elevated
- target: replica
- executionContext: pg-primary-write
- capability: db.replica.disconnect
- preserve: replication_slot_state, replica_connection_info
- precondition: "Replica is currently connected to primary"
- success: "WAL sender for replica is no longer present"
- blast_radius:
  max_affected_rows: 0
  max_downtime_seconds: 30

### 5. Redirect read traffic
- type: system_action
- risk: routine
- description: Update connection pool to exclude disconnected replica
- target: connection-pool
- capability: traffic.backend.detach

### 6. Assess recovery progress
- type: replanning_checkpoint
- description: Re-evaluate whether resynchronization is needed
- timeout: 60s

### 7. Approve resynchronization
- type: human_approval
- timeout: 15m
- escalation: page_oncall

Approve full replica resynchronization via pg_basebackup.
This will take the replica offline for the duration of the sync.

### 8. Resynchronize replica
- type: system_action
- risk: high
- description: Full resync via pg_basebackup
- target: replica
- capability: db.replica.reseed
- preserve: replication_slot_state, replica_data_directory_manifest
- blast_radius:
  max_downtime_seconds: 1800
  requires_maintenance_window: true

```sh
pg_basebackup -h primary -D /var/lib/postgresql/data --checkpoint=fast
```

### 9. Verify or escalate
- type: conditional
- condition: "replica.is_streaming AND replica.lag_seconds < 10"
- on_success: "Restore read traffic to replica"
- on_failure: "Notify DBA team — manual intervention required"

### 10. Recovery summary
- type: human_notification
- channel: default
- template: recovery_summary

## Rollback

If replica promotion or resync fails:
1. Restore read traffic to remaining healthy replicas
2. Page the DBA team with full forensic record
3. Do NOT attempt a second resync without human approval
