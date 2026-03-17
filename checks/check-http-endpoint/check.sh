#!/usr/bin/env bash
set -euo pipefail

# check-http-endpoint: Checks HTTP endpoint reachability and response
# Stdin: JSON with verb, target (host, port), context
# Stdout: JSON result
# Exit codes: 0=OK, 1=warning, 2=critical, 3=unknown

INPUT=$(cat)
VERB=$(printf '%s' "$INPUT" | sed -n 's/.*"verb" *: *"\([^"]*\)".*/\1/p' | head -1)
HOST=$(printf '%s' "$INPUT" | sed -n 's/.*"host" *: *"\([^"]*\)".*/\1/p' | head -1)
PORT=$(printf '%s' "$INPUT" | sed -n 's/.*"port" *: *\([0-9]*\).*/\1/p' | head -1)

if ! command -v curl >/dev/null 2>&1; then
  printf '{"status":"unknown","summary":"curl command not available","confidence":0.0,"signals":[],"recommendedActions":[]}\n'
  exit 3
fi

HOST="${HOST:-localhost}"
PORT="${PORT:-80}"

if [ "$PORT" = "443" ]; then
  URL="https://${HOST}:${PORT}"
else
  URL="http://${HOST}:${PORT}"
fi

case "$VERB" in
  health)
    TMPFILE=$(mktemp)
    trap 'rm -f "$TMPFILE"' EXIT

    HTTP_CODE=$(curl -s -o "$TMPFILE" -w '%{http_code}' --connect-timeout 5 --max-time 10 "$URL" 2>/dev/null) || HTTP_CODE="000"

    if [ "$HTTP_CODE" -ge 200 ] 2>/dev/null && [ "$HTTP_CODE" -lt 300 ]; then
      STATUS="healthy"
      SUMMARY="Endpoint $URL returned HTTP $HTTP_CODE"
      CONFIDENCE="0.95"
      ACTIONS='[]'
      EXIT_CODE=0
    elif [ "$HTTP_CODE" -ge 300 ] 2>/dev/null && [ "$HTTP_CODE" -lt 500 ]; then
      STATUS="warning"
      SUMMARY="Endpoint $URL returned HTTP $HTTP_CODE"
      CONFIDENCE="0.85"
      ACTIONS='["Check endpoint configuration","Verify redirect targets"]'
      EXIT_CODE=1
    elif [ "$HTTP_CODE" -ge 500 ] 2>/dev/null; then
      STATUS="critical"
      SUMMARY="Endpoint $URL returned HTTP $HTTP_CODE (server error)"
      CONFIDENCE="0.9"
      ACTIONS='["Check application logs","Restart the service","Verify backend dependencies"]'
      EXIT_CODE=2
    else
      STATUS="critical"
      SUMMARY="Endpoint $URL is unreachable (connection failed or timed out)"
      CONFIDENCE="0.9"
      ACTIONS='["Verify the service is running","Check network connectivity","Check firewall rules"]'
      EXIT_CODE=2
    fi

    SIGNALS="[{\"source\":\"curl\",\"status\":\"$STATUS\",\"detail\":\"HTTP $HTTP_CODE from $URL\"}]"
    printf '{"status":"%s","summary":"%s","confidence":%s,"signals":%s,"recommendedActions":%s}\n' \
      "$STATUS" "$SUMMARY" "$CONFIDENCE" "$SIGNALS" "$ACTIONS"
    exit "$EXIT_CODE"
    ;;

  diagnose)
    TMPHEADERS=$(mktemp)
    TMPBODY=$(mktemp)
    trap 'rm -f "$TMPHEADERS" "$TMPBODY"' EXIT

    TIME_START=$(date +%s%N 2>/dev/null || date +%s)
    HTTP_CODE=$(curl -s -o "$TMPBODY" -D "$TMPHEADERS" -w '%{http_code}' --connect-timeout 5 --max-time 10 "$URL" 2>/dev/null) || HTTP_CODE="000"
    TIME_END=$(date +%s%N 2>/dev/null || date +%s)

    # Calculate response time in ms (fallback to seconds if nanoseconds unavailable)
    if [ ${#TIME_START} -gt 10 ]; then
      RESPONSE_MS=$(( (TIME_END - TIME_START) / 1000000 ))
    else
      RESPONSE_MS=$(( (TIME_END - TIME_START) * 1000 ))
    fi

    CONTENT_TYPE=$(sed -n 's/^[Cc]ontent-[Tt]ype: *\([^\r]*\).*/\1/p' "$TMPHEADERS" 2>/dev/null | head -1)
    CONTENT_TYPE="${CONTENT_TYPE:-unknown}"
    SERVER=$(sed -n 's/^[Ss]erver: *\([^\r]*\).*/\1/p' "$TMPHEADERS" 2>/dev/null | head -1)
    SERVER="${SERVER:-unknown}"

    FINDINGS='['
    FINDINGS="$FINDINGS{\"id\":\"http-status\",\"severity\":\"info\",\"title\":\"HTTP Status Code\",\"detail\":\"$URL returned $HTTP_CODE\"}"
    FINDINGS="$FINDINGS,{\"id\":\"http-time\",\"severity\":\"info\",\"title\":\"Response Time\",\"detail\":\"${RESPONSE_MS}ms\"}"
    FINDINGS="$FINDINGS,{\"id\":\"http-server\",\"severity\":\"info\",\"title\":\"Server Header\",\"detail\":\"$SERVER\"}"
    FINDINGS="$FINDINGS,{\"id\":\"http-content\",\"severity\":\"info\",\"title\":\"Content-Type\",\"detail\":\"$CONTENT_TYPE\"}"

    if [ "$RESPONSE_MS" -gt 5000 ] 2>/dev/null; then
      FINDINGS="$FINDINGS,{\"id\":\"http-slow\",\"severity\":\"warning\",\"title\":\"Slow Response\",\"detail\":\"Response took ${RESPONSE_MS}ms, exceeds 5000ms threshold\"}"
    fi
    FINDINGS="$FINDINGS]"

    if [ "$HTTP_CODE" -ge 200 ] 2>/dev/null && [ "$HTTP_CODE" -lt 300 ]; then
      HEALTHY=true
      SUMMARY="Endpoint $URL is healthy (HTTP $HTTP_CODE, ${RESPONSE_MS}ms)"
    else
      HEALTHY=false
      SUMMARY="Endpoint $URL returned HTTP $HTTP_CODE (${RESPONSE_MS}ms)"
    fi

    printf '{"healthy":%s,"summary":"%s","findings":%s}\n' "$HEALTHY" "$SUMMARY" "$FINDINGS"
    exit 0
    ;;

  plan)
    TMPFILE=$(mktemp)
    trap 'rm -f "$TMPFILE"' EXIT
    HTTP_CODE=$(curl -s -o "$TMPFILE" -w '%{http_code}' --connect-timeout 5 --max-time 10 "$URL" 2>/dev/null) || HTTP_CODE="000"

    if [ "$HTTP_CODE" -ge 200 ] 2>/dev/null && [ "$HTTP_CODE" -lt 300 ]; then
      printf '{"name":"http-no-action","description":"Endpoint is responding normally","steps":[]}\n'
      exit 0
    fi

    STEPS='['
    STEPS="$STEPS"'{"id":"http-plan-1","description":"Check application process status","riskLevel":"routine"}'
    STEPS="$STEPS"',{"id":"http-plan-2","description":"Review application logs for errors","riskLevel":"routine"}'
    if [ "$HTTP_CODE" = "000" ]; then
      STEPS="$STEPS"',{"id":"http-plan-3","description":"Restart the application service","riskLevel":"elevated"}'
      STEPS="$STEPS"',{"id":"http-plan-4","description":"Check network and firewall configuration","riskLevel":"routine"}'
    elif [ "$HTTP_CODE" -ge 500 ] 2>/dev/null; then
      STEPS="$STEPS"',{"id":"http-plan-3","description":"Restart the application service","riskLevel":"elevated"}'
      STEPS="$STEPS"',{"id":"http-plan-4","description":"Check backend service dependencies","riskLevel":"routine"}'
    fi
    STEPS="$STEPS"']'

    printf '{"name":"http-recovery","description":"Recover HTTP endpoint %s (status %s)","steps":%s}\n' "$URL" "$HTTP_CODE" "$STEPS"
    exit 0
    ;;

  *)
    printf '{"status":"unknown","summary":"Unsupported verb: %s","confidence":0.0,"signals":[],"recommendedActions":[]}\n' "$VERB"
    exit 3
    ;;
esac
