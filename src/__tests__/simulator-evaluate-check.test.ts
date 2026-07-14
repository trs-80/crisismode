// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import type { CheckExpression } from '../types/common.js';
import { RedisSimulator } from '../agent/redis/simulator.js';
import { RdsRecoverySimulator } from '../agent/aws-rds/simulator.js';
import { S3RecoverySimulator } from '../agent/aws-s3/simulator.js';
import { DynamoDbRecoverySimulator } from '../agent/aws-dynamodb/simulator.js';
import { FlinkSimulator } from '../agent/flink/simulator.js';
import { EtcdSimulator } from '../agent/etcd/simulator.js';
import { CephSimulator } from '../agent/ceph/simulator.js';
import { KafkaSimulator } from '../agent/kafka/simulator.js';
import { K8sSimulator } from '../agent/kubernetes/simulator.js';
import { PgSimulator } from '../agent/pg-replication/simulator.js';

// ---------------------------------------------------------------------------
// evaluateCheck() dispatch coverage for the simulators whose per-agent test
// files did not already exercise every branch. Each dispatch branch is hit
// with a passing and a failing expectation, and the shared compareCheckValue
// helper's string-fallback (non-numeric eq/neq) and numeric-default (NaN
// operand with an ordering operator) paths are exercised too.
// ---------------------------------------------------------------------------

type Operator = CheckExpression['expect']['operator'];

function mk(
  statement: string,
  operator: Operator,
  value: unknown,
  type = 'check',
): CheckExpression {
  return { type, statement, expect: { operator, value } };
}

describe('RedisSimulator.evaluateCheck()', () => {
  it('PING (string-fallback eq/neq)', async () => {
    const sim = new RedisSimulator();
    expect(await sim.evaluateCheck(mk('PING', 'eq', 'PONG'))).toBe(true);
    expect(await sim.evaluateCheck(mk('PING', 'neq', 'PONG'))).toBe(false);
  });

  it('used_memory_percent (numeric gt/lt)', async () => {
    const sim = new RedisSimulator();
    expect(await sim.evaluateCheck(mk('used_memory_percent', 'gt', 80))).toBe(true);
    expect(await sim.evaluateCheck(mk('used_memory_percent', 'lt', 80))).toBe(false);
  });

  it('connected_clients', async () => {
    const sim = new RedisSimulator();
    expect(await sim.evaluateCheck(mk('connected_clients', 'gt', 500))).toBe(true);
    expect(await sim.evaluateCheck(mk('connected_clients', 'lt', 500))).toBe(false);
  });

  it('blocked_clients', async () => {
    const sim = new RedisSimulator();
    expect(await sim.evaluateCheck(mk('blocked_clients', 'eq', 23))).toBe(true);
    expect(await sim.evaluateCheck(mk('blocked_clients', 'eq', 0))).toBe(false);
  });

  it('evicted_keys', async () => {
    const sim = new RedisSimulator();
    expect(await sim.evaluateCheck(mk('evicted_keys', 'gte', 145_230))).toBe(true);
    expect(await sim.evaluateCheck(mk('evicted_keys', 'lt', 145_230))).toBe(false);
  });

  it('CONFIG GET maxmemory-policy (string eq + NaN-default ordering path)', async () => {
    const sim = new RedisSimulator();
    expect(await sim.evaluateCheck(mk('CONFIG GET maxmemory-policy', 'eq', 'volatile-lru'))).toBe(true);
    expect(await sim.evaluateCheck(mk('CONFIG GET maxmemory-policy', 'eq', 'noeviction'))).toBe(false);
    // Non-numeric operands with an ordering operator hit compareCheckValue's default:false.
    expect(await sim.evaluateCheck(mk('CONFIG GET maxmemory-policy', 'gt', 'noeviction'))).toBe(false);
  });

  it('unknown statement falls through to true', async () => {
    const sim = new RedisSimulator();
    expect(await sim.evaluateCheck(mk('nonexistent', 'eq', 'x'))).toBe(true);
  });
});

describe('RdsRecoverySimulator.evaluateCheck()', () => {
  it('backup_retention_period', async () => {
    const sim = new RdsRecoverySimulator();
    expect(await sim.evaluateCheck(mk('backup_retention_period', 'eq', 0))).toBe(true);
    expect(await sim.evaluateCheck(mk('backup_retention_period', 'gt', 0))).toBe(false);
  });

  it('snapshot_count', async () => {
    const sim = new RdsRecoverySimulator();
    expect(await sim.evaluateCheck(mk('snapshot_count', 'eq', 0))).toBe(true);
    expect(await sim.evaluateCheck(mk('snapshot_count', 'gt', 0))).toBe(false);
  });

  it('automated_backups_enabled (boolean-to-0/1)', async () => {
    const sim = new RdsRecoverySimulator();
    expect(await sim.evaluateCheck(mk('automated_backups_enabled', 'eq', 0))).toBe(true);
    expect(await sim.evaluateCheck(mk('automated_backups_enabled', 'eq', 1))).toBe(false);
  });

  it('instance_status (string-fallback)', async () => {
    const sim = new RdsRecoverySimulator();
    expect(await sim.evaluateCheck(mk('instance_status', 'eq', 'available'))).toBe(true);
    expect(await sim.evaluateCheck(mk('instance_status', 'neq', 'available'))).toBe(false);
  });

  it('unknown statement falls through to true', async () => {
    const sim = new RdsRecoverySimulator();
    expect(await sim.evaluateCheck(mk('nope', 'eq', 1))).toBe(true);
  });
});

describe('S3RecoverySimulator.evaluateCheck()', () => {
  it('versioning_status (string-fallback)', async () => {
    const sim = new S3RecoverySimulator();
    expect(await sim.evaluateCheck(mk('versioning_status', 'eq', 'Suspended'))).toBe(true);
    expect(await sim.evaluateCheck(mk('versioning_status', 'eq', 'Enabled'))).toBe(false);
  });

  it('lifecycle_rule_count', async () => {
    const sim = new S3RecoverySimulator();
    expect(await sim.evaluateCheck(mk('lifecycle_rule_count', 'eq', 0))).toBe(true);
    expect(await sim.evaluateCheck(mk('lifecycle_rule_count', 'gt', 0))).toBe(false);
  });

  it('bucket_exists (string-fallback)', async () => {
    const sim = new S3RecoverySimulator();
    expect(await sim.evaluateCheck(mk('bucket_exists', 'eq', 'true'))).toBe(true);
    expect(await sim.evaluateCheck(mk('bucket_exists', 'neq', 'true'))).toBe(false);
  });

  it('unknown statement falls through to true', async () => {
    const sim = new S3RecoverySimulator();
    expect(await sim.evaluateCheck(mk('nope', 'eq', 1))).toBe(true);
  });
});

describe('DynamoDbRecoverySimulator.evaluateCheck()', () => {
  it('pitr_status (string-fallback)', async () => {
    const sim = new DynamoDbRecoverySimulator();
    expect(await sim.evaluateCheck(mk('pitr_status', 'eq', 'DISABLED'))).toBe(true);
    expect(await sim.evaluateCheck(mk('pitr_status', 'eq', 'ENABLED'))).toBe(false);
  });

  it('continuous_backups_status (string-fallback)', async () => {
    const sim = new DynamoDbRecoverySimulator();
    expect(await sim.evaluateCheck(mk('continuous_backups_status', 'eq', 'DISABLED'))).toBe(true);
    expect(await sim.evaluateCheck(mk('continuous_backups_status', 'neq', 'DISABLED'))).toBe(false);
  });

  it('unknown statement falls through to true', async () => {
    const sim = new DynamoDbRecoverySimulator();
    expect(await sim.evaluateCheck(mk('nope', 'eq', 1))).toBe(true);
  });
});

describe('FlinkSimulator.evaluateCheck()', () => {
  it('job_state (string-fallback)', async () => {
    const sim = new FlinkSimulator();
    expect(await sim.evaluateCheck(mk('job_state', 'eq', 'FAILING'))).toBe(true);
    expect(await sim.evaluateCheck(mk('job_state', 'eq', 'RUNNING'))).toBe(false);
  });

  it('checkpoint_success_rate (2 of 5 completed = 0.4)', async () => {
    const sim = new FlinkSimulator();
    expect(await sim.evaluateCheck(mk('checkpoint_success_rate', 'gt', 0.3))).toBe(true);
    expect(await sim.evaluateCheck(mk('checkpoint_success_rate', 'gt', 0.5))).toBe(false);
  });

  it('backpressure_level (2 high subtasks)', async () => {
    const sim = new FlinkSimulator();
    expect(await sim.evaluateCheck(mk('backpressure_level', 'eq', 2))).toBe(true);
    expect(await sim.evaluateCheck(mk('backpressure_level', 'eq', 0))).toBe(false);
  });

  it('taskmanager_count', async () => {
    const sim = new FlinkSimulator();
    expect(await sim.evaluateCheck(mk('taskmanager_count', 'eq', 3))).toBe(true);
    expect(await sim.evaluateCheck(mk('taskmanager_count', 'lt', 3))).toBe(false);
  });

  it('unknown statement falls through to true', async () => {
    const sim = new FlinkSimulator();
    expect(await sim.evaluateCheck(mk('nope', 'eq', 1))).toBe(true);
  });
});

describe('EtcdSimulator.evaluateCheck()', () => {
  it('endpoint_health (boolean-to-0/1)', async () => {
    const sim = new EtcdSimulator();
    expect(await sim.evaluateCheck(mk('endpoint_health', 'eq', false))).toBe(true);
    expect(await sim.evaluateCheck(mk('endpoint_health', 'eq', true))).toBe(false);
  });

  it('alarm_count', async () => {
    const sim = new EtcdSimulator();
    expect(await sim.evaluateCheck(mk('alarm_count', 'eq', 1))).toBe(true);
    expect(await sim.evaluateCheck(mk('alarm_count', 'eq', 0))).toBe(false);
  });

  it('cluster_size', async () => {
    const sim = new EtcdSimulator();
    expect(await sim.evaluateCheck(mk('cluster_size', 'eq', 3))).toBe(true);
    expect(await sim.evaluateCheck(mk('cluster_size', 'lt', 3))).toBe(false);
  });

  it('unknown statement falls through to true', async () => {
    const sim = new EtcdSimulator();
    expect(await sim.evaluateCheck(mk('nope', 'eq', 1))).toBe(true);
  });
});

describe('CephSimulator.evaluateCheck()', () => {
  it('cluster_health (string-fallback)', async () => {
    const sim = new CephSimulator();
    expect(await sim.evaluateCheck(mk('cluster_health', 'eq', 'HEALTH_ERR'))).toBe(true);
    expect(await sim.evaluateCheck(mk('cluster_health', 'eq', 'HEALTH_OK'))).toBe(false);
  });

  it('osd_up_count', async () => {
    const sim = new CephSimulator();
    expect(await sim.evaluateCheck(mk('osd_up_count', 'eq', 4))).toBe(true);
    expect(await sim.evaluateCheck(mk('osd_up_count', 'gt', 4))).toBe(false);
  });

  it('pg_degraded_count', async () => {
    const sim = new CephSimulator();
    expect(await sim.evaluateCheck(mk('pg_degraded_count', 'gt', 0))).toBe(true);
    expect(await sim.evaluateCheck(mk('pg_degraded_count', 'eq', 0))).toBe(false);
  });

  it('usage_percent (gte boundary vs gt)', async () => {
    const sim = new CephSimulator();
    expect(await sim.evaluateCheck(mk('usage_percent', 'gte', 85))).toBe(true);
    expect(await sim.evaluateCheck(mk('usage_percent', 'gt', 85))).toBe(false);
  });

  it('unknown statement falls through to true', async () => {
    const sim = new CephSimulator();
    expect(await sim.evaluateCheck(mk('nope', 'eq', 1))).toBe(true);
  });
});

describe('KafkaSimulator.evaluateCheck()', () => {
  it('under_replicated_count (urp scenario)', async () => {
    const sim = new KafkaSimulator();
    expect(await sim.evaluateCheck(mk('under_replicated_count', 'eq', 4))).toBe(true);
    expect(await sim.evaluateCheck(mk('under_replicated_count', 'eq', 0))).toBe(false);
  });

  it('consumer_lag (max across groups = 45000)', async () => {
    const sim = new KafkaSimulator();
    expect(await sim.evaluateCheck(mk('consumer_lag', 'gt', 40_000))).toBe(true);
    expect(await sim.evaluateCheck(mk('consumer_lag', 'lt', 40_000))).toBe(false);
  });

  it('broker_count (alive brokers)', async () => {
    const sim = new KafkaSimulator();
    expect(await sim.evaluateCheck(mk('broker_count', 'eq', 3))).toBe(true);
    expect(await sim.evaluateCheck(mk('broker_count', 'lt', 3))).toBe(false);
  });

  it('leaderless_partition_count (0 in urp, 3 in broker_down)', async () => {
    const urp = new KafkaSimulator();
    expect(await urp.evaluateCheck(mk('leaderless_partition_count', 'eq', 0))).toBe(true);
    expect(await urp.evaluateCheck(mk('leaderless_partition_count', 'gt', 0))).toBe(false);

    const down = new KafkaSimulator('broker_down');
    expect(await down.evaluateCheck(mk('leaderless_partition_count', 'eq', 3))).toBe(true);
  });

  it('broker_liveness:N (reachable → 1, unreachable → 0)', async () => {
    const urp = new KafkaSimulator();
    expect(await urp.evaluateCheck(mk('broker_liveness:0', 'eq', 1))).toBe(true);
    expect(await urp.evaluateCheck(mk('broker_liveness:0', 'eq', 0))).toBe(false);

    const down = new KafkaSimulator('broker_down');
    expect(await down.evaluateCheck(mk('broker_liveness:2', 'eq', 0))).toBe(true);
  });

  it('consumer_group_rebalancing_count (1 non-Stable group in urp)', async () => {
    const sim = new KafkaSimulator();
    expect(await sim.evaluateCheck(mk('consumer_group_rebalancing_count', 'eq', 1))).toBe(true);
    expect(await sim.evaluateCheck(mk('consumer_group_rebalancing_count', 'eq', 0))).toBe(false);
  });

  it('unknown statement falls through to true', async () => {
    const sim = new KafkaSimulator();
    expect(await sim.evaluateCheck(mk('nope', 'eq', 1))).toBe(true);
  });
});

describe('K8sSimulator.evaluateCheck()', () => {
  it('node_ready_count (2 Ready of 3)', async () => {
    const sim = new K8sSimulator();
    expect(await sim.evaluateCheck(mk('node_ready_count', 'eq', 2))).toBe(true);
    expect(await sim.evaluateCheck(mk('node_ready_count', 'eq', 3))).toBe(false);
  });

  it('pod_crashloop_count (3 crashlooping)', async () => {
    const sim = new K8sSimulator();
    expect(await sim.evaluateCheck(mk('pod_crashloop_count', 'eq', 3))).toBe(true);
    expect(await sim.evaluateCheck(mk('pod_crashloop_count', 'eq', 0))).toBe(false);
  });

  it('deployment_ready (boolean-to-0/1, not all ready)', async () => {
    const sim = new K8sSimulator();
    expect(await sim.evaluateCheck(mk('deployment_ready', 'eq', false))).toBe(true);
    expect(await sim.evaluateCheck(mk('deployment_ready', 'eq', true))).toBe(false);
  });

  it('deployment_ready true once recovered', async () => {
    const sim = new K8sSimulator();
    sim.transition('recovered');
    expect(await sim.evaluateCheck(mk('deployment_ready', 'eq', true))).toBe(true);
  });

  it('unknown statement falls through to true', async () => {
    const sim = new K8sSimulator();
    expect(await sim.evaluateCheck(mk('nope', 'eq', 1))).toBe(true);
  });
});

describe('PgSimulator.evaluateCheck()', () => {
  const REPL_STREAMING =
    "SELECT count(*) FROM pg_stat_replication WHERE client_addr = '10.0.1.52' AND state = 'streaming'";
  const REPL_PRESENT =
    "SELECT count(*) FROM pg_stat_replication WHERE client_addr = '10.0.1.52'";
  // Deliberately avoids the literal "pg_stat_replication" so the earlier
  // replica-present branch does not intercept this before the replay_lag branch.
  const REPLAY_LAG =
    "SELECT replay_lag FROM replication_status WHERE client_addr = '10.0.1.52'";
  const REPLAY_PAUSED = 'SELECT pg_is_wal_replay_paused()';
  const IDLE_IN_TX =
    "SELECT count(*) FROM pg_stat_activity WHERE state = 'idle in transaction' " +
    "AND now() - state_change > INTERVAL '30 seconds'";

  it('streaming replication branch (degraded → 1)', async () => {
    const sim = new PgSimulator();
    expect(await sim.evaluateCheck(mk(REPL_STREAMING, 'gte', 1))).toBe(true);
    expect(await sim.evaluateCheck(mk(REPL_STREAMING, 'eq', 0))).toBe(false);
  });

  it('replica-present branch (no streaming qualifier)', async () => {
    const sim = new PgSimulator();
    expect(await sim.evaluateCheck(mk(REPL_PRESENT, 'gte', 1))).toBe(true);
    expect(await sim.evaluateCheck(mk(REPL_PRESENT, 'eq', 0))).toBe(false);
  });

  it('replay_lag branch (degraded → 0, recovered → 1)', async () => {
    const sim = new PgSimulator();
    expect(await sim.evaluateCheck(mk(REPLAY_LAG, 'eq', 0))).toBe(true);
    sim.transition('recovered');
    expect(await sim.evaluateCheck(mk(REPLAY_LAG, 'eq', 1))).toBe(true);
  });

  it('wal_replay_paused branch (toggle via pauseReplay)', async () => {
    const sim = new PgSimulator();
    expect(await sim.evaluateCheck(mk(REPLAY_PAUSED, 'eq', 0))).toBe(true);
    sim.pauseReplay();
    expect(await sim.evaluateCheck(mk(REPLAY_PAUSED, 'eq', 1))).toBe(true);
    expect(await sim.evaluateCheck(mk(REPLAY_PAUSED, 'eq', 0))).toBe(false);
  });

  it('idle-in-transaction count branch (threshold parsed from statement)', async () => {
    const sim = new PgSimulator();
    // No leaked sessions by default.
    expect(await sim.evaluateCheck(mk(IDLE_IN_TX, 'eq', 0))).toBe(true);
    expect(await sim.evaluateCheck(mk(IDLE_IN_TX, 'gt', 0))).toBe(false);
    // 20 sessions aged 120s, all above the 30s threshold.
    sim.setConnectionPoolExhausted(20, 4, 120);
    expect(await sim.evaluateCheck(mk(IDLE_IN_TX, 'gte', 20))).toBe(true);
  });

  it('structured_command eq branch', async () => {
    const sim = new PgSimulator();
    expect(await sim.evaluateCheck(mk('service_state', 'eq', 'running', 'structured_command'))).toBe(true);
    expect(await sim.evaluateCheck(mk('service_state', 'eq', 'stopped', 'structured_command'))).toBe(false);
  });

  it('unknown statement falls through to true', async () => {
    const sim = new PgSimulator();
    expect(await sim.evaluateCheck(mk('nope', 'eq', 1))).toBe(true);
  });
});
