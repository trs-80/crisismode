#!/usr/bin/env bash
set -euo pipefail

# check-disk-usage: Checks disk usage via df
# Stdin: JSON with verb, target, context
# Stdout: JSON result
# Exit codes: 0=OK, 1=warning, 2=critical, 3=unknown

INPUT=$(cat)
VERB=$(printf '%s' "$INPUT" | sed -n 's/.*"verb" *: *"\([^"]*\)".*/\1/p' | head -1)

if ! command -v df >/dev/null 2>&1; then
  printf '{"status":"unknown","summary":"df command not available","confidence":0.0,"signals":[],"recommendedActions":[]}\n'
  exit 3
fi

# Get disk usage data: filesystem, use%, mounted-on
# Skip header line, filter out virtual/special filesystems and read-only system mounts
get_disk_data() {
  df -P 2>/dev/null | tail -n +2 \
    | grep -v -E '^(tmpfs|devtmpfs|devfs|none|map )' \
    | grep -v -E '/private/var/run/com\.apple\.' \
    | grep -v -E '/System/Volumes/(Data|VM|Preboot|Update|xarts|iSCPreboot|Hardware)' \
    | awk '{print $1, $5, $6}' | sed 's/%//g'
}

# Find the highest usage percentage
get_max_usage() {
  local max=0
  while read -r _fs pct _mount; do
    if [ "$pct" -gt "$max" ] 2>/dev/null; then
      max=$pct
    fi
  done <<< "$(get_disk_data)"
  echo "$max"
}

case "$VERB" in
  health)
    MAX_PCT=$(get_max_usage)
    SIGNALS="["
    FIRST=true
    while read -r fs pct mount; do
      [ -z "$fs" ] && continue
      if [ "$pct" -ge 90 ] 2>/dev/null; then
        sig_status="critical"
      elif [ "$pct" -ge 80 ] 2>/dev/null; then
        sig_status="warning"
      else
        sig_status="healthy"
      fi
      if [ "$FIRST" = true ]; then
        FIRST=false
      else
        SIGNALS="$SIGNALS,"
      fi
      SIGNALS="$SIGNALS{\"source\":\"$fs\",\"status\":\"$sig_status\",\"detail\":\"$mount at ${pct}% usage\"}"
    done <<< "$(get_disk_data)"
    SIGNALS="$SIGNALS]"

    if [ "$MAX_PCT" -ge 90 ] 2>/dev/null; then
      STATUS="critical"
      SUMMARY="Critical: disk usage at ${MAX_PCT}%"
      CONFIDENCE="0.95"
      ACTIONS='["Free disk space immediately","Remove old logs and temp files","Expand volume if possible"]'
      EXIT_CODE=2
    elif [ "$MAX_PCT" -ge 80 ] 2>/dev/null; then
      STATUS="warning"
      SUMMARY="Warning: disk usage at ${MAX_PCT}%"
      CONFIDENCE="0.9"
      ACTIONS='["Investigate large files","Schedule cleanup"]'
      EXIT_CODE=1
    else
      STATUS="healthy"
      SUMMARY="Disk usage normal, max ${MAX_PCT}%"
      CONFIDENCE="0.95"
      ACTIONS='[]'
      EXIT_CODE=0
    fi

    printf '{"status":"%s","summary":"%s","confidence":%s,"signals":%s,"recommendedActions":%s}\n' \
      "$STATUS" "$SUMMARY" "$CONFIDENCE" "$SIGNALS" "$ACTIONS"
    exit "$EXIT_CODE"
    ;;

  diagnose)
    FINDINGS="["
    FIRST=true
    IDX=0
    while read -r fs pct mount; do
      [ -z "$fs" ] && continue
      if [ "$pct" -ge 70 ] 2>/dev/null; then
        IDX=$((IDX + 1))
        if [ "$pct" -ge 90 ]; then
          SEV="critical"
        elif [ "$pct" -ge 80 ]; then
          SEV="warning"
        else
          SEV="info"
        fi
        if [ "$FIRST" = true ]; then
          FIRST=false
        else
          FINDINGS="$FINDINGS,"
        fi
        FINDINGS="$FINDINGS{\"id\":\"disk-$IDX\",\"severity\":\"$SEV\",\"title\":\"$mount at ${pct}% usage\",\"detail\":\"Filesystem $fs mounted at $mount is ${pct}% full\"}"
      fi
    done <<< "$(get_disk_data)"
    FINDINGS="$FINDINGS]"

    MAX_PCT=$(get_max_usage)
    if [ "$MAX_PCT" -lt 70 ] 2>/dev/null; then
      HEALTHY=true
      SUMMARY="All partitions below 70% usage"
    else
      HEALTHY=false
      SUMMARY="One or more partitions above 70% usage (max ${MAX_PCT}%)"
    fi

    printf '{"healthy":%s,"summary":"%s","findings":%s}\n' "$HEALTHY" "$SUMMARY" "$FINDINGS"
    exit 0
    ;;

  plan)
    MAX_PCT=$(get_max_usage)
    if [ "$MAX_PCT" -lt 80 ] 2>/dev/null; then
      printf '{"name":"disk-no-action","description":"Disk usage is acceptable, no action needed","steps":[]}\n'
      exit 0
    fi

    STEPS='['
    STEPS="$STEPS"'{"id":"disk-plan-1","description":"Identify and remove old log files in /var/log","riskLevel":"routine"}'
    STEPS="$STEPS"',{"id":"disk-plan-2","description":"Clean package manager caches (apt/yum)","riskLevel":"routine"}'
    STEPS="$STEPS"',{"id":"disk-plan-3","description":"Remove unused Docker images and containers","riskLevel":"routine"}'
    if [ "$MAX_PCT" -ge 90 ] 2>/dev/null; then
      STEPS="$STEPS"',{"id":"disk-plan-4","description":"Expand filesystem or add storage volume","riskLevel":"elevated"}'
    fi
    STEPS="$STEPS"']'

    printf '{"name":"disk-cleanup","description":"Free disk space on partitions above 80%% usage","steps":%s}\n' "$STEPS"
    exit 0
    ;;

  *)
    printf '{"status":"unknown","summary":"Unsupported verb: %s","confidence":0.0,"signals":[],"recommendedActions":[]}\n' "$VERB"
    exit 3
    ;;
esac
