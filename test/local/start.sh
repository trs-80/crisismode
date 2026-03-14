#!/bin/bash
set -euo pipefail

# Starts local test services (PostgreSQL, Prometheus, AlertManager, Mock Hub).
# Run setup.sh first if you haven't already.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$SCRIPT_DIR/.data"
PID_DIR="$DATA_DIR/pids"
mkdir -p "$PID_DIR"

echo "▶️  Starting CrisisMode local services..."
echo ""

# --- PostgreSQL ---
echo "   🐘 Starting PostgreSQL..."
PG_DATA="$DATA_DIR/pgdata"
PG_LOG="$DATA_DIR/pg.log"

if pg_isready -p 5432 > /dev/null 2>&1; then
    echo "      Already running"
else
    pg_ctl -D "$PG_DATA" -l "$PG_LOG" start > /dev/null 2>&1
    sleep 2

    # Create database and test data if needed
    if ! psql -U crisismode -lqt 2>/dev/null | grep -qw crisismode; then
        createdb -U crisismode crisismode
    fi

    psql -U crisismode -d crisismode -c "
        CREATE TABLE IF NOT EXISTS orders (
            id SERIAL PRIMARY KEY,
            customer_id INTEGER NOT NULL,
            status VARCHAR(20) DEFAULT 'pending',
            total DECIMAL(10,2),
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
    " > /dev/null 2>&1

    ROW_COUNT=$(psql -U crisismode -d crisismode -tAc "SELECT count(*) FROM orders;" 2>/dev/null || echo "0")
    if [ "$ROW_COUNT" -lt 1000 ]; then
        psql -U crisismode -d crisismode -c "
            INSERT INTO orders (customer_id, status, total)
            SELECT (random()*1000)::int,
                   (ARRAY['pending','processing','shipped','delivered'])[floor(random()*4+1)],
                   (random()*500)::decimal(10,2)
            FROM generate_series(1, 10000);
        " > /dev/null 2>&1
    fi

    echo "      ✅ PostgreSQL started on :5432"
fi

# --- Mock Hub ---
echo "   🏢 Starting Mock Hub API..."
if curl -sf http://localhost:8080/health > /dev/null 2>&1; then
    echo "      Already running"
else
    node "$SCRIPT_DIR/../podman/mock-hub/server.mjs" &
    echo $! > "$PID_DIR/mock-hub.pid"
    sleep 1
    echo "      ✅ Mock Hub started on :8080"
fi

# --- Prometheus ---
echo "   📊 Starting Prometheus..."
PROM_DIR="$DATA_DIR/prometheus"

if curl -sf http://localhost:9090/-/ready > /dev/null 2>&1; then
    echo "      Already running"
else
    prometheus \
        --config.file="$PROM_DIR/prometheus.yml" \
        --storage.tsdb.path="$PROM_DIR/data" \
        --storage.tsdb.retention.time=1d \
        --web.listen-address=":9090" \
        > "$DATA_DIR/prometheus.log" 2>&1 &
    echo $! > "$PID_DIR/prometheus.pid"
    sleep 2
    echo "      ✅ Prometheus started on :9090"
fi

# --- AlertManager ---
echo "   🔔 Starting AlertManager..."
AM_DIR="$DATA_DIR/alertmanager"

if curl -sf http://localhost:9093/-/ready > /dev/null 2>&1; then
    echo "      Already running"
else
    alertmanager \
        --config.file="$AM_DIR/alertmanager.yml" \
        --storage.path="$AM_DIR/data" \
        --web.listen-address=":9093" \
        > "$DATA_DIR/alertmanager.log" 2>&1 &
    echo $! > "$PID_DIR/alertmanager.pid"
    sleep 2
    echo "      ✅ AlertManager started on :9093"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Local services running:"
echo ""
echo "  PostgreSQL:     localhost:5432  (user: crisismode)"
echo "  Prometheus:     http://localhost:9090"
echo "  AlertManager:   http://localhost:9093"
echo "  Mock Hub API:   http://localhost:8080"
echo ""
echo "  Note: No postgres_exporter in local mode."
echo "  For full metrics pipeline, use podman mode."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
