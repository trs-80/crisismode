// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import type { CheckExpression, Command } from '../types/common.js';
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
import { TlsSimulator } from '../agent/tls/simulator.js';
import { DiskSimulator } from '../agent/disk/simulator.js';
import { DnsSimulator } from '../agent/dns/simulator.js';
import { IacDriftSimulator } from '../agent/iac-drift/simulator.js';
import { ServiceStatusSimulator } from '../agent/service-status/simulator.js';

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

  it('unknown statement fails closed', async () => {
    const sim = new RedisSimulator();
    expect(await sim.evaluateCheck(mk('nonexistent', 'eq', 'x'))).toBe(false);
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

  it('unknown statement fails closed', async () => {
    const sim = new RdsRecoverySimulator();
    expect(await sim.evaluateCheck(mk('nope', 'eq', 1))).toBe(false);
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

  it('unknown statement fails closed', async () => {
    const sim = new S3RecoverySimulator();
    expect(await sim.evaluateCheck(mk('nope', 'eq', 1))).toBe(false);
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

  it('unknown statement fails closed', async () => {
    const sim = new DynamoDbRecoverySimulator();
    expect(await sim.evaluateCheck(mk('nope', 'eq', 1))).toBe(false);
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

  it('unknown statement fails closed', async () => {
    const sim = new FlinkSimulator();
    expect(await sim.evaluateCheck(mk('nope', 'eq', 1))).toBe(false);
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

  it('unknown statement fails closed', async () => {
    const sim = new EtcdSimulator();
    expect(await sim.evaluateCheck(mk('nope', 'eq', 1))).toBe(false);
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

  it('unknown statement fails closed', async () => {
    const sim = new CephSimulator();
    expect(await sim.evaluateCheck(mk('nope', 'eq', 1))).toBe(false);
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

  it('unknown statement fails closed', async () => {
    const sim = new KafkaSimulator();
    expect(await sim.evaluateCheck(mk('nope', 'eq', 1))).toBe(false);
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

  it('unknown statement fails closed', async () => {
    const sim = new K8sSimulator();
    expect(await sim.evaluateCheck(mk('nope', 'eq', 1))).toBe(false);
  });
});

describe('PgSimulator.evaluateCheck()', () => {
  const REPL_STREAMING =
    "SELECT count(*) FROM pg_stat_replication WHERE client_addr = '10.0.1.52' AND state = 'streaming'";
  const REPL_PRESENT =
    "SELECT count(*) FROM pg_stat_replication WHERE client_addr = '10.0.1.52'";
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

  it('structured_command load-balancer service_status branch (the real check step-005/step-009a emit)', async () => {
    const sim = new PgSimulator();
    const loadBalancerStatus = (value: unknown): CheckExpression => ({
      type: 'structured_command',
      operation: 'service_status',
      parameters: { service: 'load-balancer' },
      expect: { operator: 'eq', value },
    });
    expect(await sim.evaluateCheck(loadBalancerStatus('running'))).toBe(true);
    expect(await sim.evaluateCheck(loadBalancerStatus('stopped'))).toBe(false);
  });

  it('structured_command fails closed for a statement/operation this simulator does not recognize, even with expect eq "running" (CodeRabbit finding A)', async () => {
    // The old generic `check.type === 'structured_command' && operator ===
    // 'eq' -> value === 'running'` branch returned true for ANY unknown
    // structured_command check whose expected value happened to be
    // 'running' — a fail-open remnant. Only the load-balancer
    // service_status check above should pass.
    const sim = new PgSimulator();
    expect(await sim.evaluateCheck(mk('nope', 'eq', 'running', 'structured_command'))).toBe(false);
    expect(await sim.evaluateCheck({
      type: 'structured_command',
      operation: 'service_status',
      parameters: { service: 'some-unrelated-service' },
      expect: { operator: 'eq', value: 'running' },
    })).toBe(false);
  });

  it("'SELECT 1;' primary-reachability branch", async () => {
    const sim = new PgSimulator();
    expect(await sim.evaluateCheck(mk('SELECT 1;', 'eq', 1))).toBe(true);
    expect(await sim.evaluateCheck(mk('SELECT 1;', 'eq', 0))).toBe(false);
  });

  it("'SELECT 1;' reports unreachable (0) rather than unconditionally reachable (final-review M6)", async () => {
    // The database_unreachable plan's restart step uses 'SELECT 1;' as a
    // success criterion ("PostgreSQL is accepting connections"). A simulator
    // whose replication query throws (the UnreachablePgSimulator pattern
    // from pg-unreachable-plan.test.ts) must make this check honest instead
    // of unconditionally reporting reachable.
    class UnreachablePgSimulator extends PgSimulator {
      override async queryReplicationStatus(): Promise<never> {
        throw new Error('connection refused');
      }
    }
    const sim = new UnreachablePgSimulator();
    expect(await sim.evaluateCheck(mk('SELECT 1;', 'eq', 0))).toBe(true);
    expect(await sim.evaluateCheck(mk('SELECT 1;', 'eq', 1))).toBe(false);
  });

  it('replication slot count reflects drop/create via executeCommand (replan flow)', async () => {
    const sim = new PgSimulator();
    const slotName = 'replica_us_east_1b';
    const countCheck = (n: number) =>
      mk(`SELECT count(*) FROM pg_replication_slots WHERE slot_name = '${slotName}';`, 'eq', n);

    // Slot exists initially.
    expect(await sim.evaluateCheck(countCheck(1))).toBe(true);
    expect(await sim.evaluateCheck(countCheck(0))).toBe(false);

    await sim.executeCommand({
      type: 'sql',
      subtype: 'function_call',
      statement: `SELECT pg_drop_replication_slot('${slotName}');`,
    } as Command);
    expect(await sim.evaluateCheck(countCheck(0))).toBe(true);
    expect(await sim.evaluateCheck(countCheck(1))).toBe(false);

    await sim.executeCommand({
      type: 'sql',
      subtype: 'function_call',
      statement: `SELECT pg_create_physical_replication_slot('${slotName}');`,
    } as Command);
    expect(await sim.evaluateCheck(countCheck(1))).toBe(true);
    expect(await sim.evaluateCheck(countCheck(0))).toBe(false);
  });

  it('queryReplicationSlots() reflects a drop/create rather than always returning all three slots (final-review M5)', async () => {
    const sim = new PgSimulator();
    const slotName = 'replica_us_east_1b';

    expect((await sim.queryReplicationSlots()).map((s) => s.slot_name)).toContain(slotName);

    await sim.executeCommand({
      type: 'sql',
      subtype: 'function_call',
      statement: `SELECT pg_drop_replication_slot('${slotName}');`,
    } as Command);
    // evaluateCheck's slot-count query already reports 0 after a drop; the
    // slot listing used by diagnose() and the slot_state_before_drop capture
    // must agree — a dropped slot must not still appear in the listing.
    expect((await sim.queryReplicationSlots()).map((s) => s.slot_name)).not.toContain(slotName);

    await sim.executeCommand({
      type: 'sql',
      subtype: 'function_call',
      statement: `SELECT pg_create_physical_replication_slot('${slotName}');`,
    } as Command);
    expect((await sim.queryReplicationSlots()).map((s) => s.slot_name)).toContain(slotName);
  });

  it('creating a brand-new slot name (not one of the three modeled fixtures) is reflected in both the count check and the listing (CodeRabbit finding C)', async () => {
    const sim = new PgSimulator();
    const newSlotName = 'replica_ap_southeast_2a';
    const countCheck = (n: number) =>
      mk(`SELECT count(*) FROM pg_replication_slots WHERE slot_name = '${newSlotName}';`, 'eq', n);

    // Doesn't exist yet — neither the count check nor the listing know about it.
    expect(await sim.evaluateCheck(countCheck(0))).toBe(true);
    expect((await sim.queryReplicationSlots()).map((s) => s.slot_name)).not.toContain(newSlotName);

    await sim.executeCommand({
      type: 'sql',
      subtype: 'function_call',
      statement: `SELECT pg_create_physical_replication_slot('${newSlotName}');`,
    } as Command);

    // Both sources of truth must agree that it now exists.
    expect(await sim.evaluateCheck(countCheck(1))).toBe(true);
    const slotsAfterCreate = await sim.queryReplicationSlots();
    expect(slotsAfterCreate.map((s) => s.slot_name)).toContain(newSlotName);
    expect(slotsAfterCreate.find((s) => s.slot_name === newSlotName)?.wal_status).toBe('reserved');
  });

  it('returns false for unknown statement (fail-closed)', async () => {
    const sim = new PgSimulator();
    expect(await sim.evaluateCheck(mk('nope', 'eq', 1))).toBe(false);
  });

  describe('client_addr checks are parameterized on address (final-review I4)', () => {
    const presentCheck = (addr: string, streaming = false) =>
      mk(
        `SELECT count(*) FROM pg_stat_replication WHERE client_addr = '${addr}'${streaming ? " AND state = 'streaming'" : ''};`,
        'gte',
        1,
      );

    it('10.0.1.50 is connected in every state (never disconnected in this model)', async () => {
      const sim = new PgSimulator();
      expect(await sim.evaluateCheck(presentCheck('10.0.1.50'))).toBe(true);
      sim.transition('recovering');
      expect(await sim.evaluateCheck(presentCheck('10.0.1.50'))).toBe(true);
      sim.transition('recovered');
      expect(await sim.evaluateCheck(presentCheck('10.0.1.50'))).toBe(true);
    });

    it("still answers honestly for the literal '10.0.1.52' address the demo/tests hardcode — degraded and recovered semantics are unchanged", async () => {
      const sim = new PgSimulator();
      // degraded: connected and streaming (matches the pre-existing REPL_STREAMING/REPL_PRESENT tests above)
      expect(await sim.evaluateCheck(presentCheck('10.0.1.52', true))).toBe(true);
      expect(await sim.evaluateCheck(presentCheck('10.0.1.52', false))).toBe(true);
      // recovering: disconnected (this is the target of the initial disconnect step)
      sim.transition('recovering');
      expect(await sim.evaluateCheck(presentCheck('10.0.1.52', true))).toBe(false);
      expect(await sim.evaluateCheck(presentCheck('10.0.1.52', false))).toBe(false);
      // recovered: reconnected via basebackup
      sim.transition('recovered');
      expect(await sim.evaluateCheck(presentCheck('10.0.1.52', true))).toBe(true);
      expect(await sim.evaluateCheck(presentCheck('10.0.1.52', false))).toBe(true);
    });

    it('a non-.52 target address is answered from the modeled replica set instead of falling through to fail-closed', async () => {
      const sim = new PgSimulator();
      sim.transition('recovering');
      // 10.0.1.51 IS present in the 'recovering' state's modeled replica
      // list — the check must reflect that instead of unconditionally
      // failing closed just because the address isn't the literal '10.0.1.52'
      // the simulator used to hardcode.
      expect(await sim.evaluateCheck(presentCheck('10.0.1.51', true))).toBe(true);
      expect(await sim.evaluateCheck(presentCheck('10.0.1.51', false))).toBe(true);
    });

    it('an address absent from the current state reports not-connected rather than fail-closed', async () => {
      const sim = new PgSimulator();
      // 10.0.1.99 never appears in any state's modeled replica list.
      expect(await sim.evaluateCheck(presentCheck('10.0.1.99'))).toBe(false);
    });

    it('honors an explicit state predicate that does not match the modeled state (CodeRabbit finding D)', async () => {
      // Every modeled replica is always 'streaming', so a real plan check
      // (which only ever asks for state = 'streaming') sees no behavior
      // change. But the merged branch matches on client_addr alone and
      // ignores any state predicate in the statement — a check asking for
      // a state no replica is ever modeled as (e.g. 'catchup') must report
      // not-matching rather than reusing the address-only presence answer.
      const sim = new PgSimulator();
      const catchupCheck = mk(
        "SELECT count(*) FROM pg_stat_replication WHERE client_addr = '10.0.1.52' AND state = 'catchup';",
        'gte',
        1,
      );
      expect(await sim.evaluateCheck(catchupCheck)).toBe(false);
    });
  });
});

describe('TlsSimulator.evaluateCheck()', () => {
  it('cert_valid counts endpoints whose chain validates', async () => {
    const sim = new TlsSimulator();
    // Default 'cert_expiring' state: internal.example.com is self-signed
    // (invalid); the other two endpoints validate.
    expect(await sim.evaluateCheck(mk('cert_valid', 'eq', 2))).toBe(true);
    expect(await sim.evaluateCheck(mk('cert_valid', 'eq', 3))).toBe(false);
  });

  it('days_until_expiry reflects the soonest-expiring certificate', async () => {
    const sim = new TlsSimulator();
    expect(await sim.evaluateCheck(mk('days_until_expiry', 'lte', 5))).toBe(true);
    expect(await sim.evaluateCheck(mk('days_until_expiry', 'gt', 30))).toBe(false);
  });

  it('hostname_match is true when all endpoints match', async () => {
    const sim = new TlsSimulator();
    expect(await sim.evaluateCheck(mk('hostname_match', 'eq', true))).toBe(true);
  });

  it('unknown statement falls through to false (fail-closed)', async () => {
    const sim = new TlsSimulator();
    expect(await sim.evaluateCheck(mk('nope', 'eq', 1))).toBe(false);
  });
});

describe('DiskSimulator.evaluateCheck()', () => {
  it('available_bytes (min across filesystems)', async () => {
    const sim = new DiskSimulator();
    expect(await sim.evaluateCheck(mk('available_bytes', 'gt', 0))).toBe(true);
    expect(await sim.evaluateCheck(mk('available_bytes', 'lt', 0))).toBe(false);
  });

  it('unknown statement fails closed', async () => {
    const sim = new DiskSimulator();
    expect(await sim.evaluateCheck(mk('nope', 'eq', 1))).toBe(false);
  });
});

describe('DnsSimulator.evaluateCheck()', () => {
  it('resolver_reachable (2 of 3 resolvers reachable in the default state)', async () => {
    const sim = new DnsSimulator();
    expect(await sim.evaluateCheck(mk('resolver_reachable', 'eq', 2))).toBe(true);
    expect(await sim.evaluateCheck(mk('resolver_reachable', 'eq', 3))).toBe(false);
  });

  it('unknown statement fails closed', async () => {
    const sim = new DnsSimulator();
    expect(await sim.evaluateCheck(mk('nope', 'eq', 1))).toBe(false);
  });
});

describe('IacDriftSimulator.evaluateCheck()', () => {
  it('iac_drift_count (non-negative in the default drifted scenario)', async () => {
    const sim = new IacDriftSimulator();
    expect(await sim.evaluateCheck(mk('iac_drift_count', 'gte', 0))).toBe(true);
    expect(await sim.evaluateCheck(mk('iac_drift_count', 'lt', 0))).toBe(false);
  });

  it('unknown statement fails closed', async () => {
    const sim = new IacDriftSimulator();
    expect(await sim.evaluateCheck(mk('nope', 'eq', 1))).toBe(false);
  });
});

describe('ServiceStatusSimulator.evaluateCheck()', () => {
  it('service_verdict (string-fallback, worst verdict of the single configured service)', async () => {
    const sim = new ServiceStatusSimulator();
    sim.transition('incident');
    expect(await sim.evaluateCheck(mk('service_verdict', 'eq', 'confirmed_incident'))).toBe(true);
    expect(await sim.evaluateCheck(mk('service_verdict', 'eq', 'healthy'))).toBe(false);
  });

  it('unreachable_service_count counts down_for_you/unreachable_* verdicts', async () => {
    const reachable = new ServiceStatusSimulator();
    reachable.transition('healthy');
    expect(await reachable.evaluateCheck(mk('unreachable_service_count', 'eq', 0))).toBe(true);

    const unreachable = new ServiceStatusSimulator();
    unreachable.transition('down_for_you');
    expect(await unreachable.evaluateCheck(mk('unreachable_service_count', 'eq', 1))).toBe(true);
    expect(await unreachable.evaluateCheck(mk('unreachable_service_count', 'eq', 0))).toBe(false);
  });

  it('unknown statement fails closed', async () => {
    const sim = new ServiceStatusSimulator();
    expect(await sim.evaluateCheck(mk('nope', 'eq', 1))).toBe(false);
  });
});
