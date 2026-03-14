#!/bin/bash
set -euo pipefail

# Tests each failure injection script to verify it creates the expected
# degraded state, then verifies reset restores health.

FAILURES_DIR="$(cd "$(dirname "$0")/../failures" && pwd)"
PASS=0
FAIL=0

pass() { echo "  ✅ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ❌ $1: $2"; FAIL=$((FAIL + 1)); }

echo "🧪 Failure Injection Tests"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# --- Test 1: Replication Lag ---
echo "📋 Test 1: Replication Lag Injection"
bash "$FAILURES_DIR/inject-replication-lag.sh" 0 > /dev/null 2>&1

# Verify lag exists (WAL replay should be paused)
REPLAY_PAUSED=$(podman exec cm-pg-replica psql -U crisismode -tAc \
    "SELECT pg_is_wal_replay_paused();" 2>/dev/null || echo "f")
if echo "$REPLAY_PAUSED" | grep -q "t"; then
    pass "Replication lag injected (WAL replay paused)"
else
    fail "Replication lag injection" "replay not paused"
fi

# Reset
bash "$FAILURES_DIR/reset.sh" > /dev/null 2>&1
REPLAY_RESUMED=$(podman exec cm-pg-replica psql -U crisismode -tAc \
    "SELECT pg_is_wal_replay_paused();" 2>/dev/null || echo "t")
if echo "$REPLAY_RESUMED" | grep -q "f"; then
    pass "Reset restored WAL replay"
else
    fail "Reset WAL replay" "still paused after reset"
fi
echo ""

# --- Test 2: Replication Slot Overflow ---
echo "📋 Test 2: Slot Overflow Injection"
bash "$FAILURES_DIR/inject-slot-overflow.sh" test_abandoned_slot > /dev/null 2>&1

SLOT_EXISTS=$(podman exec cm-pg-primary psql -U crisismode -tAc \
    "SELECT count(*) FROM pg_replication_slots WHERE slot_name = 'test_abandoned_slot';" 2>/dev/null || echo "0")
if [ "$SLOT_EXISTS" = "1" ]; then
    pass "Abandoned slot created"
else
    fail "Slot creation" "slot not found"
fi

# Reset
bash "$FAILURES_DIR/reset.sh" > /dev/null 2>&1
SLOT_GONE=$(podman exec cm-pg-primary psql -U crisismode -tAc \
    "SELECT count(*) FROM pg_replication_slots WHERE slot_name = 'test_abandoned_slot';" 2>/dev/null || echo "1")
if [ "$SLOT_GONE" = "0" ]; then
    pass "Reset cleaned up abandoned slot"
else
    fail "Slot cleanup" "slot still exists after reset"
fi
echo ""

# --- Test 3: Connection Flood ---
echo "📋 Test 3: Connection Flood Injection"
BEFORE_COUNT=$(podman exec cm-pg-primary psql -U crisismode -tAc \
    "SELECT count(*) FROM pg_stat_activity;" 2>/dev/null || echo "0")

bash "$FAILURES_DIR/inject-connection-flood.sh" 20 > /dev/null 2>&1
sleep 2

AFTER_COUNT=$(podman exec cm-pg-primary psql -U crisismode -tAc \
    "SELECT count(*) FROM pg_stat_activity;" 2>/dev/null || echo "0")

if [ "$AFTER_COUNT" -gt "$BEFORE_COUNT" ]; then
    pass "Connection flood increased connections ($BEFORE_COUNT → $AFTER_COUNT)"
else
    fail "Connection flood" "count didn't increase ($BEFORE_COUNT → $AFTER_COUNT)"
fi

# Reset
bash "$FAILURES_DIR/reset.sh" > /dev/null 2>&1
sleep 2
RESET_COUNT=$(podman exec cm-pg-primary psql -U crisismode -tAc \
    "SELECT count(*) FROM pg_stat_activity;" 2>/dev/null || echo "999")

if [ "$RESET_COUNT" -lt "$AFTER_COUNT" ]; then
    pass "Reset reduced connection count ($AFTER_COUNT → $RESET_COUNT)"
else
    fail "Connection reset" "count didn't decrease ($AFTER_COUNT → $RESET_COUNT)"
fi
echo ""

# --- Summary ---
TOTAL=$((PASS + FAIL))
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Results: $PASS/$TOTAL passed"

if [ "$FAIL" -gt 0 ]; then
    echo "  ❌ $FAIL test(s) failed"
    exit 1
else
    echo "  ✅ All failure injection tests passed"
    exit 0
fi
