#!/usr/bin/env bash
# example-nagios-uptime: System uptime and load average check
#
# Demonstrates the Nagios plugin output format for CrisisMode.
# Nagios plugins receive no stdin and produce a single status line
# optionally followed by | and performance data.
#
# Exit codes: 0=OK, 1=WARNING, 2=CRITICAL, 3=UNKNOWN
#
# Output format:
#   STATUS TEXT | label=value[UOM];warn;crit;min;max
#
# This example works on macOS and Linux without external dependencies.
# To use a real Nagios plugin instead, replace the body of this script
# with a call to the plugin binary, e.g.:
#   exec /usr/local/nagios/libexec/check_load -w 5,4,3 -c 10,8,6

set -euo pipefail

# ── Gather system metrics ──

# Load average (1-minute)
if [ -f /proc/loadavg ]; then
  LOAD=$(awk '{print $1}' /proc/loadavg)
elif command -v sysctl >/dev/null 2>&1; then
  LOAD=$(sysctl -n vm.loadavg 2>/dev/null | awk '{print $2}' || echo "0")
else
  printf "UNKNOWN - Cannot determine load average\n"
  exit 3
fi

# Uptime in seconds
if [ -f /proc/uptime ]; then
  UPTIME_SEC=$(awk '{printf "%d", $1}' /proc/uptime)
elif command -v sysctl >/dev/null 2>&1; then
  BOOT_TIME=$(sysctl -n kern.boottime 2>/dev/null | sed 's/.*sec = \([0-9]*\).*/\1/')
  NOW=$(date +%s)
  UPTIME_SEC=$((NOW - BOOT_TIME))
else
  UPTIME_SEC=0
fi

UPTIME_DAYS=$((UPTIME_SEC / 86400))
UPTIME_HOURS=$(( (UPTIME_SEC % 86400) / 3600 ))

# Number of CPU cores (for load threshold scaling)
if command -v nproc >/dev/null 2>&1; then
  CPUS=$(nproc)
elif command -v sysctl >/dev/null 2>&1; then
  CPUS=$(sysctl -n hw.ncpu 2>/dev/null || echo "1")
else
  CPUS=1
fi

# ── Evaluate thresholds ──
# Warning: load > 2x CPU count, Critical: load > 4x CPU count
WARN_THRESHOLD=$((CPUS * 2))
CRIT_THRESHOLD=$((CPUS * 4))

# Compare using integer math (load * 100 to avoid float issues)
LOAD_INT=$(printf '%s' "$LOAD" | awk '{printf "%d", $1 * 100}')
WARN_INT=$((WARN_THRESHOLD * 100))
CRIT_INT=$((CRIT_THRESHOLD * 100))

if [ "$LOAD_INT" -ge "$CRIT_INT" ]; then
  printf "CRITICAL - Load %s exceeds %d (%d CPUs), up %dd %dh | load=%s;%d;%d;0; uptime=%ds;;;;\n" \
    "$LOAD" "$CRIT_THRESHOLD" "$CPUS" "$UPTIME_DAYS" "$UPTIME_HOURS" \
    "$LOAD" "$WARN_THRESHOLD" "$CRIT_THRESHOLD" "$UPTIME_SEC"
  exit 2
elif [ "$LOAD_INT" -ge "$WARN_INT" ]; then
  printf "WARNING - Load %s exceeds %d (%d CPUs), up %dd %dh | load=%s;%d;%d;0; uptime=%ds;;;;\n" \
    "$LOAD" "$WARN_THRESHOLD" "$CPUS" "$UPTIME_DAYS" "$UPTIME_HOURS" \
    "$LOAD" "$WARN_THRESHOLD" "$CRIT_THRESHOLD" "$UPTIME_SEC"
  exit 1
else
  printf "OK - Load %s (%d CPUs), up %dd %dh | load=%s;%d;%d;0; uptime=%ds;;;;\n" \
    "$LOAD" "$CPUS" "$UPTIME_DAYS" "$UPTIME_HOURS" \
    "$LOAD" "$WARN_THRESHOLD" "$CRIT_THRESHOLD" "$UPTIME_SEC"
  exit 0
fi
