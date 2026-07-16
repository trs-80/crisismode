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
redis-cli INFO memory
redis-cli INFO stats
redis-cli DBSIZE
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
- description: Force lazy expiration scan to reclaim memory from expired keys
- target: redis-primary
- capability: cache.expiry.trigger

```sh
redis-cli DEBUG JMAP
redis-cli SCAN 0 COUNT 10000
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
redis-cli CONFIG SET maxmemory 8gb
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
