#!/usr/bin/env bash
set -euo pipefail

# check-certificate-expiry: Checks TLS certificate expiry
# Stdin: JSON with verb, target (host, port), context
# Stdout: JSON result
# Exit codes: 0=OK, 1=warning, 2=critical, 3=unknown

INPUT=$(cat)
VERB=$(printf '%s' "$INPUT" | sed -n 's/.*"verb" *: *"\([^"]*\)".*/\1/p' | head -1)
HOST=$(printf '%s' "$INPUT" | sed -n 's/.*"host" *: *"\([^"]*\)".*/\1/p' | head -1)
PORT=$(printf '%s' "$INPUT" | sed -n 's/.*"port" *: *\([0-9]*\).*/\1/p' | head -1)

HOST="${HOST:-localhost}"
PORT="${PORT:-443}"

if ! command -v openssl >/dev/null 2>&1; then
  printf '{"status":"unknown","summary":"openssl command not available","confidence":0.0,"signals":[],"recommendedActions":[]}\n'
  exit 3
fi

# Fetch certificate from the remote host
CERT_INFO=$(echo | openssl s_client -servername "$HOST" -connect "$HOST:$PORT" 2>/dev/null) || true

if [ -z "$CERT_INFO" ]; then
  if [ "$VERB" = "diagnose" ]; then
    printf '{"healthy":false,"summary":"Could not connect to %s:%s to check certificate","findings":[{"id":"cert-conn-fail","severity":"critical","title":"TLS Connection Failed","detail":"Could not connect to %s:%s"}]}\n' \
      "$HOST" "$PORT" "$HOST" "$PORT"
  else
    printf '{"status":"critical","summary":"Could not connect to %s:%s to check certificate","confidence":0.8,"signals":[{"source":"openssl","status":"critical","detail":"TLS connection failed to %s:%s"}],"recommendedActions":["Verify the service is running and accepting TLS connections"]}\n' \
      "$HOST" "$PORT" "$HOST" "$PORT"
  fi
  exit 2
fi

# Extract expiry date
EXPIRY_DATE=$(echo "$CERT_INFO" | openssl x509 -noout -enddate 2>/dev/null | sed 's/notAfter=//')

if [ -z "$EXPIRY_DATE" ]; then
  if [ "$VERB" = "diagnose" ]; then
    printf '{"healthy":false,"summary":"Could not parse certificate from %s:%s","findings":[{"id":"cert-parse-fail","severity":"warning","title":"Certificate Parse Failed","detail":"Could not parse certificate from %s:%s"}]}\n' \
      "$HOST" "$PORT" "$HOST" "$PORT"
  else
    printf '{"status":"unknown","summary":"Could not parse certificate from %s:%s","confidence":0.5,"signals":[],"recommendedActions":["Verify the endpoint serves a valid TLS certificate"]}\n' \
      "$HOST" "$PORT"
  fi
  exit 3
fi

# Calculate days until expiry
# Use date -d on Linux, date -jf on macOS
if date -d "$EXPIRY_DATE" +%s >/dev/null 2>&1; then
  EXPIRY_EPOCH=$(date -d "$EXPIRY_DATE" +%s)
elif date -jf "%b %d %T %Y %Z" "$EXPIRY_DATE" +%s >/dev/null 2>&1; then
  EXPIRY_EPOCH=$(date -jf "%b %d %T %Y %Z" "$EXPIRY_DATE" +%s)
elif date -jf "%b  %d %T %Y %Z" "$EXPIRY_DATE" +%s >/dev/null 2>&1; then
  # Handle single-digit days with double space
  EXPIRY_EPOCH=$(date -jf "%b  %d %T %Y %Z" "$EXPIRY_DATE" +%s)
else
  # Last resort: try python
  if command -v python3 >/dev/null 2>&1; then
    EXPIRY_EPOCH=$(python3 -c "
import email.utils, calendar
t = email.utils.parsedate('$EXPIRY_DATE')
print(calendar.timegm(t))
" 2>/dev/null) || EXPIRY_EPOCH=""
  fi
fi

if [ -z "${EXPIRY_EPOCH:-}" ]; then
  printf '{"status":"unknown","summary":"Could not parse expiry date: %s","confidence":0.3,"signals":[],"recommendedActions":[]}\n' "$EXPIRY_DATE"
  exit 3
fi

NOW_EPOCH=$(date +%s)
DAYS_LEFT=$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))

case "$VERB" in
  health)
    if [ "$DAYS_LEFT" -le 0 ]; then
      STATUS="critical"
      SUMMARY="Certificate for $HOST EXPIRED ${DAYS_LEFT#-} days ago"
      CONFIDENCE="0.99"
      ACTIONS='["Renew the TLS certificate immediately","Check certificate auto-renewal configuration"]'
      EXIT_CODE=2
    elif [ "$DAYS_LEFT" -le 7 ]; then
      STATUS="critical"
      SUMMARY="Certificate for $HOST expires in $DAYS_LEFT days (on $EXPIRY_DATE)"
      CONFIDENCE="0.95"
      ACTIONS='["Renew the TLS certificate immediately","Verify auto-renewal is configured"]'
      EXIT_CODE=2
    elif [ "$DAYS_LEFT" -le 30 ]; then
      STATUS="warning"
      SUMMARY="Certificate for $HOST expires in $DAYS_LEFT days (on $EXPIRY_DATE)"
      CONFIDENCE="0.95"
      ACTIONS='["Schedule certificate renewal","Verify auto-renewal is configured"]'
      EXIT_CODE=1
    else
      STATUS="healthy"
      SUMMARY="Certificate for $HOST valid for $DAYS_LEFT more days (expires $EXPIRY_DATE)"
      CONFIDENCE="0.95"
      ACTIONS='[]'
      EXIT_CODE=0
    fi

    SIGNALS="[{\"source\":\"openssl\",\"status\":\"$STATUS\",\"detail\":\"Certificate expires in $DAYS_LEFT days ($EXPIRY_DATE)\"}]"
    printf '{"status":"%s","summary":"%s","confidence":%s,"signals":%s,"recommendedActions":%s}\n' \
      "$STATUS" "$SUMMARY" "$CONFIDENCE" "$SIGNALS" "$ACTIONS"
    exit "$EXIT_CODE"
    ;;

  diagnose)
    # Extract certificate details
    CERT_DETAILS=$(echo "$CERT_INFO" | openssl x509 -noout -subject -issuer -dates -ext subjectAltName 2>/dev/null || true)

    SUBJECT=$(echo "$CERT_DETAILS" | sed -n 's/^subject=\(.*\)/\1/p' | sed 's/"/\\"/g')
    ISSUER=$(echo "$CERT_DETAILS" | sed -n 's/^issuer=\(.*\)/\1/p' | sed 's/"/\\"/g')
    NOT_BEFORE=$(echo "$CERT_DETAILS" | sed -n 's/^notBefore=\(.*\)/\1/p')
    NOT_AFTER=$(echo "$CERT_DETAILS" | sed -n 's/^notAfter=\(.*\)/\1/p')

    # SANs - extract from the extension output
    SANS=$(echo "$CERT_DETAILS" | grep -A1 "Subject Alternative Name" | grep -v "Subject Alternative Name" | sed 's/^ *//' | sed 's/"/\\"/g')
    SANS="${SANS:-none found}"

    # Serial number
    SERIAL=$(echo "$CERT_INFO" | openssl x509 -noout -serial 2>/dev/null | sed 's/serial=//')
    SERIAL="${SERIAL:-unknown}"

    FINDINGS='['
    FINDINGS="$FINDINGS{\"id\":\"cert-subject\",\"severity\":\"info\",\"title\":\"Subject\",\"detail\":\"$SUBJECT\"}"
    FINDINGS="$FINDINGS,{\"id\":\"cert-issuer\",\"severity\":\"info\",\"title\":\"Issuer\",\"detail\":\"$ISSUER\"}"
    FINDINGS="$FINDINGS,{\"id\":\"cert-valid-from\",\"severity\":\"info\",\"title\":\"Valid From\",\"detail\":\"$NOT_BEFORE\"}"
    FINDINGS="$FINDINGS,{\"id\":\"cert-valid-to\",\"severity\":\"info\",\"title\":\"Valid To\",\"detail\":\"$NOT_AFTER\"}"
    FINDINGS="$FINDINGS,{\"id\":\"cert-days-left\",\"severity\":\"info\",\"title\":\"Days Until Expiry\",\"detail\":\"$DAYS_LEFT days\"}"
    FINDINGS="$FINDINGS,{\"id\":\"cert-sans\",\"severity\":\"info\",\"title\":\"Subject Alt Names\",\"detail\":\"$SANS\"}"
    FINDINGS="$FINDINGS,{\"id\":\"cert-serial\",\"severity\":\"info\",\"title\":\"Serial Number\",\"detail\":\"$SERIAL\"}"

    if [ "$DAYS_LEFT" -le 7 ]; then
      FINDINGS="$FINDINGS,{\"id\":\"cert-expiry-urgent\",\"severity\":\"critical\",\"title\":\"Certificate Expiring Soon\",\"detail\":\"Only $DAYS_LEFT days remaining\"}"
    elif [ "$DAYS_LEFT" -le 30 ]; then
      FINDINGS="$FINDINGS,{\"id\":\"cert-expiry-warn\",\"severity\":\"warning\",\"title\":\"Certificate Expiring\",\"detail\":\"$DAYS_LEFT days remaining\"}"
    fi

    FINDINGS="$FINDINGS]"

    if [ "$DAYS_LEFT" -gt 30 ]; then
      HEALTHY=true
      SUMMARY="Certificate for $HOST is valid, expires in $DAYS_LEFT days"
    elif [ "$DAYS_LEFT" -gt 0 ]; then
      HEALTHY=false
      SUMMARY="Certificate for $HOST expires in $DAYS_LEFT days"
    else
      HEALTHY=false
      SUMMARY="Certificate for $HOST has EXPIRED"
    fi

    printf '{"healthy":%s,"summary":"%s","findings":%s}\n' "$HEALTHY" "$SUMMARY" "$FINDINGS"
    exit 0
    ;;

  *)
    printf '{"status":"unknown","summary":"Unsupported verb: %s","confidence":0.0,"signals":[],"recommendedActions":[]}\n' "$VERB"
    exit 3
    ;;
esac
