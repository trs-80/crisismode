#!/usr/bin/env bash
set -euo pipefail

# Shell-level tests for the bundled check plugins in checks/*.
#
# These exercise the check executables the way the framework does: a JSON
# request on stdin, a JSON result on stdout, exit codes 0=OK, 1=warning,
# 2=critical, 3=unknown (see src/framework/check-plugin.ts).
#
# The point of this harness is to run the checks in a *degraded* environment — a
# PATH without the binaries they probe with, and resolver discovery finding
# nothing. A check that reports "healthy" because a probe binary is missing is
# worse than no check at all.
#
# Every degraded scenario is hermetic: lookup tools are stubbed and resolver
# discovery is pinned to a fixture, so no test performs a live DNS query and the
# suite passes with no network at all. Only the explicitly-labelled baseline case
# touches the real toolchain, and it asserts contract shape rather than a verdict.
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
# the two tools it uses to probe a resolver.
#
# The lookup tool is a *stub*, not the host's real one. The check resolves canary
# hostnames (dns.google, cloudflare.com) to decide whether DNS works at all, and
# linking a real nslookup/getent here would put a live DNS query in the middle of
# a unit test: the suite would then fail offline, in a sandboxed runner, or behind
# a captive portal, for reasons that have nothing to do with the behaviour under
# test. Worse for this specific case, canary success is what holds overall_status
# at healthy in the no-probe scenario, so a network blip would flip the assertion.
#
# Stubbing getent also pins DNS_TOOL to the same branch on every platform (the
# check prefers dig > nslookup > host > getent, and the first three are absent
# here), so macOS and Linux exercise identical code.
NO_PROBE_BIN="$WORK_DIR/no-probe-bin"
mkdir -p "$NO_PROBE_BIN"
for tool in bash cat sed awk grep tr head sort wc date hostname; do
  tool_path=$(command -v "$tool" 2>/dev/null || true)
  if [ -n "$tool_path" ]; then
    ln -sf "$tool_path" "$NO_PROBE_BIN/$tool"
  fi
done
cat > "$NO_PROBE_BIN/getent" <<'EOF'
#!/bin/sh
# Stub: resolve any host to a fixed address, with no network involved.
case "$1" in
  hosts) echo "203.0.113.10  $2" ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$NO_PROBE_BIN/getent"

# Resolver-discovery fixtures. Pinning these (rather than reading the host's real
# /etc/resolv.conf) is what makes both DNS scenarios deterministic: one file has
# nameservers, the other has none, and neither depends on how this machine or CI
# runner happens to be configured.
RESOLV_CONF_WITH="$WORK_DIR/resolv-with-nameservers.conf"
printf 'search example.invalid\nnameserver 203.0.113.1\nnameserver 203.0.113.2\n' > "$RESOLV_CONF_WITH"

RESOLV_CONF_EMPTY="$WORK_DIR/resolv-no-nameservers.conf"
printf 'search example.invalid\n' > "$RESOLV_CONF_EMPTY"

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

# Run the DNS check against a pinned resolver-discovery fixture.
run_dns_check() {
  local path_override="$1" verb="$2" resolv_conf="$3"
  printf '{"verb":"%s","target":{"name":"dns","kind":"network"},"context":{}}' "$verb" \
    | PATH="$path_override" CRISISMODE_RESOLV_CONF="$resolv_conf" "$DNS_CHECK"
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

# A negative assertion against an empty string always succeeds, so it would
# "pass" against a renamed field, a check that died early, or output that was
# never produced — testing nothing. Empty input is therefore a failure here, not
# a pass.
assert_not_contains() {
  local label="$1" needle="$2" haystack="$3"
  if [ -z "$haystack" ]; then
    not_ok "$label" "refusing to pass vacuously: value was empty, so there was nothing to check for '$needle'"
    return
  fi
  case "$haystack" in
    *"$needle"*) not_ok "$label" "expected NOT to contain '$needle', got '$haystack'" ;;
    *) ok "$label" ;;
  esac
}

assert_non_empty() {
  local label="$1" actual="$2"
  if [ -n "$actual" ]; then
    ok "$label"
  else
    not_ok "$label" "expected a non-empty value, got nothing"
  fi
}

# The check-plugin contract defines exactly four exit codes (see
# src/framework/check-plugin.ts). Anything else — a 127 from a missing
# interpreter, a 2 from an unexpected path — is a contract violation and must
# not be waved through by a >= comparison.
assert_valid_exit_code() {
  local label="$1" actual="$2"
  case "$actual" in
    0|1|2|3) ok "$label" ;;
    *) not_ok "$label" "expected a contract exit code (0=ok, 1=warning, 2=critical, 3=unknown), got '$actual'" ;;
  esac
}

assert_ge() {
  local label="$1" floor="$2" actual="$3"
  if [ "$actual" -ge "$floor" ] 2>/dev/null; then
    ok "$label"
  else
    not_ok "$label" "expected >= $floor, got $actual"
  fi
}

# ── check-dns-resolution ──

printf '\ncheck-dns-resolution: no resolvers discovered\n'

OUT=""
RC=0
OUT=$(run_dns_check "$NO_PROBE_BIN" health "$RESOLV_CONF_EMPTY") && RC=0 || RC=$?

RESOLVER_SIGNAL_STATUS=$(json_query "$OUT" 'r.signals.filter(s => s.source === "resolvers").map(s => s.status).join(",")')
RESOLVER_SIGNAL_DETAIL=$(json_query "$OUT" 'r.signals.filter(s => s.source === "resolvers").map(s => s.detail).join(" | ")')

assert_non_empty 'a resolvers signal was emitted at all' "$RESOLVER_SIGNAL_STATUS"
assert_non_empty 'the resolvers signal carries a detail' "$RESOLVER_SIGNAL_DETAIL"
assert_ne 'resolver signal is not healthy when zero resolvers were discovered' \
  'healthy' "$RESOLVER_SIGNAL_STATUS"
assert_eq 'resolver signal is unknown when zero resolvers were discovered' \
  'unknown' "$RESOLVER_SIGNAL_STATUS"
assert_contains 'resolver signal detail names the reason' \
  'No DNS resolvers' "$RESOLVER_SIGNAL_DETAIL"
assert_not_contains 'resolver signal detail does not leak the internal sentinel' \
  'none found' "$RESOLVER_SIGNAL_DETAIL"
assert_valid_exit_code 'exit code is one the contract defines' "$RC"
assert_ge 'exit code is at least 1 when zero resolvers were discovered' 1 "$RC"

printf '\ncheck-dns-resolution: no resolver probe tool (no dig, no nc)\n'

OUT=$(run_dns_check "$NO_PROBE_BIN" health "$RESOLV_CONF_WITH") && RC=0 || RC=$?

HEALTHY_RESOLVER_SIGNALS=$(json_query "$OUT" 'r.signals.filter(s => s.source === "resolvers" && s.status === "healthy").length')
UNKNOWN_RESOLVER_DETAIL=$(json_query "$OUT" 'r.signals.filter(s => s.source === "resolvers" && s.status === "unknown").map(s => s.detail).join(" | ")')

assert_eq 'no resolver is reported reachable without being probed' \
  '0' "$HEALTHY_RESOLVER_SIGNALS"
assert_contains 'unprobed resolvers are reported as unverified' \
  'Cannot verify' "$UNKNOWN_RESOLVER_DETAIL"

SUMMARY=$(json_query "$OUT" 'r.summary')
assert_non_empty 'health verb emitted a summary' "$SUMMARY"
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
assert_valid_exit_code 'exit code is one the contract defines' "$RC"
assert_eq 'exit code agrees with the healthy status' '0' "$RC"
assert_eq 'confidence is reduced to signal partial verification' \
  'true' "$(node -e "process.stdout.write(String($CONFIDENCE < 0.9))")"

printf '\ncheck-dns-resolution: diagnose summary with no probe tool\n'

OUT=$(run_dns_check "$NO_PROBE_BIN" diagnose "$RESOLV_CONF_WITH") && RC=0 || RC=$?

DIAG_SUMMARY=$(json_query "$OUT" 'r.summary')
assert_non_empty 'diagnose verb emitted a summary' "$DIAG_SUMMARY"
assert_not_contains 'diagnose summary does not claim resolvers are reachable when none were probed' \
  'resolvers reachable' "$DIAG_SUMMARY"

printf '\ncheck-dns-resolution: diagnose verb with no probe tool\n'

OUT=$(run_dns_check "$NO_PROBE_BIN" diagnose "$RESOLV_CONF_WITH") && RC=0 || RC=$?

REACHABLE_CLAIMS=$(json_query "$OUT" 'r.findings.filter(f => /^Reachable/.test(f.detail)).length')
assert_eq 'diagnose never claims a resolver is reachable without probing it' \
  '0' "$REACHABLE_CLAIMS"

printf '\ncheck-dns-resolution: baseline with the real toolchain\n'
#
# This one deliberately uses the host's real tools and resolv.conf — it is the
# smoke test that the check still runs end to end against a real system. It only
# asserts contract shape (parseable status, a legal exit code), never a specific
# verdict, so it cannot fail because of what the network happened to be doing.

OUT=$(run_dns_check "$PATH" health "${CRISISMODE_RESOLV_CONF:-/etc/resolv.conf}") && RC=0 || RC=$?

BASELINE_STATUS=$(json_query "$OUT" 'r.status')
assert_non_empty 'baseline result parses as JSON with a status' "$BASELINE_STATUS"
assert_valid_exit_code 'baseline exit code is one the contract defines' "$RC"

# ── check-memory-usage ──
#
# Same class of defect as the DNS check: a missing-binary fallback that
# fabricates a passing measurement instead of reporting "cannot measure".

printf '\ncheck-memory-usage: no vm_stat to measure used memory with\n'

OUT=$(run_check_meminfo "$MEMORY_CHECK" "$NO_VM_STAT_BIN" health "$WORK_DIR/no-such-meminfo") && RC=0 || RC=$?

assert_contains 'the sysctl/no-vm_stat branch is the one actually exercised' \
  'vm_stat' "$(json_query "$OUT" 'r.summary')"

MEM_STATUS=$(json_query "$OUT" 'r.status')
assert_non_empty 'memory check emitted a status' "$MEM_STATUS"
assert_ne 'memory usage is not reported healthy when it cannot be measured' \
  'healthy' "$MEM_STATUS"
assert_eq 'memory check reports unknown when it cannot be measured' \
  'unknown' "$MEM_STATUS"
assert_valid_exit_code 'exit code is one the contract defines' "$RC"
assert_eq 'memory check exits 3 (unknown) when it cannot be measured' '3' "$RC"

# ── Summary ──

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
