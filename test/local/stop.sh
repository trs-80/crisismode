#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$SCRIPT_DIR/.data"
PID_DIR="$DATA_DIR/pids"

echo "🛑 Stopping CrisisMode local services..."

stop_pid() {
    local name="$1"
    local pidfile="$PID_DIR/$2"
    if [ -f "$pidfile" ]; then
        local pid
        pid=$(cat "$pidfile")
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null
            echo "   ✅ $name stopped (PID $pid)"
        else
            echo "   ⏭️  $name not running"
        fi
        rm -f "$pidfile"
    else
        echo "   ⏭️  $name — no PID file"
    fi
}

# Stop in reverse order
stop_pid "AlertManager" "alertmanager.pid"
stop_pid "Prometheus"   "prometheus.pid"
stop_pid "Mock Hub"     "mock-hub.pid"

# PostgreSQL uses pg_ctl
echo "   🐘 Stopping PostgreSQL..."
PG_DATA="$DATA_DIR/pgdata"
if [ -d "$PG_DATA" ] && pg_isready -p 5432 > /dev/null 2>&1; then
    pg_ctl -D "$PG_DATA" stop -m fast > /dev/null 2>&1
    echo "   ✅ PostgreSQL stopped"
else
    echo "   ⏭️  PostgreSQL not running"
fi

echo ""
echo "✅ All services stopped."
