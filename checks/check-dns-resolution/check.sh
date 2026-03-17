#!/usr/bin/env bash
set -euo pipefail

# check-dns-resolution: Checks DNS resolution for a target hostname
# Stdin: JSON with verb, target (host), context
# Stdout: JSON result
# Exit codes: 0=OK, 1=warning, 2=critical, 3=unknown

INPUT=$(cat)
VERB=$(printf '%s' "$INPUT" | sed -n 's/.*"verb" *: *"\([^"]*\)".*/\1/p' | head -1)
HOST=$(printf '%s' "$INPUT" | sed -n 's/.*"host" *: *"\([^"]*\)".*/\1/p' | head -1)
TARGET_NAME=$(printf '%s' "$INPUT" | sed -n 's/.*"name" *: *"\([^"]*\)".*/\1/p' | head -1)

# Use host from target, fall back to name
LOOKUP_HOST="${HOST:-${TARGET_NAME:-localhost}}"

# Find a DNS lookup tool
DNS_TOOL=""
if command -v dig >/dev/null 2>&1; then
  DNS_TOOL="dig"
elif command -v nslookup >/dev/null 2>&1; then
  DNS_TOOL="nslookup"
elif command -v host >/dev/null 2>&1; then
  DNS_TOOL="host"
elif command -v getent >/dev/null 2>&1; then
  DNS_TOOL="getent"
else
  printf '{"status":"unknown","summary":"No DNS lookup tool available (dig, nslookup, host, getent)","confidence":0.0,"signals":[],"recommendedActions":[]}\n'
  exit 3
fi

# Resolve hostname and measure time
resolve_dns() {
  local start_ms end_ms
  start_ms=$(date +%s%N 2>/dev/null || date +%s)

  case "$DNS_TOOL" in
    dig)
      RESOLVED_IPS=$(dig +short "$LOOKUP_HOST" A 2>/dev/null | grep -E '^[0-9]+\.' | head -5)
      ;;
    nslookup)
      RESOLVED_IPS=$(nslookup "$LOOKUP_HOST" 2>/dev/null | sed -n '/^Address/s/^Address[^:]*: *//p' | grep -v '#' | head -5)
      ;;
    host)
      RESOLVED_IPS=$(host "$LOOKUP_HOST" 2>/dev/null | sed -n 's/.* has address \(.*\)/\1/p' | head -5)
      ;;
    getent)
      RESOLVED_IPS=$(getent hosts "$LOOKUP_HOST" 2>/dev/null | awk '{print $1}' | head -5)
      ;;
  esac

  end_ms=$(date +%s%N 2>/dev/null || date +%s)
  if [ ${#start_ms} -gt 10 ]; then
    RESOLVE_TIME_MS=$(( (end_ms - start_ms) / 1000000 ))
  else
    RESOLVE_TIME_MS=$(( (end_ms - start_ms) * 1000 ))
  fi
}

case "$VERB" in
  health)
    resolve_dns

    if [ -n "$RESOLVED_IPS" ]; then
      FIRST_IP=$(echo "$RESOLVED_IPS" | head -1)
      IP_COUNT=$(echo "$RESOLVED_IPS" | wc -l | tr -d ' ')

      if [ "$RESOLVE_TIME_MS" -gt 2000 ] 2>/dev/null; then
        STATUS="warning"
        SUMMARY="DNS resolves but slowly (${RESOLVE_TIME_MS}ms) for $LOOKUP_HOST -> $FIRST_IP"
        CONFIDENCE="0.85"
        ACTIONS='["Check DNS server performance","Consider using a faster DNS resolver"]'
        EXIT_CODE=1
      else
        STATUS="healthy"
        SUMMARY="$LOOKUP_HOST resolves to $FIRST_IP ($IP_COUNT record(s), ${RESOLVE_TIME_MS}ms)"
        CONFIDENCE="0.95"
        ACTIONS='[]'
        EXIT_CODE=0
      fi

      SIGNALS="[{\"source\":\"$DNS_TOOL\",\"status\":\"$STATUS\",\"detail\":\"Resolved $LOOKUP_HOST to $FIRST_IP in ${RESOLVE_TIME_MS}ms\"}]"
    else
      STATUS="critical"
      SUMMARY="DNS resolution failed for $LOOKUP_HOST"
      CONFIDENCE="0.9"
      ACTIONS='["Check DNS server availability","Verify hostname spelling","Check /etc/resolv.conf"]'
      SIGNALS="[{\"source\":\"$DNS_TOOL\",\"status\":\"critical\",\"detail\":\"Failed to resolve $LOOKUP_HOST\"}]"
      EXIT_CODE=2
    fi

    printf '{"status":"%s","summary":"%s","confidence":%s,"signals":%s,"recommendedActions":%s}\n' \
      "$STATUS" "$SUMMARY" "$CONFIDENCE" "$SIGNALS" "$ACTIONS"
    exit "$EXIT_CODE"
    ;;

  diagnose)
    resolve_dns

    FINDINGS='['
    if [ -n "$RESOLVED_IPS" ]; then
      # IP addresses
      IDX=0
      while IFS= read -r ip; do
        [ -z "$ip" ] && continue
        IDX=$((IDX + 1))
        if [ "$IDX" -gt 1 ]; then
          FINDINGS="$FINDINGS,"
        fi
        FINDINGS="$FINDINGS{\"id\":\"dns-ip-$IDX\",\"severity\":\"info\",\"title\":\"Resolved IP #$IDX\",\"detail\":\"$ip\"}"
      done <<< "$RESOLVED_IPS"

      # Resolution time
      FINDINGS="$FINDINGS,{\"id\":\"dns-time\",\"severity\":\"info\",\"title\":\"Resolution Time\",\"detail\":\"${RESOLVE_TIME_MS}ms\"}"

      # TTL (dig only)
      if [ "$DNS_TOOL" = "dig" ]; then
        TTL=$(dig "$LOOKUP_HOST" A +noall +answer 2>/dev/null | awk '{print $2}' | head -1)
        TTL="${TTL:-unknown}"
        FINDINGS="$FINDINGS,{\"id\":\"dns-ttl\",\"severity\":\"info\",\"title\":\"TTL\",\"detail\":\"${TTL}s\"}"
      fi

      # Nameserver info
      if [ "$DNS_TOOL" = "dig" ]; then
        NS=$(dig NS "$LOOKUP_HOST" +short 2>/dev/null | head -3 | tr '\n' ',' | sed 's/,$//')
        if [ -n "$NS" ]; then
          FINDINGS="$FINDINGS,{\"id\":\"dns-ns\",\"severity\":\"info\",\"title\":\"Nameservers\",\"detail\":\"$NS\"}"
        fi
      fi

      HEALTHY=true
      SUMMARY="$LOOKUP_HOST resolved successfully in ${RESOLVE_TIME_MS}ms"
    else
      FINDINGS="$FINDINGS{\"id\":\"dns-fail\",\"severity\":\"critical\",\"title\":\"Resolution Failed\",\"detail\":\"Could not resolve $LOOKUP_HOST using $DNS_TOOL\"}"
      HEALTHY=false
      SUMMARY="DNS resolution failed for $LOOKUP_HOST"
    fi

    # Check configured nameservers
    if [ -f /etc/resolv.conf ]; then
      NAMESERVERS=$(grep '^nameserver' /etc/resolv.conf | awk '{print $2}' | tr '\n' ',' | sed 's/,$//')
      FINDINGS="$FINDINGS,{\"id\":\"dns-resolvers\",\"severity\":\"info\",\"title\":\"Configured Resolvers\",\"detail\":\"$NAMESERVERS\"}"
    fi

    FINDINGS="$FINDINGS]"

    printf '{"healthy":%s,"summary":"%s","findings":%s}\n' "$HEALTHY" "$SUMMARY" "$FINDINGS"
    exit 0
    ;;

  *)
    printf '{"status":"unknown","summary":"Unsupported verb: %s","confidence":0.0,"signals":[],"recommendedActions":[]}\n' "$VERB"
    exit 3
    ;;
esac
