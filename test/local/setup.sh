#!/bin/bash
set -euo pipefail

# Sets up a native local test environment using Homebrew services.
# No containers — everything runs as local processes.
#
# Components:
#   - PostgreSQL 16 (primary only, via Homebrew)
#   - Prometheus (via Homebrew)
#   - AlertManager (via Homebrew)
#
# Replication is not available in local mode (requires two PG instances).
# Use podman mode for full replication testing.

echo "🏠 CrisisMode Local Setup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$SCRIPT_DIR/.data"
mkdir -p "$DATA_DIR"

# --- Check / Install dependencies ---
echo "📦 Checking dependencies..."

check_or_install() {
    local name="$1"
    local formula="$2"
    if command -v "$name" > /dev/null 2>&1; then
        echo "   ✅ $name found: $(command -v "$name")"
    else
        echo "   📥 Installing $formula..."
        brew install "$formula"
    fi
}

check_or_install "psql"         "postgresql@16"
check_or_install "prometheus"   "prometheus"
check_or_install "alertmanager" "alertmanager"
echo ""

# --- Configure PostgreSQL ---
echo "🐘 Configuring PostgreSQL..."

PG_DATA="$DATA_DIR/pgdata"
PG_LOG="$DATA_DIR/pg.log"

if [ ! -d "$PG_DATA" ]; then
    echo "   Initializing database cluster..."
    initdb -D "$PG_DATA" --username=crisismode --auth=trust > /dev/null 2>&1
    echo "   ✅ Database cluster created"
else
    echo "   ✅ Database cluster exists"
fi

# Configure for replication-like settings (even though single instance)
cat > "$PG_DATA/postgresql.conf" <<EOF
listen_addresses = 'localhost'
port = 5432
wal_level = replica
max_wal_senders = 5
max_replication_slots = 5
max_connections = 300
shared_buffers = 128MB
log_destination = 'stderr'
logging_collector = off
EOF

echo "   ✅ PostgreSQL configured"

# --- Write Prometheus config ---
echo "📊 Writing Prometheus config..."

PROM_DIR="$DATA_DIR/prometheus"
mkdir -p "$PROM_DIR"

cat > "$PROM_DIR/prometheus.yml" <<EOF
global:
  scrape_interval: 5s
  evaluation_interval: 5s

rule_files:
  - alert-rules.yml

alerting:
  alertmanagers:
    - static_configs:
        - targets: ["localhost:9093"]

scrape_configs:
  - job_name: "postgres"
    static_configs:
      - targets: ["localhost:9187"]
EOF

cp "$SCRIPT_DIR/../podman/config/alert-rules.yml" "$PROM_DIR/alert-rules.yml"
echo "   ✅ Prometheus configured"

# --- Write AlertManager config ---
echo "🔔 Writing AlertManager config..."

AM_DIR="$DATA_DIR/alertmanager"
mkdir -p "$AM_DIR"

cat > "$AM_DIR/alertmanager.yml" <<EOF
global:
  resolve_timeout: 1m
route:
  receiver: "crisismode-spoke"
  group_by: ["alertname"]
  group_wait: 10s
  group_interval: 30s
  repeat_interval: 5m
receivers:
  - name: "crisismode-spoke"
    webhook_configs:
      - url: "http://localhost:3000/api/v1/alerts"
        send_resolved: true
EOF

echo "   ✅ AlertManager configured"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Setup complete!"
echo ""
echo "  Next steps:"
echo "    ./start.sh     Start all services"
echo "    ./stop.sh      Stop all services"
echo ""
echo "  Note: Local mode runs PostgreSQL as a single instance."
echo "  For full replication testing, use: test/podman/scripts/start.sh"
