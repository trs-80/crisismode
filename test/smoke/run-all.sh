#!/bin/bash
set -euo pipefail

# Smoke tests for the CrisisMode test environment.
# Validates that all services are running, replication works,
# alerts fire correctly, and the mock hub responds.
#
# Usage:
#   ./test/smoke/run-all.sh           # Run against podman environment
#   ./test/smoke/run-all.sh local     # Run against local services

MODE="${1:-podman}"
PASS=0
FAIL=0

pass() { echo "  ✅ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ❌ $1: $2"; FAIL=$((FAIL + 1)); }

run_test() {
    local name="$1"
    local cmd="$2"
    if eval "$cmd" > /dev/null 2>&1; then
        pass "$name"
    else
        fail "$name" "command failed"
    fi
}

# Helper: run psql on primary or replica
# Uses podman exec in podman mode, direct psql in local mode
psql_primary() {
    if [ "$MODE" = "podman" ]; then
        podman exec cm-pg-primary psql -U crisismode -d crisismode "$@"
    else
        PGPASSWORD=crisismode psql -h localhost -p 5432 -U crisismode -d crisismode "$@"
    fi
}
psql_replica() {
    if [ "$MODE" = "podman" ]; then
        podman exec cm-pg-replica psql -U crisismode -d crisismode "$@"
    else
        PGPASSWORD=crisismode psql -h localhost -p 5433 -U crisismode -d crisismode "$@"
    fi
}

echo "🧪 CrisisMode Smoke Tests ($MODE mode)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# --- Service Health ---
echo "📡 Service Health:"
run_test "PostgreSQL primary responds" \
    "psql_primary -c 'SELECT 1'"
run_test "PostgreSQL replica responds" \
    "psql_replica -c 'SELECT 1'"
run_test "Prometheus is ready" \
    "curl -sf http://localhost:9090/-/ready"
run_test "AlertManager is ready" \
    "curl -sf http://localhost:9093/-/ready"
run_test "PG Exporter serves metrics" \
    "curl -sf http://localhost:9187/metrics | grep -q pg_up"
run_test "Mock Hub API is healthy" \
    "curl -sf http://localhost:8080/health"
echo ""

# --- PostgreSQL Replication ---
echo "🔄 Replication:"

# Check replica is in recovery mode
if psql_replica -tAc "SELECT pg_is_in_recovery();" 2>/dev/null | grep -q "t"; then
    pass "Replica is in recovery mode"
else
    fail "Replica recovery mode" "not in recovery"
fi

# Check primary has active replication connection
if psql_primary -tAc "SELECT count(*) FROM pg_stat_replication WHERE state = 'streaming';" 2>/dev/null | grep -qE "^[1-9]"; then
    pass "Primary has streaming replication"
else
    fail "Streaming replication" "no active replication connections"
fi

# Check replication slot exists
if psql_primary -tAc "SELECT count(*) FROM pg_replication_slots WHERE slot_name = 'replica_1';" 2>/dev/null | grep -q "1"; then
    pass "Replication slot 'replica_1' exists"
else
    fail "Replication slot" "replica_1 not found"
fi

# Check test data replicated
PRIMARY_COUNT=$(psql_primary -tAc "SELECT count(*) FROM orders;" 2>/dev/null || echo "0")
REPLICA_COUNT=$(psql_replica -tAc "SELECT count(*) FROM orders;" 2>/dev/null || echo "0")
if [ "$PRIMARY_COUNT" -gt 0 ] && [ "$REPLICA_COUNT" -gt 0 ]; then
    pass "Test data present (primary: $PRIMARY_COUNT, replica: $REPLICA_COUNT rows)"
else
    fail "Test data" "primary=$PRIMARY_COUNT, replica=$REPLICA_COUNT"
fi
echo ""

# --- Prometheus Metrics ---
echo "📊 Metrics Pipeline:"

# Check Prometheus has PG targets
if curl -sf "http://localhost:9090/api/v1/targets" | grep -q '"health":"up"'; then
    pass "Prometheus scraping PG exporter (target up)"
else
    fail "Prometheus targets" "no healthy targets"
fi

# Check alert rules loaded
if curl -sf "http://localhost:9090/api/v1/rules" | grep -q "PostgresReplicationLagCritical"; then
    pass "Alert rule 'PostgresReplicationLagCritical' loaded"
else
    fail "Alert rules" "PostgresReplicationLagCritical not found"
fi
echo ""

# --- Mock Hub API ---
echo "🏢 Mock Hub API:"

# Test bootstrap endpoint
if curl -sf -X POST http://localhost:8080/api/v1/spoke/bootstrap \
    -H "Content-Type: application/json" \
    -d '{"token":"test-token","environment_id":"env-001"}' | grep -q "spoke_id"; then
    pass "Bootstrap endpoint returns spoke identity"
else
    fail "Bootstrap endpoint" "unexpected response"
fi

# Test heartbeat
if curl -sf -X POST http://localhost:8080/api/v1/spoke/heartbeat \
    -H "Content-Type: application/json" \
    -d '{"spoke_id":"spoke-test"}' | grep -q "ack"; then
    pass "Heartbeat endpoint responds"
else
    fail "Heartbeat endpoint" "unexpected response"
fi

# Test policies
if curl -sf http://localhost:8080/api/v1/policies | grep -q "approval_required_above"; then
    pass "Policies endpoint returns cached policies"
else
    fail "Policies endpoint" "unexpected response"
fi

# Test forensics submission
if curl -sf -X POST http://localhost:8080/api/v1/forensics \
    -H "Content-Type: application/json" \
    -d '{"execution_id":"test-001","summary":{"outcome":"success"}}' | grep -q "ack"; then
    pass "Forensics submission accepted"
else
    fail "Forensics submission" "unexpected response"
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
    echo "  ✅ All tests passed"
    exit 0
fi
