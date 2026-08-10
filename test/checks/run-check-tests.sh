#!/usr/bin/env bash
set -euo pipefail

# Shell-level tests for the bundled check plugins in checks/*.
#
# These exercise the check executables the way the framework does: a JSON
# request on stdin, a JSON result on stdout, exit codes 0=OK, 1=warning,
# 2=critical, 3=unknown (see src/framework/check-plugin.ts).
#
# The point of this harness is to run the checks in a *degraded* environment —
# a PATH without dig/nc (which is what node:22-alpine gives us, see Dockerfile)
# and with resolver discovery finding nothing. A check that reports "healthy"
# because a probe binary is missing is worse than no check at all.
#
# Usage: bash test/checks/run-check-tests.sh

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
DNS_CHECK="$REPO_ROOT/checks/check-dns-resolution/check.sh"
MEMORY_CHECK="$REPO_ROOT/checks/check-memory-usage/check.sh"

PASS=0
FAIL=0

# ── Fake PATH construction ──

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

# A PATH with everything the DNS check legitimately needs, minus dig and nc —
# the two tools it uses to probe a resolver. scutil is omitted too, so resolver
# discovery has only /etc/resolv.conf to work with.
NO_PROBE_BIN="$WORK_DIR/no-probe-bin"
mkdir -p "$NO_PROBE_BIN"
# nslookup/host/getent are all acceptable lookup tools — include whichever this
# host has, so the check still finds a DNS_TOOL and the test exercises the probe
# path rather than the "no lookup tool at all" early exit. Debian-based images
# ship only getent; macOS ships nslookup and host.
for tool in bash cat sed awk grep tr head sort wc date hostname nslookup host getent; do
  tool_path=$(command -v "$tool" 2>/dev/null || true)
  if [ -n "$tool_path" ]; then
    ln -sf "$tool_path" "$NO_PROBE_BIN/$tool"
  fi
done

# An overlay that additionally makes resolver discovery come up empty, exactly
# as it would on a host whose /etc/resolv.conf carries no nameserver lines.
# Every grep that is not a nameserver lookup is passed through to the real one.
NO_RESOLVER_BIN="$WORK_DIR/no-resolver-bin"
mkdir -p "$NO_RESOLVER_BIN"
REAL_GREP=$(command -v grep)
cat > "$NO_RESOLVER_BIN/grep" <<EOF
#!/usr/bin/env bash
for arg in "\$@"; do
  case "\$arg" in
    *nameserver*) exit 1 ;;
  esac
done
exec "$REAL_GREP" "\$@"
EOF
chmod +x "$NO_RESOLVER_BIN/grep"

# A PATH with sysctl but without vm_stat — the shape of a BSD-ish host with no
# /proc/meminfo. The memory check can read the machine's total RAM there but has
# no way to measure how much of it is in use.
#
# Everything here is pinned rather than inherited: a real `sysctl` is stubbed so
# the sysctl branch is definitely taken, vm_stat is definitely absent, and the
# test pairs this with CRISISMODE_MEMINFO_PATH pointing at a nonexistent file.
# Without all three, a Linux host would take the /proc/meminfo branch and the
# test would be asserting something other than what it claims.
NO_VM_STAT_BIN="$WORK_DIR/no-vm-stat-bin"
mkdir -p "$NO_VM_STAT_BIN"
for tool in bash cat sed head printf; do
  tool_path=$(command -v "$tool" 2>/dev/null || true)
  if [ -n "$tool_path" ]; then
    ln -sf "$tool_path" "$NO_VM_STAT_BIN/$tool"
  fi
done
cat > "$NO_VM_STAT_BIN/sysctl" <<'EOF'
#!/bin/sh
# Stub: report a plausible total RAM for hw.memsize, nothing else.
case "$*" in
  *hw.memsize*) echo 17179869184 ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$NO_VM_STAT_BIN/sysctl"

# ── Helpers ──

run_check() {
  local check_path="$1" path_override="$2" verb="$3"
  printf '{"verb":"%s","target":{"name":"dns","kind":"network"},"context":{}}' "$verb" \
    | PATH="$path_override" "$check_path"
}

# Same, with an explicit meminfo path so the branch under test is deterministic
# on every platform rather than "whatever this host happens to have".
run_check_meminfo() {
  local check_path="$1" path_override="$2" verb="$3" meminfo="$4"
  printf '{"verb":"%s","target":{"name":"memory","kind":"generic"},"context":{}}' "$verb" \
    | PATH="$path_override" CRISISMODE_MEMINFO_PATH="$meminfo" "$check_path"
}

# Read a value out of the check's JSON result.
#   $1 = JSON, $2 = node expression over `r` (the parsed result)
json_query() {
  local json="$1" expr="$2" script
  script='const chunks = [];
process.stdin.on("data", (d) => chunks.push(d));
process.stdin.on("end", () => {
  const r = JSON.parse(chunks.join(""));
  const out = ('"$expr"');
  process.stdout.write(typeof out === "string" ? out : JSON.stringify(out));
});'
  printf '%s' "$json" | node -e "$script"
}

ok() {
  PASS=$((PASS + 1))
  printf '  ok   %s\n' "$1"
}

not_ok() {
  FAIL=$((FAIL + 1))
  printf '  FAIL %s\n' "$1"
  printf '       %s\n' "$2"
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    ok "$label"
  else
    not_ok "$label" "expected '$expected', got '$actual'"
  fi
}

assert_ne() {
  local label="$1" forbidden="$2" actual="$3"
  if [ "$forbidden" != "$actual" ]; then
    ok "$label"
  else
    not_ok "$label" "got the forbidden value '$forbidden'"
  fi
}

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  case "$haystack" in
    *"$needle"*) ok "$label" ;;
    *) not_ok "$label" "expected to contain '$needle', got '$haystack'" ;;
  esac
}

assert_not_contains() {
  local label="$1" needle="$2" haystack="$3"
  case "$haystack" in
    *"$needle"*) not_ok "$label" "expected NOT to contain '$needle', got '$haystack'" ;;
    *) ok "$label" ;;
  esac
}

assert_ge() {
  local label="$1" floor="$2" actual="$3"
  if [ "$actual" -ge "$floor" ]; then
    ok "$label"
  else
    not_ok "$label" "expected >= $floor, got $actual"
  fi
}

# ── check-dns-resolution ──

printf '\ncheck-dns-resolution: no resolvers discovered\n'

OUT=""
RC=0
OUT=$(run_check "$DNS_CHECK" "$NO_RESOLVER_BIN:$NO_PROBE_BIN" health) && RC=0 || RC=$?

RESOLVER_SIGNAL_STATUS=$(json_query "$OUT" 'r.signals.filter(s => s.source === "resolvers").map(s => s.status).join(",")')
RESOLVER_SIGNAL_DETAIL=$(json_query "$OUT" 'r.signals.filter(s => s.source === "resolvers").map(s => s.detail).join(" | ")')

assert_ne 'resolver signal is not healthy when zero resolvers were discovered' \
  'healthy' "$RESOLVER_SIGNAL_STATUS"
assert_eq 'resolver signal is unknown when zero resolvers were discovered' \
  'unknown' "$RESOLVER_SIGNAL_STATUS"
assert_contains 'resolver signal detail names the reason' \
  'No DNS resolvers' "$RESOLVER_SIGNAL_DETAIL"
assert_not_contains 'resolver signal detail does not leak the internal sentinel' \
  'none found' "$RESOLVER_SIGNAL_DETAIL"
assert_ge 'exit code is at least 1 when zero resolvers were discovered' 1 "$RC"

printf '\ncheck-dns-resolution: no resolver probe tool (no dig, no nc)\n'

OUT=$(run_check "$DNS_CHECK" "$NO_PROBE_BIN" health) && RC=0 || RC=$?

HEALTHY_RESOLVER_SIGNALS=$(json_query "$OUT" 'r.signals.filter(s => s.source === "resolvers" && s.status === "healthy").length')
UNKNOWN_RESOLVER_DETAIL=$(json_query "$OUT" 'r.signals.filter(s => s.source === "resolvers" && s.status === "unknown").map(s => s.detail).join(" | ")')

assert_eq 'no resolver is reported reachable without being probed' \
  '0' "$HEALTHY_RESOLVER_SIGNALS"
assert_contains 'unprobed resolvers are reported as unverified' \
  'Cannot verify' "$UNKNOWN_RESOLVER_DETAIL"

SUMMARY=$(json_query "$OUT" 'r.summary')
assert_not_contains 'summary does not claim resolvers are reachable when none were probed' \
  'resolvers reachable' "$SUMMARY"

# The overall verdict stays healthy here on purpose: canary resolution is a real
# passing measurement, and you cannot resolve dns.google without a working
# resolver. What is missing is coverage, not health — so it is reported through
# `confidence` (the contract's field for "how sure am I") rather than by
# downgrading a working system. See the PR body for the full reasoning.
OVERALL_STATUS=$(json_query "$OUT" 'r.status')
CONFIDENCE=$(json_query "$OUT" 'r.confidence')

assert_eq 'overall status stays healthy when the only gap is unprobed resolvers' \
  'healthy' "$OVERALL_STATUS"
assert_eq 'exit code agrees with the healthy status' '0' "$RC"
assert_eq 'confidence is reduced to signal partial verification' \
  'true' "$(node -e "process.stdout.write(String($CONFIDENCE < 0.9))")"

printf '\ncheck-dns-resolution: diagnose summary with no probe tool\n'

OUT=$(run_check "$DNS_CHECK" "$NO_PROBE_BIN" diagnose) && RC=0 || RC=$?

DIAG_SUMMARY=$(json_query "$OUT" 'r.summary')
assert_not_contains 'diagnose summary does not claim resolvers are reachable when none were probed' \
  'resolvers reachable' "$DIAG_SUMMARY"

printf '\ncheck-dns-resolution: diagnose verb with no probe tool\n'

OUT=$(run_check "$DNS_CHECK" "$NO_PROBE_BIN" diagnose) && RC=0 || RC=$?

REACHABLE_CLAIMS=$(json_query "$OUT" 'r.findings.filter(f => /^Reachable/.test(f.detail)).length')
assert_eq 'diagnose never claims a resolver is reachable without probing it' \
  '0' "$REACHABLE_CLAIMS"

printf '\ncheck-dns-resolution: baseline with a normal PATH\n'

OUT=$(run_check "$DNS_CHECK" "$PATH" health) && RC=0 || RC=$?

BASELINE_STATUS=$(json_query "$OUT" 'r.status')
assert_ne 'baseline result parses as JSON with a status' '' "$BASELINE_STATUS"
assert_ge 'baseline exit code is a valid check exit code' 0 "$RC"

# ── check-memory-usage ──
#
# Same class of defect as the DNS check: a missing-binary fallback that
# fabricates a passing measurement instead of reporting "cannot measure".

printf '\ncheck-memory-usage: no vm_stat to measure used memory with\n'

OUT=$(run_check_meminfo "$MEMORY_CHECK" "$NO_VM_STAT_BIN" health "$WORK_DIR/no-such-meminfo") && RC=0 || RC=$?

assert_contains 'the sysctl/no-vm_stat branch is the one actually exercised' \
  'vm_stat' "$(json_query "$OUT" 'r.summary')"

MEM_STATUS=$(json_query "$OUT" 'r.status')
assert_ne 'memory usage is not reported healthy when it cannot be measured' \
  'healthy' "$MEM_STATUS"
assert_eq 'memory check reports unknown when it cannot be measured' \
  'unknown' "$MEM_STATUS"
assert_eq 'memory check exits 3 (unknown) when it cannot be measured' '3' "$RC"

# ── Summary ──

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
