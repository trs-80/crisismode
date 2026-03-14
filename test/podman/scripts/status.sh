#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_DIR="$(dirname "$SCRIPT_DIR")"

cd "$COMPOSE_DIR"

echo "📊 CrisisMode Test Environment Status"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Container status
echo "🐳 Containers:"
podman-compose ps
echo ""

# Replication status
echo "🔄 PostgreSQL Replication:"
podman exec cm-pg-primary psql -U crisismode -c \
    "SELECT pid, client_addr, state, sent_lsn, write_lsn, replay_lsn,
            EXTRACT(EPOCH FROM (now() - replay_lag))::int AS lag_seconds
     FROM pg_stat_replication;" 2>/dev/null \
    || echo "   ⚠️  Could not query replication status"
echo ""

# Replica perspective
echo "📡 Replica Status:"
podman exec cm-pg-replica psql -U crisismode -c \
    "SELECT pg_is_in_recovery() AS is_replica,
            pg_last_wal_receive_lsn() AS received_lsn,
            pg_last_wal_replay_lsn() AS replayed_lsn,
            EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::int AS lag_seconds;" 2>/dev/null \
    || echo "   ⚠️  Could not query replica status"
echo ""

# Prometheus alerts
echo "🔔 Active Alerts:"
curl -sf http://localhost:9093/api/v2/alerts 2>/dev/null \
    | python3 -m json.tool 2>/dev/null \
    || echo "   No active alerts (or AlertManager not running)"
echo ""

# Mock hub stats
echo "🏢 Mock Hub:"
curl -sf http://localhost:8080/health 2>/dev/null \
    | python3 -m json.tool 2>/dev/null \
    || echo "   Mock hub not running"
