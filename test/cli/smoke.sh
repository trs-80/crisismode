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

# Assert stdout contains a string
assert_contains() {
  local name="$1"
  local needle="$2"
  if echo "$CMD_OUT" | grep -qF "$needle"; then
    pass "$name"
  else
    fail "$name" "output missing '$needle'"
  fi
}

# Assert stdout does NOT contain a string
assert_not_contains() {
  local name="$1"
  local needle="$2"
  if echo "$CMD_OUT" | grep -qF "$needle"; then
    fail "$name" "output contains '$needle'"
  else
    pass "$name"
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

run_cli "scan"
assert_exit_ok "scan exits cleanly"
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
assert_exit_ok "scan --json exits cleanly"
assert_no_crash "scan --json has no crashes"

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
  run_cli "notacommand" || true
  assert_no_crash "unknown command has no crashes"
  run_cli "scan --notaflag" || true
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
  assert_exit_ok "diagnose $PLUG_ID exits cleanly"
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
  run_cli "diagnose $FIRST_AGENT" || true
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

echo "── Error handling ──"

# Unknown command should not crash
run_cli "notacommand" || true
assert_no_crash "unknown command has no crashes"

# Invalid diagnose target should not crash
run_cli "diagnose PLUG-999" || true
assert_no_crash "diagnose nonexistent PLUG-999 has no crashes"

echo ""

# ══════════════════════════════════════════
# 7. Output modes
# ══════════════════════════════════════════

echo "── Output modes ──"

run_cli "scan --no-color"
assert_exit_ok "scan --no-color exits cleanly"
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
