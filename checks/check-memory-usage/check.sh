#!/usr/bin/env bash
set -euo pipefail

# check-memory-usage: Checks system memory usage
# Stdin: JSON with verb, target, context
# Stdout: JSON result
# Exit codes: 0=OK, 1=warning, 2=critical, 3=unknown

INPUT=$(cat)
VERB=$(printf '%s' "$INPUT" | sed -n 's/.*"verb" *: *"\([^"]*\)".*/\1/p' | head -1)

# Cross-platform memory info
get_memory_info() {
  if [ -f /proc/meminfo ]; then
    # Linux
    TOTAL_KB=$(sed -n 's/^MemTotal: *\([0-9]*\).*/\1/p' /proc/meminfo)
    AVAIL_KB=$(sed -n 's/^MemAvailable: *\([0-9]*\).*/\1/p' /proc/meminfo)
    if [ -z "$AVAIL_KB" ]; then
      # Older kernels without MemAvailable
      FREE_KB=$(sed -n 's/^MemFree: *\([0-9]*\).*/\1/p' /proc/meminfo)
      BUFFERS_KB=$(sed -n 's/^Buffers: *\([0-9]*\).*/\1/p' /proc/meminfo)
      CACHED_KB=$(sed -n 's/^Cached: *\([0-9]*\).*/\1/p' /proc/meminfo)
      AVAIL_KB=$((FREE_KB + BUFFERS_KB + CACHED_KB))
    fi
    TOTAL_MB=$((TOTAL_KB / 1024))
    AVAIL_MB=$((AVAIL_KB / 1024))
    USED_MB=$((TOTAL_MB - AVAIL_MB))
    if [ "$TOTAL_MB" -gt 0 ]; then
      USED_PCT=$((USED_MB * 100 / TOTAL_MB))
    else
      USED_PCT=0
    fi
  elif command -v sysctl >/dev/null 2>&1; then
    # macOS / BSD
    TOTAL_BYTES=$(sysctl -n hw.memsize 2>/dev/null || echo 0)
    TOTAL_MB=$((TOTAL_BYTES / 1024 / 1024))
    # On macOS, use vm_stat for page-level info
    if command -v vm_stat >/dev/null 2>&1; then
      PAGE_SIZE=$(vm_stat | sed -n 's/.*page size of \([0-9]*\).*/\1/p')
      PAGE_SIZE="${PAGE_SIZE:-4096}"
      FREE_PAGES=$(vm_stat | sed -n 's/^Pages free: *\([0-9]*\).*/\1/p')
      INACTIVE_PAGES=$(vm_stat | sed -n 's/^Pages inactive: *\([0-9]*\).*/\1/p')
      FREE_PAGES="${FREE_PAGES:-0}"
      INACTIVE_PAGES="${INACTIVE_PAGES:-0}"
      AVAIL_MB=$(( (FREE_PAGES + INACTIVE_PAGES) * PAGE_SIZE / 1024 / 1024 ))
    else
      AVAIL_MB=$((TOTAL_MB / 2))
    fi
    USED_MB=$((TOTAL_MB - AVAIL_MB))
    if [ "$TOTAL_MB" -gt 0 ]; then
      USED_PCT=$((USED_MB * 100 / TOTAL_MB))
    else
      USED_PCT=0
    fi
  else
    printf '{"status":"unknown","summary":"Cannot determine memory info (no /proc/meminfo or sysctl)","confidence":0.0,"signals":[],"recommendedActions":[]}\n'
    exit 3
  fi
}

case "$VERB" in
  health)
    get_memory_info

    SIGNALS="[{\"source\":\"memory\",\"status\":\"\",\"detail\":\"${USED_MB}MB/${TOTAL_MB}MB used (${USED_PCT}%%)\"}]"

    if [ "$USED_PCT" -ge 95 ]; then
      STATUS="critical"
      SUMMARY="Critical: memory usage at ${USED_PCT}% (${USED_MB}MB/${TOTAL_MB}MB)"
      CONFIDENCE="0.95"
      ACTIONS='["Kill non-essential processes","Investigate memory leaks","Add swap or memory"]'
      SIG_STATUS="critical"
      EXIT_CODE=2
    elif [ "$USED_PCT" -ge 85 ]; then
      STATUS="warning"
      SUMMARY="Warning: memory usage at ${USED_PCT}% (${USED_MB}MB/${TOTAL_MB}MB)"
      CONFIDENCE="0.9"
      ACTIONS='["Investigate top memory consumers","Check for memory leaks"]'
      SIG_STATUS="warning"
      EXIT_CODE=1
    else
      STATUS="healthy"
      SUMMARY="Memory usage normal at ${USED_PCT}% (${USED_MB}MB/${TOTAL_MB}MB)"
      CONFIDENCE="0.95"
      ACTIONS='[]'
      SIG_STATUS="healthy"
      EXIT_CODE=0
    fi

    SIGNALS="[{\"source\":\"memory\",\"status\":\"$SIG_STATUS\",\"detail\":\"${USED_MB}MB/${TOTAL_MB}MB used (${USED_PCT}%)\"}]"
    printf '{"status":"%s","summary":"%s","confidence":%s,"signals":%s,"recommendedActions":%s}\n' \
      "$STATUS" "$SUMMARY" "$CONFIDENCE" "$SIGNALS" "$ACTIONS"
    exit "$EXIT_CODE"
    ;;

  diagnose)
    get_memory_info

    FINDINGS='['
    FINDINGS="$FINDINGS{\"id\":\"mem-usage\",\"severity\":\"info\",\"title\":\"Memory Usage\",\"detail\":\"${USED_MB}MB/${TOTAL_MB}MB (${USED_PCT}%)\"}"

    # Top memory consumers
    if command -v ps >/dev/null 2>&1; then
      IDX=0
      while IFS= read -r line; do
        IDX=$((IDX + 1))
        # Escape quotes in process names
        safe_line=$(printf '%s' "$line" | sed 's/"/\\"/g' | tr -d '\n\r')
        FINDINGS="$FINDINGS,{\"id\":\"mem-top-$IDX\",\"severity\":\"info\",\"title\":\"Top process #$IDX\",\"detail\":\"$safe_line\"}"
      done <<< "$(ps aux --sort=-%mem 2>/dev/null | head -6 | tail -5 || ps aux -m 2>/dev/null | head -6 | tail -5 || echo 'unable to list processes')"
    fi

    if [ -f /proc/meminfo ]; then
      SWAP_TOTAL=$(sed -n 's/^SwapTotal: *\([0-9]*\).*/\1/p' /proc/meminfo)
      SWAP_FREE=$(sed -n 's/^SwapFree: *\([0-9]*\).*/\1/p' /proc/meminfo)
      SWAP_TOTAL="${SWAP_TOTAL:-0}"
      SWAP_FREE="${SWAP_FREE:-0}"
      SWAP_USED=$((SWAP_TOTAL - SWAP_FREE))
      FINDINGS="$FINDINGS,{\"id\":\"mem-swap\",\"severity\":\"info\",\"title\":\"Swap Usage\",\"detail\":\"$((SWAP_USED / 1024))MB/$((SWAP_TOTAL / 1024))MB\"}"
    fi

    FINDINGS="$FINDINGS]"

    if [ "$USED_PCT" -ge 85 ]; then
      HEALTHY=false
      SUMMARY="Memory usage is high at ${USED_PCT}%"
    else
      HEALTHY=true
      SUMMARY="Memory usage is normal at ${USED_PCT}%"
    fi

    printf '{"healthy":%s,"summary":"%s","findings":%s}\n' "$HEALTHY" "$SUMMARY" "$FINDINGS"
    exit 0
    ;;

  plan)
    get_memory_info

    if [ "$USED_PCT" -lt 85 ]; then
      printf '{"name":"memory-no-action","description":"Memory usage is acceptable at %s%%","steps":[]}\n' "$USED_PCT"
      exit 0
    fi

    STEPS='['
    STEPS="$STEPS"'{"id":"mem-plan-1","description":"Identify top memory-consuming processes","riskLevel":"routine"}'
    STEPS="$STEPS"',{"id":"mem-plan-2","description":"Check for known memory leak patterns in application logs","riskLevel":"routine"}'
    STEPS="$STEPS"',{"id":"mem-plan-3","description":"Clear system caches (echo 3 > /proc/sys/vm/drop_caches)","riskLevel":"elevated"}'
    if [ "$USED_PCT" -ge 95 ]; then
      STEPS="$STEPS"',{"id":"mem-plan-4","description":"Restart the highest memory-consuming non-critical service","riskLevel":"elevated"}'
      STEPS="$STEPS"',{"id":"mem-plan-5","description":"Enable or expand swap space","riskLevel":"elevated"}'
    fi
    STEPS="$STEPS"']'

    printf '{"name":"memory-recovery","description":"Reduce memory usage from %s%%","steps":%s}\n' "$USED_PCT" "$STEPS"
    exit 0
    ;;

  *)
    printf '{"status":"unknown","summary":"Unsupported verb: %s","confidence":0.0,"signals":[],"recommendedActions":[]}\n' "$VERB"
    exit 3
    ;;
esac
