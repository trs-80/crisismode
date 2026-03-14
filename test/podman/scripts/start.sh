#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_DIR="$(dirname "$SCRIPT_DIR")"

echo "🚀 Starting CrisisMode test environment..."
echo "   Compose dir: $COMPOSE_DIR"

cd "$COMPOSE_DIR"

# Pull images first
echo ""
echo "📦 Pulling images..."
podman-compose pull

# Start services
echo ""
echo "▶️  Starting services..."
podman-compose up -d

# Wait for health checks
echo ""
echo "⏳ Waiting for services to be healthy..."

wait_for() {
    local name="$1"
    local url="$2"
    local max_attempts="${3:-30}"
    local attempt=0

    while [ $attempt -lt $max_attempts ]; do
        if curl -sf "$url" > /dev/null 2>&1; then
            echo "   ✅ $name is ready"
            return 0
        fi
        attempt=$((attempt + 1))
        sleep 2
    done
    echo "   ❌ $name failed to start after $((max_attempts * 2))s"
    return 1
}

wait_for "PostgreSQL Primary" "http://localhost:9187/metrics" 30
wait_for "Prometheus"         "http://localhost:9090/-/ready" 20
wait_for "AlertManager"       "http://localhost:9093/-/ready" 20
wait_for "Mock Hub"           "http://localhost:8080/health"  20

# Verify replication
echo ""
echo "🔍 Checking replication status..."
podman exec cm-pg-primary psql -U crisismode -c \
    "SELECT client_addr, state, sent_lsn, replay_lsn FROM pg_stat_replication;" 2>/dev/null \
    && echo "   ✅ Replication is active" \
    || echo "   ⚠️  Replication not yet established (replica may still be syncing)"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  CrisisMode test environment is running"
echo ""
echo "  PostgreSQL Primary:  localhost:5432"
echo "  PostgreSQL Replica:  localhost:5433"
echo "  Prometheus:          http://localhost:9090"
echo "  AlertManager:        http://localhost:9093"
echo "  PG Exporter:         http://localhost:9187"
echo "  Mock Hub API:        http://localhost:8080"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
