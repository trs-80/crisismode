#!/bin/bash
set -euo pipefail

# Injects long-running queries that hold locks and block other operations.
# Simulates the scenario where an unoptimized query or stuck migration blocks
# normal database operations.

NUM_QUERIES="${1:-5}"
DURATION="${2:-300}"  # seconds each query holds its lock

echo "💉 Injecting long-running blocking queries..."
echo "   Count: $NUM_QUERIES queries"
echo "   Duration: ${DURATION}s each"
echo ""

# Create a lock target table if it doesn't exist
podman exec cm-pg-primary psql -U crisismode -c \
    "CREATE TABLE IF NOT EXISTS _lock_target (id int PRIMARY KEY, data text);
     INSERT INTO _lock_target VALUES (1, 'lock_target') ON CONFLICT DO NOTHING;" > /dev/null 2>&1

# Open queries that hold row-level locks
for i in $(seq 1 "$NUM_QUERIES"); do
    podman exec -d cm-pg-primary psql -U crisismode -c \
        "BEGIN;
         SELECT * FROM _lock_target WHERE id = 1 FOR UPDATE;
         SELECT pg_sleep($DURATION);
         COMMIT;" > /dev/null 2>&1
    echo "   🔒 Blocking query $i/$NUM_QUERIES started (holds lock for ${DURATION}s)"
done

# Also run some expensive sequential scans
for i in $(seq 1 "$NUM_QUERIES"); do
    podman exec -d cm-pg-primary psql -U crisismode -c \
        "SELECT o1.id, o2.id, o1.total + o2.total
         FROM orders o1
         CROSS JOIN orders o2
         WHERE o1.customer_id = o2.customer_id
         LIMIT 1000000;" > /dev/null 2>&1
    echo "   🐌 Expensive query $i/$NUM_QUERIES started"
done

echo ""
echo "   📊 Long-running queries:"
podman exec cm-pg-primary psql -U crisismode -c \
    "SELECT pid, now() - query_start AS duration, state, left(query, 60) AS query
     FROM pg_stat_activity
     WHERE state != 'idle' AND query NOT LIKE '%pg_stat_activity%'
     ORDER BY duration DESC NULLS LAST
     LIMIT 15;"

echo ""
echo "   To clear, run: ./reset.sh"
