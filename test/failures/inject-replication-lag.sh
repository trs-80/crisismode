#!/bin/bash
set -euo pipefail

# Injects replication lag by pausing WAL replay on the replica.
# The primary keeps writing WAL, but the replica stops applying it.
# This creates a growing replication lag visible in pg_stat_replication.

LAG_DURATION="${1:-60}"  # seconds to maintain lag (default: 60)

echo "💉 Injecting replication lag..."
echo "   Method: Pause WAL replay on replica"
echo "   Duration: ${LAG_DURATION}s"
echo ""

# Pause WAL replay
podman exec cm-pg-replica psql -U crisismode -c "SELECT pg_wal_replay_pause();"
echo "   ✅ WAL replay paused on replica"

# Generate writes on primary to create visible lag
echo "   📝 Generating writes on primary to create measurable lag..."
for i in $(seq 1 10); do
    podman exec cm-pg-primary psql -U crisismode -c \
        "INSERT INTO orders (customer_id, status, total)
         SELECT (random()*1000)::int, 'pending', (random()*100)::decimal(10,2)
         FROM generate_series(1, 1000);" > /dev/null 2>&1
    echo "      Batch $i/10 written"
    sleep 1
done

echo ""
echo "   📊 Current replication state:"
podman exec cm-pg-primary psql -U crisismode -c \
    "SELECT client_addr, state, sent_lsn, replay_lsn,
            pg_wal_lsn_diff(sent_lsn, replay_lsn) AS lag_bytes
     FROM pg_stat_replication;"

echo ""
echo "   ⏱️  Lag will persist until you run: ./reset.sh"
echo "   Or it will auto-resume in ${LAG_DURATION}s if you wait."

# Optionally auto-resume after duration
if [ "$LAG_DURATION" -gt 0 ]; then
    (
        sleep "$LAG_DURATION"
        podman exec cm-pg-replica psql -U crisismode -c "SELECT pg_wal_replay_resume();" > /dev/null 2>&1
        echo "   🔄 WAL replay auto-resumed after ${LAG_DURATION}s"
    ) &
    echo "   Background auto-resume scheduled (PID: $!)"
fi
