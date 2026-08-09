---
name: "redis-memory-pressure-recovery"
version: "1.0.0"
description: "Recovery procedure for Redis memory pressure and eviction events"
agent: redis
severity: elevated
triggers:
  - alert: redis_memory_usage_percent
    condition: "> 85"
    duration: 5m
  - alert: redis_evicted_keys_total
    condition: "> 1000"
    duration: 10m
requires:
  contexts:
    - type: cache_read
      target: redis-primary
    - type: cache_write
      target: redis-primary
  tools:
    - redis-cli
tags:
  - redis
  - memory
  - cache
author: "crisismode"
estimatedDuration: "15m"
---

# Redis Memory Pressure Recovery

Recovery procedure for Redis instances experiencing memory pressure,
high eviction rates, or approaching maxmemory limits.

### 1. Diagnose memory state
- type: diagnosis_action
- description: Collect memory usage, eviction stats, and key distribution
- target: redis-primary

```sh
# -e turns a Redis error reply into a nonzero exit, and set -e stops the block on
# the first failure — the whole block is one command to the engine, so without it
# only the last line's status would be reported. A diagnosis that could not read
# the instance must fail here rather than hand later steps an empty reading.
set -e
redis-cli -e INFO memory
redis-cli -e INFO stats
redis-cli -e DBSIZE
```

### 2. Notify operations team
- type: human_notification
- channel: default
- message: "Redis memory pressure detected: {diagnosis.used_memory_percent}% used"

### 3. Capture pre-recovery state
- type: checkpoint
- description: Snapshot memory stats and configuration before changes

### 4. Clear expired keys
- type: system_action
- risk: routine
- description: Reclaim memory from keys already past their TTL by touching a bounded sample of the keyspace
- target: redis-primary
- capability: cache.expiry.trigger

```sh
# Bounded sample of the keyspace. Reading a key that is already past its TTL is
# what makes Redis reclaim it; keys still inside their TTL, and keys with no TTL
# at all, are read and left alone. This step deletes nothing itself.
# Every redis-cli call runs with -e and is checked, so a failed SCAN or TTL fails
# the step rather than reporting a cleanup that never happened. Without -e,
# redis-cli exits 0 even when Redis answers with an error reply such as NOAUTH.
set -u
limit=1000
cursor=0
scanned=0
rounds=0

while [ "$scanned" -lt "$limit" ] && [ "$rounds" -lt 50 ]; do
  rounds=$((rounds + 1))
  if ! reply=$(redis-cli -e SCAN "$cursor" COUNT 100); then
    echo "SCAN failed at cursor $cursor" >&2
    exit 1
  fi

  # First line of a SCAN reply is the next cursor; the rest are keys.
  first=1
  while IFS= read -r key; do
    if [ "$first" -eq 1 ]; then cursor=$key; first=0; continue; fi
    [ -n "$key" ] || continue
    if ! redis-cli -e TTL "$key" > /dev/null; then
      echo "TTL failed for key: $key" >&2
      exit 1
    fi
    scanned=$((scanned + 1))
    [ "$scanned" -lt "$limit" ] || break
  done <<EOF
$reply
EOF

  [ "$cursor" != "0" ] || break
done

echo "touched $scanned keys, deleted none"
```

### 5. Evaluate memory after cleanup
- type: replanning_checkpoint
- description: Check if expiration cleanup freed sufficient memory
- timeout: 30s

### 6. Approve maxmemory adjustment
- type: human_approval
- timeout: 10m
- escalation: page_oncall

If memory is still critical after cleanup, increase maxmemory limit
temporarily to prevent further evictions while the team investigates.

### 7. Adjust maxmemory
- type: system_action
- risk: elevated
- description: Temporarily increase maxmemory to relieve pressure
- target: redis-primary
- capability: cache.config.set
- preserve: maxmemory_config, memory_usage_stats
- precondition: "Host has available system memory"
- success: "Redis used_memory_percent below 80%"
- blast_radius:
  max_downtime_seconds: 0

```sh
# -e is what makes a rejected CONFIG SET fail this step. Without it redis-cli exits
# 0 after Redis refuses the value — a bad unit is enough — and the plan continues
# to step 8 reporting that maxmemory was raised when nothing changed.
redis-cli -e CONFIG SET maxmemory 8gb
```

### 8. Recovery complete
- type: human_notification
- channel: default
- template: recovery_summary

## Rollback

If maxmemory adjustment causes issues:
1. Revert to original maxmemory setting
2. Enable `volatile-lru` eviction policy as a safety net
3. Page the team for manual key analysis
