#!/usr/bin/env bash
set -euo pipefail

# check-dns-resolution: Validates system DNS health
#
# Health verb (scan phase): Tests whether this system's DNS infrastructure
# is working — resolver reachability, canary resolution, response time.
# No user-supplied hostname needed; the check tests the DNS layer itself.
#
# Diagnose verb: Deeper inspection — resolver details, canary timing,
# and optional user-supplied hostname lookup via target.host.
#
# Stdin: JSON with verb, target (optional host), context
# Stdout: JSON result
# Exit codes: 0=OK, 1=warning, 2=critical, 3=unknown

INPUT=$(cat)
VERB=$(printf '%s' "$INPUT" | sed -n 's/.*"verb" *: *"\([^"]*\)".*/\1/p' | head -1)
HOST=$(printf '%s' "$INPUT" | sed -n 's/.*"host" *: *"\([^"]*\)".*/\1/p' | head -1)

# Canary hostnames — well-known stable targets to test "does DNS work at all"
CANARY_HOSTS="dns.google cloudflare.com"

# Placeholder get_resolvers sets when discovery turned up nothing. Callers must
# compare against the *raw* RESOLVERS value, before any whitespace stripping.
NO_RESOLVERS="none found"

# check_resolver_reachable exit status meaning "no tool available to probe with".
# Distinct from success (0) and unreachable (1) — an unmeasured resolver is not
# a reachable resolver.
PROBE_UNAVAILABLE=2

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
  if [ "$VERB" = "diagnose" ]; then
    printf '{"healthy":false,"summary":"No DNS lookup tool available (dig, nslookup, host, getent)","findings":[{"id":"dns-no-tool","severity":"critical","title":"No DNS Tool","detail":"None of dig, nslookup, host, getent found in PATH"}]}\n'
  else
    printf '{"status":"unknown","summary":"No DNS lookup tool available (dig, nslookup, host, getent)","confidence":0.0,"signals":[],"recommendedActions":["Install dig or nslookup"]}\n'
  fi
  exit 3
fi

# ── Helpers ──

# Resolve a hostname and set RESOLVED_IPS and RESOLVE_TIME_MS
resolve_dns() {
  local lookup_host="$1"
  RESOLVED_IPS=""
  RESOLVE_TIME_MS=0

  local start_ms end_ms
  start_ms=$(date +%s%N 2>/dev/null || date +%s)

  case "$DNS_TOOL" in
    dig)
      RESOLVED_IPS=$(dig +short "$lookup_host" A 2>/dev/null | grep -E '^[0-9]+\.' | head -5 || true)
      ;;
    nslookup)
      RESOLVED_IPS=$(nslookup "$lookup_host" 2>/dev/null | sed -n '/^Address/s/^Address[^:]*: *//p' | grep -v '#' | head -5 || true)
      ;;
    host)
      RESOLVED_IPS=$(host "$lookup_host" 2>/dev/null | sed -n 's/.* has address \(.*\)/\1/p' | head -5 || true)
      ;;
    getent)
      RESOLVED_IPS=$(getent hosts "$lookup_host" 2>/dev/null | awk '{print $1}' | head -5 || true)
      ;;
  esac

  end_ms=$(date +%s%N 2>/dev/null || date +%s)
  if [ ${#start_ms} -gt 10 ]; then
    RESOLVE_TIME_MS=$(( (end_ms - start_ms) / 1000000 ))
  else
    RESOLVE_TIME_MS=$(( (end_ms - start_ms) * 1000 ))
  fi
}

# Get configured resolvers from resolv.conf (or scutil on macOS)
get_resolvers() {
  RESOLVERS=""
  if [ -f /etc/resolv.conf ]; then
    RESOLVERS=$(grep '^nameserver' /etc/resolv.conf | awk '{print $2}' | tr '\n' ',' | sed 's/,$//' || true)
  fi
  if [ -z "$RESOLVERS" ] && command -v scutil >/dev/null 2>&1; then
    RESOLVERS=$(scutil --dns 2>/dev/null | grep 'nameserver\[' | awk '{print $3}' | sort -u | tr '\n' ',' | sed 's/,$//' || true)
  fi
  RESOLVERS="${RESOLVERS:-$NO_RESOLVERS}"
}

# Check if a resolver IP is reachable (UDP 53 or TCP ping)
#
# Returns: 0 = reachable, 1 = probed and unreachable,
#          $PROBE_UNAVAILABLE = could not probe (no tool)
check_resolver_reachable() {
  local resolver="$1"
  if [ "$DNS_TOOL" = "dig" ]; then
    # Query the resolver directly with a short timeout
    dig @"$resolver" +short +time=2 +tries=1 dns.google A >/dev/null 2>&1
  elif command -v nc >/dev/null 2>&1; then
    nc -zu -w2 "$resolver" 53 >/dev/null 2>&1
  else
    # Neither dig nor nc is present (the shape of any image without bind-tools,
    # including node:*-alpine), so reachability cannot be measured at all.
    # Report "cannot probe" rather than success: a check that says healthy
    # because a binary is missing is the failure mode this product exists to
    # prevent.
    return "$PROBE_UNAVAILABLE"
  fi
}

# ── Health verb (scan phase) ──
# Tests: resolver reachability, canary resolution, response time

run_health() {
  local signals='['
  local signal_count=0
  local overall_status="healthy"
  local summary_parts=""
  local actions='[]'
  local exit_code=0

  # 1. Check configured resolvers are reachable
  get_resolvers
  local resolver_ok=0
  local resolver_total=0
  local resolver_unprobed=0
  local resolver_unreachable=""
  local resolver_unverified=""

  # Compare against the raw discovery result, before any normalization — a
  # sentinel tested after whitespace stripping can never match.
  if [ "$RESOLVERS" = "$NO_RESOLVERS" ]; then
    [ "$signal_count" -gt 0 ] && signals="$signals,"
    signals="$signals{\"source\":\"resolvers\",\"status\":\"unknown\",\"detail\":\"No DNS resolvers discovered — /etc/resolv.conf has no nameserver entries and no resolver list was available from the system\"}"
    signal_count=$((signal_count + 1))
    [ "$overall_status" = "healthy" ] && overall_status="warning"
    actions='["Review /etc/resolv.conf for nameserver entries","Check the host DNS configuration"]'
    [ "$exit_code" -lt 1 ] && exit_code=1
  else
    IFS=',' read -ra RESOLVER_LIST <<< "$RESOLVERS"
    for resolver in "${RESOLVER_LIST[@]}"; do
      [ "$resolver" = "$NO_RESOLVERS" ] && continue
      resolver="${resolver//[[:space:]]/}"
      [ -z "$resolver" ] && continue
      resolver_total=$((resolver_total + 1))
      local probe_rc=0
      check_resolver_reachable "$resolver" || probe_rc=$?
      if [ "$probe_rc" -eq 0 ]; then
        resolver_ok=$((resolver_ok + 1))
      elif [ "$probe_rc" -eq "$PROBE_UNAVAILABLE" ]; then
        resolver_unprobed=$((resolver_unprobed + 1))
        resolver_unverified="${resolver_unverified:+$resolver_unverified, }$resolver"
      else
        resolver_unreachable="${resolver_unreachable:+$resolver_unreachable, }$resolver"
      fi
    done
  fi

  # Only resolvers that were actually probed may contribute to a verdict.
  local resolver_probed=$((resolver_total - resolver_unprobed))

  if [ "$resolver_probed" -gt 0 ]; then
    if [ "$resolver_ok" -eq "$resolver_probed" ]; then
      [ "$signal_count" -gt 0 ] && signals="$signals,"
      signals="$signals{\"source\":\"resolvers\",\"status\":\"healthy\",\"detail\":\"All $resolver_probed probed resolver(s) reachable ($RESOLVERS)\"}"
      signal_count=$((signal_count + 1))
    elif [ "$resolver_ok" -gt 0 ]; then
      [ "$signal_count" -gt 0 ] && signals="$signals,"
      signals="$signals{\"source\":\"resolvers\",\"status\":\"warning\",\"detail\":\"$resolver_ok/$resolver_probed probed resolvers reachable (unreachable: $resolver_unreachable)\"}"
      signal_count=$((signal_count + 1))
      [ "$overall_status" = "healthy" ] && overall_status="warning"
      actions='["Check unreachable DNS resolvers","Review /etc/resolv.conf"]'
      [ "$exit_code" -lt 1 ] && exit_code=1
    else
      [ "$signal_count" -gt 0 ] && signals="$signals,"
      signals="$signals{\"source\":\"resolvers\",\"status\":\"critical\",\"detail\":\"No resolvers reachable ($RESOLVERS)\"}"
      signal_count=$((signal_count + 1))
      overall_status="critical"
      actions='["Check DNS server availability","Verify network connectivity","Review /etc/resolv.conf"]'
      exit_code=2
    fi
  fi

  if [ "$resolver_unprobed" -gt 0 ]; then
    [ "$signal_count" -gt 0 ] && signals="$signals,"
    signals="$signals{\"source\":\"resolvers\",\"status\":\"unknown\",\"detail\":\"Cannot verify $resolver_unprobed resolver(s) — neither dig nor nc is available to probe them ($resolver_unverified)\"}"
    signal_count=$((signal_count + 1))
  fi

  # 2. Canary resolution — test that DNS actually resolves known-good hostnames
  local canary_resolved=0
  local canary_total=0
  local canary_time_total=0

  for canary in $CANARY_HOSTS; do
    canary_total=$((canary_total + 1))
    resolve_dns "$canary"
    if [ -n "$RESOLVED_IPS" ]; then
      canary_resolved=$((canary_resolved + 1))
      canary_time_total=$((canary_time_total + RESOLVE_TIME_MS))
    fi
  done

  if [ "$canary_total" -gt 0 ]; then
    if [ "$canary_resolved" -eq "$canary_total" ]; then
      local avg_time=$((canary_time_total / canary_total))
      if [ "$avg_time" -gt 2000 ] 2>/dev/null; then
        [ "$signal_count" -gt 0 ] && signals="$signals,"
        signals="$signals{\"source\":\"canary\",\"status\":\"warning\",\"detail\":\"DNS resolves but slowly (avg ${avg_time}ms for $canary_total canary hosts)\"}"
        signal_count=$((signal_count + 1))
        [ "$overall_status" = "healthy" ] && overall_status="warning"
        actions='["Check DNS server performance","Consider using a faster DNS resolver"]'
        [ "$exit_code" -lt 1 ] && exit_code=1
      elif [ "$avg_time" -gt 500 ] 2>/dev/null; then
        [ "$signal_count" -gt 0 ] && signals="$signals,"
        signals="$signals{\"source\":\"canary\",\"status\":\"warning\",\"detail\":\"DNS resolution somewhat slow (avg ${avg_time}ms for $canary_total canary hosts)\"}"
        signal_count=$((signal_count + 1))
        [ "$overall_status" = "healthy" ] && overall_status="warning"
        [ "$exit_code" -lt 1 ] && exit_code=1
      else
        [ "$signal_count" -gt 0 ] && signals="$signals,"
        signals="$signals{\"source\":\"canary\",\"status\":\"healthy\",\"detail\":\"Canary resolution OK (avg ${avg_time}ms for $canary_total hosts)\"}"
        signal_count=$((signal_count + 1))
      fi
    elif [ "$canary_resolved" -gt 0 ]; then
      [ "$signal_count" -gt 0 ] && signals="$signals,"
      signals="$signals{\"source\":\"canary\",\"status\":\"warning\",\"detail\":\"Partial canary resolution: $canary_resolved/$canary_total hosts resolved\"}"
      signal_count=$((signal_count + 1))
      [ "$overall_status" = "healthy" ] && overall_status="warning"
      [ "$exit_code" -lt 1 ] && exit_code=1
    else
      [ "$signal_count" -gt 0 ] && signals="$signals,"
      signals="$signals{\"source\":\"canary\",\"status\":\"critical\",\"detail\":\"No canary hosts resolved ($CANARY_HOSTS)\"}"
      signal_count=$((signal_count + 1))
      overall_status="critical"
      actions='["Check DNS server availability","Verify network connectivity","Review /etc/resolv.conf"]'
      exit_code=2
    fi
  fi

  # 3. Hostname self-resolution
  local my_hostname
  my_hostname=$(hostname -f 2>/dev/null || hostname 2>/dev/null || echo "")
  if [ -n "$my_hostname" ]; then
    resolve_dns "$my_hostname"
    if [ -n "$RESOLVED_IPS" ]; then
      local first_ip
      first_ip=$(echo "$RESOLVED_IPS" | head -1)
      [ "$signal_count" -gt 0 ] && signals="$signals,"
      signals="$signals{\"source\":\"self\",\"status\":\"healthy\",\"detail\":\"Hostname $my_hostname resolves to $first_ip (${RESOLVE_TIME_MS}ms)\"}"
      signal_count=$((signal_count + 1))
    else
      # Self-resolution failure is informational, not critical — many dev machines don't self-resolve
      [ "$signal_count" -gt 0 ] && signals="$signals,"
      signals="$signals{\"source\":\"self\",\"status\":\"unknown\",\"detail\":\"Hostname $my_hostname does not resolve (common on workstations)\"}"
      signal_count=$((signal_count + 1))
    fi
  fi

  signals="$signals]"

  # Build summary
  local health_status
  case "$overall_status" in
    healthy)
      health_status="healthy"
      if [ "$resolver_probed" -gt 0 ]; then
        summary_parts="DNS healthy — resolvers reachable, canary resolution OK"
      else
        # Nothing probed the resolvers, so the summary must not claim they
        # are reachable. The canary result is a real measurement; say only that.
        summary_parts="DNS healthy — canary resolution OK, resolvers not verified"
      fi
      ;;
    warning)  health_status="recovering"; summary_parts="DNS degraded — check signals for details" ;;
    critical) health_status="unhealthy"; summary_parts="DNS failing — resolution or resolvers unreachable" ;;
    *)        health_status="unknown"; summary_parts="DNS status unknown" ;;
  esac

  local confidence="0.9"

  printf '{"status":"%s","summary":"%s","confidence":%s,"signals":%s,"recommendedActions":%s}\n' \
    "$health_status" "$summary_parts" "$confidence" "$signals" "$actions"
  exit "$exit_code"
}

# ── Diagnose verb ──
# Deeper inspection: resolver details, canary timing, optional user-supplied hostname

run_diagnose() {
  local findings='['
  local finding_count=0
  local healthy=true
  local summary=""

  # 1. Configured resolvers
  get_resolvers
  # Compare against the raw discovery result, before any normalization.
  if [ "$RESOLVERS" = "$NO_RESOLVERS" ]; then
    findings="$findings{\"id\":\"dns-resolvers\",\"severity\":\"warning\",\"title\":\"Configured Resolvers\",\"detail\":\"No DNS resolvers discovered — /etc/resolv.conf has no nameserver entries and no resolver list was available from the system\"}"
    finding_count=$((finding_count + 1))
    healthy=false
  else
    findings="$findings{\"id\":\"dns-resolvers\",\"severity\":\"info\",\"title\":\"Configured Resolvers\",\"detail\":\"$RESOLVERS\"}"
    finding_count=$((finding_count + 1))

    # 2. Test each resolver
    IFS=',' read -ra RESOLVER_LIST <<< "$RESOLVERS"
    for resolver in "${RESOLVER_LIST[@]}"; do
      [ "$resolver" = "$NO_RESOLVERS" ] && continue
      resolver="${resolver//[[:space:]]/}"
      [ -z "$resolver" ] && continue
      local resolver_id probe_rc=0
      resolver_id="dns-resolver-${resolver//./-}"
      check_resolver_reachable "$resolver" || probe_rc=$?
      [ "$finding_count" -gt 0 ] && findings="$findings,"
      if [ "$probe_rc" -eq 0 ]; then
        findings="$findings{\"id\":\"$resolver_id\",\"severity\":\"info\",\"title\":\"Resolver $resolver\",\"detail\":\"Reachable\"}"
      elif [ "$probe_rc" -eq "$PROBE_UNAVAILABLE" ]; then
        # Not measured — must never be reported as reachable.
        findings="$findings{\"id\":\"$resolver_id\",\"severity\":\"info\",\"title\":\"Resolver $resolver\",\"detail\":\"Unverified — neither dig nor nc is available to probe this resolver\"}"
      else
        findings="$findings{\"id\":\"$resolver_id\",\"severity\":\"warning\",\"title\":\"Resolver $resolver\",\"detail\":\"Unreachable\"}"
        healthy=false
      fi
      finding_count=$((finding_count + 1))
    done
  fi

  # 3. Canary resolution with timing
  for canary in $CANARY_HOSTS; do
    resolve_dns "$canary"
    if [ -n "$RESOLVED_IPS" ]; then
      local first_ip
      first_ip=$(echo "$RESOLVED_IPS" | head -1)
      local sev="info"
      if [ "$RESOLVE_TIME_MS" -gt 2000 ] 2>/dev/null; then
        sev="warning"
        healthy=false
      elif [ "$RESOLVE_TIME_MS" -gt 500 ] 2>/dev/null; then
        sev="warning"
      fi
      [ "$finding_count" -gt 0 ] && findings="$findings,"
      findings="$findings{\"id\":\"dns-canary-$(echo "$canary" | tr '.' '-')\",\"severity\":\"$sev\",\"title\":\"Canary: $canary\",\"detail\":\"Resolved to $first_ip in ${RESOLVE_TIME_MS}ms\"}"
      finding_count=$((finding_count + 1))
    else
      [ "$finding_count" -gt 0 ] && findings="$findings,"
      findings="$findings{\"id\":\"dns-canary-$(echo "$canary" | tr '.' '-')\",\"severity\":\"critical\",\"title\":\"Canary: $canary\",\"detail\":\"Resolution failed\"}"
      finding_count=$((finding_count + 1))
      healthy=false
    fi
  done

  # 4. Self-resolution
  local my_hostname
  my_hostname=$(hostname -f 2>/dev/null || hostname 2>/dev/null || echo "")
  if [ -n "$my_hostname" ]; then
    resolve_dns "$my_hostname"
    if [ -n "$RESOLVED_IPS" ]; then
      local first_ip
      first_ip=$(echo "$RESOLVED_IPS" | head -1)
      [ "$finding_count" -gt 0 ] && findings="$findings,"
      findings="$findings{\"id\":\"dns-self\",\"severity\":\"info\",\"title\":\"Self-Resolution\",\"detail\":\"$my_hostname -> $first_ip (${RESOLVE_TIME_MS}ms)\"}"
      finding_count=$((finding_count + 1))
    else
      [ "$finding_count" -gt 0 ] && findings="$findings,"
      findings="$findings{\"id\":\"dns-self\",\"severity\":\"info\",\"title\":\"Self-Resolution\",\"detail\":\"$my_hostname does not resolve (common on workstations)\"}"
      finding_count=$((finding_count + 1))
    fi
  fi

  # 5. User-supplied hostname (if provided via target.host)
  if [ -n "$HOST" ]; then
    resolve_dns "$HOST"
    if [ -n "$RESOLVED_IPS" ]; then
      local first_ip ip_count
      first_ip=$(echo "$RESOLVED_IPS" | head -1)
      ip_count=$(echo "$RESOLVED_IPS" | wc -l | tr -d ' ')
      [ "$finding_count" -gt 0 ] && findings="$findings,"
      findings="$findings{\"id\":\"dns-target\",\"severity\":\"info\",\"title\":\"Target: $HOST\",\"detail\":\"Resolved to $first_ip ($ip_count record(s), ${RESOLVE_TIME_MS}ms)\"}"
      finding_count=$((finding_count + 1))

      # TTL (dig only)
      if [ "$DNS_TOOL" = "dig" ]; then
        local ttl
        ttl=$(dig "$HOST" A +noall +answer 2>/dev/null | awk '{print $2}' | head -1 || true)
        ttl="${ttl:-unknown}"
        [ "$finding_count" -gt 0 ] && findings="$findings,"
        findings="$findings{\"id\":\"dns-target-ttl\",\"severity\":\"info\",\"title\":\"Target TTL\",\"detail\":\"${ttl}s\"}"
        finding_count=$((finding_count + 1))
      fi
    else
      [ "$finding_count" -gt 0 ] && findings="$findings,"
      findings="$findings{\"id\":\"dns-target\",\"severity\":\"critical\",\"title\":\"Target: $HOST\",\"detail\":\"Resolution failed using $DNS_TOOL\"}"
      finding_count=$((finding_count + 1))
      healthy=false
    fi
  fi

  # 6. DNS tool info
  [ "$finding_count" -gt 0 ] && findings="$findings,"
  findings="$findings{\"id\":\"dns-tool\",\"severity\":\"info\",\"title\":\"DNS Tool\",\"detail\":\"$DNS_TOOL\"}"
  finding_count=$((finding_count + 1))

  findings="$findings]"

  if [ "$healthy" = true ]; then
    summary="DNS infrastructure healthy — resolvers reachable, canary resolution OK"
  else
    summary="DNS issues detected — see findings for details"
  fi

  printf '{"healthy":%s,"summary":"%s","findings":%s}\n' "$healthy" "$summary" "$findings"
  exit 0
}

# ── Dispatch ──

case "$VERB" in
  health)   run_health ;;
  diagnose) run_diagnose ;;
  *)
    printf '{"status":"unknown","summary":"Unsupported verb: %s","confidence":0.0,"signals":[],"recommendedActions":[]}\n' "$VERB"
    exit 3
    ;;
esac
