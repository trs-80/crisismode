#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# build-binary.sh — produce standalone crisismode binaries using bun compile.
#
# Usage:
#   ./scripts/build-binary.sh                          # build for current platform
#   ./scripts/build-binary.sh --all                    # build all 4 targets
#   TARGET=bun-linux-x64 ./scripts/build-binary.sh     # build specific target
#
# Requirements: bun, pnpm (for typecheck)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${REPO_ROOT}/dist"

# Read version from package.json
VERSION=$(node -p "require('./package.json').version")

PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
  aarch64) ARCH="arm64" ;;
  x86_64)  ARCH="x64" ;;
esac

ALL_TARGETS=(
  "bun-linux-x64"
  "bun-linux-arm64"
  "bun-darwin-x64"
  "bun-darwin-arm64"
)

# ── Preflight ──────────────────────────────────────────────────────────────────

echo "[build-binary] Checking prerequisites..."

if ! command -v bun &> /dev/null; then
  echo "[build-binary] ERROR: bun is required. Install: curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi

echo "[build-binary] bun: $(bun --version)"
echo "[build-binary] Version: ${VERSION}"
echo "[build-binary] Host: ${PLATFORM}/${ARCH}"

# ── Step 1: Type check ────────────────────────────────────────────────────────

echo "[build-binary] Running type check..."
pnpm typecheck

# ── Step 2: Build binaries ────────────────────────────────────────────────────

mkdir -p "${DIST_DIR}"

build_target() {
  local target="$1"
  # Extract platform-arch from bun target name (bun-linux-x64 → linux-x64)
  local suffix="${target#bun-}"
  local outfile="${DIST_DIR}/crisismode-${suffix}"

  echo "[build-binary] Building ${target} → crisismode-${suffix}..."

  bun build "${REPO_ROOT}/src/cli/index.ts" \
    --compile \
    --target="${target}" \
    --define "process.env.__CRISISMODE_VERSION=\"${VERSION}\"" \
    --outfile "${outfile}"

  chmod +x "${outfile}"

  local size
  size=$(du -sh "${outfile}" | cut -f1)
  echo "[build-binary] ✓ crisismode-${suffix} (${size})"
}

if [ "${1:-}" = "--all" ]; then
  # Build all 4 targets
  for target in "${ALL_TARGETS[@]}"; do
    build_target "$target"
  done
elif [ -n "${TARGET:-}" ]; then
  # Build specific target
  build_target "${TARGET}"
else
  # Build for current platform
  build_target "bun-${PLATFORM}-${ARCH}"
fi

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo "[build-binary] Done. Test with: dist/crisismode-${PLATFORM}-${ARCH} --version"
