#!/usr/bin/env bash
# example-goss-system: Validate system state using Goss YAML assertions
#
# Demonstrates the Goss output format for CrisisMode.
# Goss plugins receive no stdin. They run `goss validate --format json`
# and CrisisMode parses the structured JSON output.
#
# Requires: goss (https://github.com/goss-org/goss)
#   Install: curl -fsSL https://goss.rocks/install | sh
#   Or download from: https://github.com/goss-org/goss/releases
#
# If goss is not installed, this check emits a synthetic JSON response
# so the plugin still passes contract validation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if ! command -v goss >/dev/null 2>&1; then
  # Goss not installed — emit a valid goss-format JSON with a skip result
  cat <<'FALLBACK'
{"results":[{"successful":true,"skipped":true,"resource-id":"goss-binary","resource-type":"Command","property":"installed","title":"","meta":null,"result":2,"err":null,"matcher-result":{"actual":false,"expected":[true],"message":"goss not installed"},"start-time":"1970-01-01T00:00:00Z","end-time":"1970-01-01T00:00:00Z","duration":0,"summary-line":"Command: goss-binary: installed: skipped (goss not installed)","summary-line-compact":"Command: goss-binary: installed: skipped"}],"summary":{"test-count":1,"failed-count":0,"skipped-count":1,"total-duration":0,"summary-line":"Count: 1, Failed: 0, Skipped: 1, Duration: 0.000s"}}
FALLBACK
  exit 0
fi

exec goss -g "$SCRIPT_DIR/goss.yaml" validate --format json
