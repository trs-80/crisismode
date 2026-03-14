#!/bin/bash
set -euo pipefail

# Creates a replication slot that no consumer reads from, causing WAL
# accumulation. This simulates the replication_slot_overflow scenario
# from the agent manifest.

SLOT_NAME="${1:-abandoned_slot}"

echo "💉 Injecting replication slot overflow..."
echo "   Slot name: $SLOT_NAME"
echo ""

# Create the abandoned slot
podman exec cm-pg-primary psql -U crisismode -c \
    "SELECT pg_create_physical_replication_slot('$SLOT_NAME');" 2>/dev/null \
    && echo "   ✅ Replication slot '$SLOT_NAME' created" \
    || echo "   ⚠️  Slot may already exist"

# Generate WAL to show accumulation
echo "   📝 Generating WAL to demonstrate accumulation..."
for i in $(seq 1 20); do
    podman exec cm-pg-primary psql -U crisismode -c \
        "INSERT INTO orders (customer_id, status, total)
         SELECT (random()*1000)::int, 'pending', (random()*500)::decimal(10,2)
         FROM generate_series(1, 5000);" > /dev/null 2>&1
    if [ $((i % 5)) -eq 0 ]; then
        echo "      Batch $i/20 written"
    fi
done

echo ""
echo "   📊 Replication slot status:"
podman exec cm-pg-primary psql -U crisismode -c \
    "SELECT slot_name, slot_type, active,
            pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS retained_bytes,
            pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_size,
            wal_status
     FROM pg_replication_slots
     ORDER BY slot_name;"

echo ""
echo "   The '$SLOT_NAME' slot will accumulate WAL indefinitely."
echo "   To clean up, run: ./reset.sh"
