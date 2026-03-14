#!/bin/bash
set -euo pipefail

# Resets all injected failures and restores the test environment to a healthy state.

echo "🔄 Resetting test environment to healthy state..."
echo ""

# 1. Resume WAL replay on replica
echo "   [1/5] Resuming WAL replay on replica..."
podman exec cm-pg-replica psql -U crisismode -c \
    "SELECT pg_wal_replay_resume();" > /dev/null 2>&1 \
    && echo "         ✅ WAL replay resumed" \
    || echo "         ⏭️  Already running"

# 2. Terminate all non-essential connections
echo "   [2/5] Terminating flood connections..."
podman exec cm-pg-primary psql -U crisismode -c \
    "SELECT pg_terminate_backend(pid)
     FROM pg_stat_activity
     WHERE pid != pg_backend_pid()
       AND query LIKE '%pg_sleep%'
       AND state = 'active';" > /dev/null 2>&1
echo "         ✅ Sleep connections terminated"

# 3. Cancel long-running queries
echo "   [3/5] Cancelling long-running queries..."
podman exec cm-pg-primary psql -U crisismode -c \
    "SELECT pg_cancel_backend(pid)
     FROM pg_stat_activity
     WHERE pid != pg_backend_pid()
       AND state = 'active'
       AND now() - query_start > interval '10 seconds'
       AND query NOT LIKE '%pg_stat_activity%';" > /dev/null 2>&1
echo "         ✅ Long queries cancelled"

# 4. Drop abandoned replication slots
echo "   [4/5] Cleaning up abandoned replication slots..."
podman exec cm-pg-primary psql -U crisismode -c \
    "SELECT pg_drop_replication_slot(slot_name)
     FROM pg_replication_slots
     WHERE NOT active AND slot_name != 'replica_1';" > /dev/null 2>&1
echo "         ✅ Abandoned slots dropped"

# 5. Clean up lock target table
echo "   [5/5] Cleaning up test artifacts..."
podman exec cm-pg-primary psql -U crisismode -c \
    "DROP TABLE IF EXISTS _lock_target;" > /dev/null 2>&1
echo "         ✅ Test artifacts removed"

echo ""
echo "   📊 Post-reset status:"
echo ""
echo "   Connections:"
podman exec cm-pg-primary psql -U crisismode -c \
    "SELECT state, count(*) FROM pg_stat_activity GROUP BY state ORDER BY count DESC;"

echo ""
echo "   Replication:"
podman exec cm-pg-primary psql -U crisismode -c \
    "SELECT client_addr, state, sent_lsn, replay_lsn FROM pg_stat_replication;"

echo ""
echo "   Replication Slots:"
podman exec cm-pg-primary psql -U crisismode -c \
    "SELECT slot_name, active, wal_status FROM pg_replication_slots;"

echo ""
echo "✅ Environment reset complete."
