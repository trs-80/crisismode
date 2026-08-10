#!/bin/bash
set -euo pipefail

# CLI integration smoke tests for CrisisMode.
#
# Runs the built CLI as a subprocess (same as a real user) and checks
# for crashes, correct output, ID consistency, and formatting.
#
# When stdout is captured (not a TTY), the CLI auto-switches to pipe mode
# (tab-separated text) or JSON mode (JSONL). Tests validate both.
#
# Prerequisites:
#   pnpm run build    (must be run first)
#
# Usage:
#   ./test/cli/smoke.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLI="node $REPO_DIR/dist/cli/index.js"
PASS=0
FAIL=0
TOTAL=0

# ── Helpers ──

pass() { echo "  ✅ $1"; PASS=$((PASS + 1)); TOTAL=$((TOTAL + 1)); }
fail() { echo "  ❌ $1: $2"; FAIL=$((FAIL + 1)); TOTAL=$((TOTAL + 1)); }

# Run a command and capture stdout, stderr, and exit code.
# Sets: CMD_OUT, CMD_ERR, CMD_EXIT
run_cli() {
  CMD_OUT=""
  CMD_ERR=""
  CMD_EXIT=0
  local tmpstderr
  tmpstderr=$(mktemp)
  CMD_OUT=$(eval "$CLI $*" 2>"$tmpstderr" </dev/null) || CMD_EXIT=$?
  CMD_ERR=$(cat "$tmpstderr")
  rm -f "$tmpstderr"
}

# Assert exit code is 0
assert_exit_ok() {
  local name="$1"
  if [ "$CMD_EXIT" -eq 0 ]; then
    pass "$name"
  else
    fail "$name" "exit code $CMD_EXIT"
  fi
}

# Assert an exact exit code.
#
# Every negative case below uses this. Before it existed this suite only ever
# asserted success: `assert_no_crash` merely greps for stack traces, so
# `crisismode notacommand` could exit 0 and still pass.
#
# The contract (src/cli/exit-codes.ts):
#   0   healthy / the command did what was asked
#   1   ran fine, the answer is bad news (unhealthy target, service down)
#   2   called wrong (unknown command/flag, missing flag value, bad config)
#   70  unexpected internal failure
assert_exit_code() {
  local name="$1"
  local expected="$2"
  if [ "$CMD_EXIT" -eq "$expected" ]; then
    pass "$name"
  else
    fail "$name" "expected exit $expected, got $CMD_EXIT"
  fi
}

# Assert the exit code is one of a set — for commands whose code depends on
# what they find on this machine (scan, triage, down). The point is that it
# is never 2 (usage) or 70 (internal).
assert_exit_one_of() {
  local name="$1"
  shift
  local code
  for code in "$@"; do
    if [ "$CMD_EXIT" -eq "$code" ]; then
      pass "$name"
      return
    fi
  done
  fail "$name" "expected one of [$*], got $CMD_EXIT"
}

# Assert stderr contains a string
assert_stderr_contains() {
  local name="$1"
  local needle="$2"
  if echo "$CMD_ERR" | grep -qF -- "$needle"; then
    pass "$name"
  else
    fail "$name" "stderr missing '$needle'"
  fi
}

# Assert stdout contains a string.
# `--` before the pattern: half the needles here are flag names like
# "--notaflag", which grep would otherwise try to interpret as its own option.
assert_contains() {
  local name="$1"
  local needle="$2"
  if echo "$CMD_OUT" | grep -qF -- "$needle"; then
    pass "$name"
  else
    fail "$name" "output missing '$needle'"
  fi
}

# Assert stdout does NOT contain a string
assert_not_contains() {
  local name="$1"
  local needle="$2"
  if echo "$CMD_OUT" | grep -qF -- "$needle"; then
    fail "$name" "output contains '$needle'"
  else
    pass "$name"
  fi
}

# Assert the captured stdout is strict JSONL: every line a standalone JSON
# object, no blank lines.
#
# A bare `console.log('')` sitting next to machine-mode-aware printers
# (printInfo and friends no-op for --json; a raw blank line does not) put
# empty lines into the middle of the stream, which breaks
# `while read l; do ... jq ...; done`. Checked for every --json surface, not
# just scan — diagnose had two of them.
assert_strict_jsonl() {
  local name="$1"
  local result
  result=$(printf '%s' "$CMD_OUT" | node -e "
let d='';
process.stdin.on('data',c=>d+=c);
process.stdin.on('end',()=>{
  const lines=d.split('\n');
  const bad=[];
  lines.forEach((l,i)=>{
    if(l==='' && i===lines.length-1) return;
    if(l.trim()===''){ bad.push('blank line at '+(i+1)); return; }
    try { JSON.parse(l); } catch(e) { bad.push('line '+(i+1)+': '+e.message); }
  });
  console.log(bad.length?bad.join('; '):'ok');
})" 2>/dev/null || echo "node error")
  if [ "$result" = "ok" ]; then
    pass "$name"
  else
    fail "$name" "$result"
  fi
}

# Assert neither stdout nor stderr contains stack traces or runtime errors
assert_no_crash() {
  local name="$1"
  if echo "$CMD_OUT$CMD_ERR" | grep -qE '^\s+at\s+|Cannot read properties of|TypeError:|ReferenceError:|SyntaxError:'; then
    fail "$name" "stack trace or runtime error in output"
  else
    pass "$name"
  fi
}

# ── Setup ──

# Verify build exists
if [ ! -f "$REPO_DIR/dist/cli/index.js" ]; then
  echo "❌ dist/cli/index.js not found. Run 'pnpm run build' first."
  exit 1
fi

echo "🧪 CrisisMode CLI Smoke Tests"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ══════════════════════════════════════════
# 1. Basic commands
# ══════════════════════════════════════════

echo "── Basic commands ──"

run_cli "--help"
assert_exit_ok "help exits cleanly"
assert_contains "help shows usage" "Usage:"

run_cli "--version"
assert_exit_ok "version exits cleanly"

run_cli "demo"
assert_exit_ok "demo exits cleanly"
assert_no_crash "demo has no crashes"

echo ""

# ══════════════════════════════════════════
# 2. Scan (pipe mode — auto-detected when captured)
# ══════════════════════════════════════════

echo "── Scan (pipe mode) ──"

# scan's exit code now reflects what it found: 0 when everything checked is
# healthy/unknown, 1 when anything is unhealthy or recovering. Which one
# depends on this machine, so assert only that it is a health verdict and
# never a usage (2) or internal (70) failure.
run_cli "scan"
assert_exit_one_of "scan exits 0 or 1 (health verdict), never 2 or 70" 0 1
assert_no_crash "scan has no crashes"

# Pipe mode outputs tab-separated lines: "finding\tID\tService\tStatus\t..."
assert_contains "scan has findings" "finding"

# Every finding line should have an ID
FINDING_LINES=$(echo "$CMD_OUT" | grep "^finding" || true)
if [ -n "$FINDING_LINES" ]; then
  pass "scan produces finding lines"

  # Check all findings have non-empty IDs and services
  BAD_FINDINGS=""
  while IFS=$'\t' read -r _type id service status _conf _summary; do
    if [ -z "$id" ] || [ -z "$service" ]; then
      BAD_FINDINGS="$BAD_FINDINGS missing id/service;"
    fi
    if [ -z "$status" ]; then
      BAD_FINDINGS="$BAD_FINDINGS $id missing status;"
    fi
  done <<< "$FINDING_LINES"
  if [ -z "$BAD_FINDINGS" ]; then
    pass "scan findings have id, service, and status"
  else
    fail "scan findings have id, service, and status" "$BAD_FINDINGS"
  fi
else
  fail "scan produces finding lines" "no finding lines in pipe output"
fi

echo ""

# ══════════════════════════════════════════
# 3. Scan (JSON output)
# ══════════════════════════════════════════

echo "── Scan (JSON output) ──"

run_cli "scan --json"
assert_exit_one_of "scan --json exits 0 or 1 (health verdict)" 0 1
assert_no_crash "scan --json has no crashes"

assert_strict_jsonl "scan --json is strict JSONL (no blank or non-JSON lines)"

# JSON mode outputs JSONL — one JSON object per line.
# The scan result line has "type":"scan"
SCAN_JSON=$(echo "$CMD_OUT" | grep '"type":"scan"' || true)
if [ -n "$SCAN_JSON" ]; then
  pass "scan --json has scan result line"
else
  fail "scan --json has scan result line" "no line with type:scan found"
  # Skip dependent tests
  echo ""
  echo "── Scan → Diagnose flow ──"
  echo "  (skipped — no JSON scan result)"
  echo ""
  echo "── ID stability ──"
  echo "  (skipped — no JSON scan result)"
  echo ""
  echo "── Error handling ──"
  run_cli "notacommand"
  assert_exit_code "unknown command exits 2 (usage)" 2
  assert_no_crash "unknown command has no crashes"
  run_cli "scan --notaflag"
  assert_exit_code "unknown flag exits 2 (usage)" 2
  assert_no_crash "invalid flag has no crashes"
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Results: $PASS passed, $FAIL failed ($TOTAL total)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  [ "$FAIL" -gt 0 ] && exit 1
  exit 0
fi

# Validate the scan JSON line is parseable
SCAN_VALID=$(echo "$SCAN_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{JSON.parse(d);console.log('ok')}catch{console.log('invalid')}})" 2>/dev/null || echo "error")
if [ "$SCAN_VALID" = "ok" ]; then
  pass "scan --json result is valid JSON"
else
  fail "scan --json result is valid JSON" "$SCAN_VALID"
fi

# Parse and validate structure
SCAN_CHECK=$(echo "$SCAN_JSON" | node -e "
let d='';
process.stdin.on('data',c=>d+=c);
process.stdin.on('end',()=>{
  try {
    const r=JSON.parse(d);
    const errors=[];
    if(typeof r.score!=='number'||r.score<0||r.score>100) errors.push('score not 0-100: '+r.score);
    if(!Array.isArray(r.findings)) errors.push('findings not array');
    if(!r.scannedAt) errors.push('missing scannedAt');
    if(typeof r.durationMs!=='number') errors.push('missing durationMs');
    const ids=new Set();
    for(const f of r.findings||[]){
      if(!f.id) errors.push('finding missing id');
      if(!f.service) errors.push(f.id+' missing service');
      if(!f.status) errors.push(f.id+' missing status');
      if(typeof f.summary!=='string') errors.push(f.id+' missing summary');
      if(ids.has(f.id)) errors.push(f.id+' duplicate id');
      ids.add(f.id);
    }
    console.log(errors.length?errors.join('; '):'ok');
  } catch(e) { console.log('parse error: '+e.message); }
})" 2>/dev/null || echo "node error")

if [ "$SCAN_CHECK" = "ok" ]; then
  pass "scan --json structure is valid (score, findings, unique IDs)"
else
  fail "scan --json structure is valid" "$SCAN_CHECK"
fi

FINDING_COUNT=$(echo "$SCAN_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{console.log(JSON.parse(d).findings.length)})" 2>/dev/null || echo "0")
if [ "$FINDING_COUNT" -gt 0 ] 2>/dev/null; then
  pass "scan --json has findings ($FINDING_COUNT)"
else
  fail "scan --json has findings" "got $FINDING_COUNT"
fi

echo ""

# ══════════════════════════════════════════
# 4. ID consistency: scan → diagnose
# ══════════════════════════════════════════

echo "── Scan → Diagnose flow ──"

# Get first PLUG-* finding
FIRST_PLUG=$(echo "$SCAN_JSON" | node -e "
let d='';
process.stdin.on('data',c=>d+=c);
process.stdin.on('end',()=>{
  const r=JSON.parse(d);
  const plug=r.findings.find(f=>f.id.startsWith('PLUG-'));
  if(plug) console.log(plug.id+'|'+plug.service);
  else console.log('');
})" 2>/dev/null || echo "")

if [ -n "$FIRST_PLUG" ]; then
  PLUG_ID=$(echo "$FIRST_PLUG" | cut -d'|' -f1)
  PLUG_SERVICE=$(echo "$FIRST_PLUG" | cut -d'|' -f2)
  # Extract plugin name from "plugin (check-foo-bar)"
  PLUG_NAME=$(echo "$PLUG_SERVICE" | sed 's/plugin (\(.*\))/\1/')

  pass "scan has PLUG findings ($PLUG_ID = $PLUG_NAME)"

  # Run diagnose with that ID and verify it references the correct plugin
  run_cli "diagnose $PLUG_ID"
  assert_exit_one_of "diagnose $PLUG_ID exits 0 or 1 (health verdict)" 0 1
  assert_no_crash "diagnose $PLUG_ID has no crashes"
  assert_contains "diagnose $PLUG_ID routes to correct plugin" "$PLUG_NAME"
else
  fail "scan has PLUG findings" "no PLUG-* findings in scan output"
fi

# Test diagnose with an agent ID (PG-001 etc.) — should not crash even if no service is running
FIRST_AGENT=$(echo "$SCAN_JSON" | node -e "
let d='';
process.stdin.on('data',c=>d+=c);
process.stdin.on('end',()=>{
  const r=JSON.parse(d);
  const a=r.findings.find(f=>!f.id.startsWith('PLUG-'));
  if(a) console.log(a.id);
  else console.log('');
})" 2>/dev/null || echo "")

if [ -n "$FIRST_AGENT" ]; then
  # Only PLUG-* finding IDs are routable as a `diagnose` argument; an agent
  # finding ID (PG-001, ...) is matched against *target names* and resolves
  # to nothing — see the note in src/cli/incident-summary.ts. That is a
  # usage error (2), not a health verdict. It used to be a bare `exit 1`
  # from the top-level catch, indistinguishable from "the database is down".
  run_cli "diagnose $FIRST_AGENT"
  assert_exit_code "diagnose $FIRST_AGENT (unroutable finding ID) exits 2 (usage)" 2
  assert_stderr_contains "diagnose $FIRST_AGENT names the unknown target" "$FIRST_AGENT"
  assert_no_crash "diagnose $FIRST_AGENT (agent) has no crashes"
fi

echo ""

# ══════════════════════════════════════════
# 5. ID stability across runs
# ══════════════════════════════════════════

echo "── ID stability ──"

# Run scan --json twice and compare finding order
run_cli "scan --json"
SCAN1=$(echo "$CMD_OUT" | grep '"type":"scan"' || true)

run_cli "scan --json"
SCAN2=$(echo "$CMD_OUT" | grep '"type":"scan"' || true)

if [ -n "$SCAN1" ] && [ -n "$SCAN2" ]; then
  ID_STABLE=$(node -e "
  const s1=JSON.parse(process.argv[1]);
  const s2=JSON.parse(process.argv[2]);
  const mismatches=[];
  for(let i=0;i<Math.min(s1.findings.length,s2.findings.length);i++){
    if(s1.findings[i].id!==s2.findings[i].id || s1.findings[i].service!==s2.findings[i].service){
      mismatches.push(s1.findings[i].id+'='+s1.findings[i].service+' vs '+s2.findings[i].id+'='+s2.findings[i].service);
    }
  }
  if(s1.findings.length!==s2.findings.length) mismatches.push('different finding counts: '+s1.findings.length+' vs '+s2.findings.length);
  console.log(mismatches.length?mismatches.join('; '):'ok');
  " "$SCAN1" "$SCAN2" 2>/dev/null || echo "parse error")
  if [ "$ID_STABLE" = "ok" ]; then
    pass "finding IDs are stable across runs"
  else
    fail "finding IDs are stable across runs" "$ID_STABLE"
  fi
else
  fail "finding IDs are stable across runs" "could not get two scan results"
fi

echo ""

# ══════════════════════════════════════════
# 6. Error handling
# ══════════════════════════════════════════

echo "── Error handling (exit-code contract) ──"

# NOTE: `|| true` used to be appended to these invocations. It was dead code —
# run_cli already traps the status into CMD_EXIT, so the `||` branch can
# never fire — and it advertised an intent (tolerate failure) that hid the
# fact that nothing here checked the exit code at all.

# Unknown command: names the offending token and exits 2.
run_cli "notacommand"
assert_exit_code "unknown command exits 2 (usage)" 2
assert_stderr_contains "unknown command names the token" "notacommand"
assert_no_crash "unknown command has no crashes"

# A near miss suggests the real command.
run_cli "diagnos"
assert_exit_code "near-miss command exits 2 (usage)" 2
assert_stderr_contains "near-miss command suggests 'diagnose'" "diagnose"

# Unknown flag: rejected rather than silently accepted.
run_cli "scan --notaflag"
assert_exit_code "unknown flag exits 2 (usage)" 2
assert_stderr_contains "unknown flag names the flag" "--notaflag"

# A flag scoped to a different command is a usage error too.
run_cli "diagnose --category redis"
assert_exit_code "flag from another command exits 2 (usage)" 2

# A value-taking flag with a missing (or flag-like) value.
run_cli "--config"
assert_exit_code "bare --config exits 2 (usage)" 2
assert_stderr_contains "bare --config names --config" "--config"

# Missing required subcommand. `down --bogusflag` has always exited 2; these
# were 1 for exactly the same class of mistake.
for SUB in agent playbook registry bundle completions; do
  run_cli "$SUB"
  assert_exit_code "$SUB with no subcommand exits 2 (usage)" 2
done

# A config file that does not exist is the user calling it wrong.
run_cli "scan --config /nonexistent/crisismode.yaml"
assert_exit_code "missing --config file exits 2 (usage)" 2

# Invalid diagnose target should not crash
run_cli "diagnose PLUG-999"
assert_no_crash "diagnose nonexistent PLUG-999 has no crashes"

echo ""

# ══════════════════════════════════════════
# 6b. A global flag placed before the subcommand
# ══════════════════════════════════════════

echo "── Global flag before the subcommand ──"

# These used to run `scan` and exit 0, silently ignoring the command asked for.
run_cli "--verbose completions bash"
assert_exit_ok "--verbose completions bash exits cleanly"
assert_contains "--verbose completions bash runs completions, not scan" "_crisismode_completions"
assert_not_contains "--verbose completions bash produced no scan output" "finding"

run_cli "--json completions fish"
assert_contains "--json completions fish runs completions, not scan" "complete -c crisismode"

# `--json diagnose` used to emit a JSON *scan* record. It must now emit
# diagnose's own records and no scan record, in either flag ordering, and
# both orderings must produce the same record types.
run_cli "--json diagnose"
assert_exit_one_of "--json diagnose exits 0 or 1 (health verdict)" 0 1
assert_not_contains "--json diagnose emits no scan record" '"type":"scan"'
assert_contains "--json diagnose emits diagnose's own records" '"type":"health"'
assert_strict_jsonl "--json diagnose is strict JSONL"
FLAG_FIRST_TYPES=$(echo "$CMD_OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{console.log(d.split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l).type}catch(e){return 'NON-JSON'}}).join(','))})" 2>/dev/null || echo "err")

run_cli "diagnose --json"
assert_strict_jsonl "diagnose --json is strict JSONL"
FLAG_LAST_TYPES=$(echo "$CMD_OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{console.log(d.split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l).type}catch(e){return 'NON-JSON'}}).join(','))})" 2>/dev/null || echo "err")

if [ "$FLAG_FIRST_TYPES" = "$FLAG_LAST_TYPES" ] && [ -n "$FLAG_FIRST_TYPES" ]; then
  pass "flag order does not change diagnose output ($FLAG_FIRST_TYPES)"
else
  fail "flag order does not change diagnose output" "'--json diagnose'=[$FLAG_FIRST_TYPES] vs 'diagnose --json'=[$FLAG_LAST_TYPES]"
fi

echo ""

# ══════════════════════════════════════════
# 6c. Documented contracts this suite never checked
# ══════════════════════════════════════════

echo "── triage / down contracts ──"

# triage: 1 on local/network/mixed, 0 on healthy/remote. Which one depends on
# this machine's network; never 2 or 70.
run_cli "triage"
assert_exit_one_of "triage exits 0 or 1 (verdict-dependent), never 2" 0 1
assert_no_crash "triage has no crashes"

# down: 2 on bad usage — the one command that already got this right, and the
# contract CLAUDE.md documents. Unchanged by the exit-code centralization.
run_cli "down --bogusflag"
assert_exit_code "down --bogusflag exits 2 (usage)" 2
assert_stderr_contains "down --bogusflag names the flag" "--bogusflag"

run_cli "down 'http://api.foo.com/path'"
assert_exit_code "down with a malformed service arg exits 2 (usage)" 2
assert_stderr_contains "down names the malformed arg" "http://api.foo.com/path"

# Bare `down` reads the config's services: list — 0 or 1, never a usage error.
run_cli "down"
assert_exit_one_of "bare down exits 0 or 1, never 2" 0 1

echo ""

# ══════════════════════════════════════════
# 6d. watch --interval must never start a hot loop
# ══════════════════════════════════════════

echo "── watch --interval validation ──"

# `--interval abc` became NaN, survived watch.ts's `?? DEFAULT` (`??` only
# catches null/undefined), and setTimeout(fn, NaN) clamps to 1ms — a
# continuous scan loop against already-degraded infrastructure, printing
# "every NaNs" to the operator. `--interval 1m` silently meant one second.
# These must all be rejected before the loop starts, so each returns
# immediately rather than needing a timeout to kill it.
for BAD in "abc" "1m" "60s" "0" "--interval=-5" "--interval=0" "--interval=abc" "--interval=1.5"; do
  case "$BAD" in
    --*) run_cli "watch $BAD"; LABEL="watch $BAD" ;;
    *)   run_cli "watch --interval $BAD"; LABEL="watch --interval $BAD" ;;
  esac
  assert_exit_code "$LABEL exits 2 (usage), never loops" 2
  assert_stderr_contains "$LABEL names --interval" "--interval"
  assert_not_contains "$LABEL never prints a NaN/0/negative interval" "every NaN"
done

echo ""

# ══════════════════════════════════════════
# 7. Output modes
# ══════════════════════════════════════════

echo "── Output modes ──"

run_cli "scan --no-color"
assert_exit_one_of "scan --no-color exits 0 or 1 (health verdict)" 0 1
# Check no ANSI escape sequences (ESC[...)
if echo "$CMD_OUT" | grep -q $'\033\['; then
  fail "scan --no-color has no ANSI codes" "ANSI escape sequences found"
else
  pass "scan --no-color has no ANSI codes"
fi

echo ""

# ══════════════════════════════════════════
# Summary
# ══════════════════════════════════════════

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Results: $PASS passed, $FAIL failed ($TOTAL total)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
