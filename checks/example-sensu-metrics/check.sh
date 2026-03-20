#!/usr/bin/env bash
# example-sensu-metrics: Emit system metrics in Prometheus exposition format
#
# Demonstrates the Sensu output format for CrisisMode with Prometheus
# text metrics. Sensu checks use the same exit code convention as Nagios
# (0=OK, 1=WARNING, 2=CRITICAL, 3=UNKNOWN) but support additional
# metric output formats: graphite_plaintext, influxdb_line,
# opentsdb_line, prometheus_text.
#
# This example emits Prometheus exposition format and works on macOS
# and Linux without external dependencies. To use a real Sensu check
# plugin instead, replace the body with a call to the plugin binary.
#
# The manifest.json sets:
#   "format": "sensu"
#   "sensuMetricFormat": "prometheus_text"

set -euo pipefail

TIMESTAMP_MS=$(($(date +%s) * 1000))

# ── Gather metrics ──

# Load average
if [ -f /proc/loadavg ]; then
  LOAD=$(awk '{print $1}' /proc/loadavg)
elif command -v sysctl >/dev/null 2>&1; then
  LOAD=$(sysctl -n vm.loadavg 2>/dev/null | awk '{print $2}' || echo "0")
else
  LOAD="0"
fi

# CPU count
if command -v nproc >/dev/null 2>&1; then
  CPUS=$(nproc)
elif command -v sysctl >/dev/null 2>&1; then
  CPUS=$(sysctl -n hw.ncpu 2>/dev/null || echo "1")
else
  CPUS=1
fi

# Memory (platform-specific)
if [ -f /proc/meminfo ]; then
  MEM_TOTAL_KB=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
  MEM_AVAIL_KB=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
  MEM_USED_KB=$((MEM_TOTAL_KB - MEM_AVAIL_KB))
  MEM_PCT=$((MEM_USED_KB * 100 / MEM_TOTAL_KB))
elif command -v sysctl >/dev/null 2>&1 && command -v vm_stat >/dev/null 2>&1; then
  PAGE_SIZE=$(sysctl -n hw.pagesize 2>/dev/null || echo "4096")
  MEM_TOTAL_KB=$(($(sysctl -n hw.memsize 2>/dev/null || echo "0") / 1024))
  PAGES_FREE=$(vm_stat 2>/dev/null | awk '/Pages free:/ {gsub(/\./,"",$3); print $3}')
  PAGES_FREE="${PAGES_FREE:-0}"
  MEM_FREE_KB=$((PAGES_FREE * PAGE_SIZE / 1024))
  MEM_USED_KB=$((MEM_TOTAL_KB - MEM_FREE_KB))
  MEM_PCT=$((MEM_USED_KB * 100 / MEM_TOTAL_KB))
else
  MEM_TOTAL_KB=0
  MEM_USED_KB=0
  MEM_PCT=0
fi

# ── Emit Prometheus exposition format ──
# HELP and TYPE lines are comments (# prefix) — the Sensu adapter skips them

cat <<EOF
# HELP node_load1 1-minute load average
# TYPE node_load1 gauge
node_load1 $LOAD $TIMESTAMP_MS
# HELP node_cpu_count Number of CPUs
# TYPE node_cpu_count gauge
node_cpu_count $CPUS $TIMESTAMP_MS
# HELP node_memory_used_percent Memory usage percentage
# TYPE node_memory_used_percent gauge
node_memory_used_percent $MEM_PCT $TIMESTAMP_MS
# HELP node_memory_total_kb Total memory in KB
# TYPE node_memory_total_kb gauge
node_memory_total_kb $MEM_TOTAL_KB $TIMESTAMP_MS
# HELP node_memory_used_kb Used memory in KB
# TYPE node_memory_used_kb gauge
node_memory_used_kb $MEM_USED_KB $TIMESTAMP_MS
EOF

# ── Determine exit code from metrics ──

LOAD_INT=$(printf '%s' "$LOAD" | awk '{printf "%d", $1 * 100}')
CRIT_LOAD=$((CPUS * 400))
WARN_LOAD=$((CPUS * 200))

if [ "$LOAD_INT" -ge "$CRIT_LOAD" ] || [ "$MEM_PCT" -ge 95 ]; then
  exit 2
elif [ "$LOAD_INT" -ge "$WARN_LOAD" ] || [ "$MEM_PCT" -ge 85 ]; then
  exit 1
else
  exit 0
fi
