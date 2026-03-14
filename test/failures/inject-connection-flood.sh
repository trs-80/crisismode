#!/bin/bash
set -euo pipefail

# Floods PostgreSQL with idle connections to simulate connection pool exhaustion.
# Opens N connections that hold open transactions, consuming connection slots.

NUM_CONNECTIONS="${1:-200}"

echo "💉 Injecting connection flood..."
echo "   Target: $NUM_CONNECTIONS idle connections on primary"
echo ""

# Check current connection count
echo "   📊 Current connections:"
podman exec cm-pg-primary psql -U crisismode -c \
    "SELECT count(*) AS active_connections FROM pg_stat_activity WHERE state IS NOT NULL;"

echo ""
echo "   🔌 Opening $NUM_CONNECTIONS connections..."

# Open connections in background using psql sessions that hold a transaction
PIDS=()
for i in $(seq 1 "$NUM_CONNECTIONS"); do
    podman exec -d cm-pg-primary psql -U crisismode -c \
        "BEGIN; SELECT pg_sleep(3600); COMMIT;" > /dev/null 2>&1
    if [ $((i % 25)) -eq 0 ]; then
        echo "      $i/$NUM_CONNECTIONS connections opened"
    fi
done

echo ""
echo "   📊 Connection count after flood:"
podman exec cm-pg-primary psql -U crisismode -c \
    "SELECT state, count(*) FROM pg_stat_activity GROUP BY state ORDER BY count DESC;"

echo ""
echo "   ⚠️  Connections will time out in ~1 hour."
echo "   To clear immediately, run: ./reset.sh"
