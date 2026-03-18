#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# build-binary.sh — produce a standalone crisismode binary using esbuild + Node.js SEA.
#
# Usage:
#   ./scripts/build-binary.sh
#   OUTPUT_NAME=crisismode-linux-x64 ./scripts/build-binary.sh
#
# Requirements: Node.js >= 20, pnpm, esbuild + postject (devDependencies)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${REPO_ROOT}/dist"
BUNDLE="${DIST_DIR}/crisismode.bundle.cjs"
BLOB="${DIST_DIR}/sea-prep.blob"
OUTPUT_NAME="${OUTPUT_NAME:-crisismode}"
BINARY="${DIST_DIR}/${OUTPUT_NAME}"

# ── Preflight ──────────────────────────────────────────────────────────────────

echo "[build-binary] Checking prerequisites..."

NODE_VERSION=$(node --version)
NODE_MAJOR=$(echo "$NODE_VERSION" | sed 's/v\([0-9]*\).*/\1/')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "[build-binary] ERROR: Node.js >= 20 required for SEA. Found: ${NODE_VERSION}" >&2
  exit 1
fi
echo "[build-binary] Node: ${NODE_VERSION}"

PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
echo "[build-binary] Platform: ${PLATFORM}/${ARCH}"

# ── Step 1: Type check ────────────────────────────────────────────────────────

echo "[build-binary] Running type check..."
pnpm exec tsc --noEmit

# ── Step 2: Bundle with esbuild ───────────────────────────────────────────────

echo "[build-binary] Bundling with esbuild..."
mkdir -p "${DIST_DIR}"
node "${REPO_ROOT}/scripts/esbuild.config.mjs"
echo "[build-binary] Bundle: ${BUNDLE} ($(du -sh "${BUNDLE}" | cut -f1))"

# ── Step 3: Generate SEA blob ─────────────────────────────────────────────────

echo "[build-binary] Generating SEA blob..."
node --experimental-sea-config "${REPO_ROOT}/sea-config.json"
echo "[build-binary] Blob: ${BLOB} ($(du -sh "${BLOB}" | cut -f1))"

# ── Step 4: Copy node executable ──────────────────────────────────────────────

echo "[build-binary] Copying node executable..."
cp "$(which node)" "${BINARY}"

# ── Step 5: Inject SEA blob ───────────────────────────────────────────────────

echo "[build-binary] Injecting SEA blob with postject..."

POSTJECT="${REPO_ROOT}/node_modules/.bin/postject"
if [ ! -f "${POSTJECT}" ]; then
  echo "[build-binary] ERROR: postject not found. Run: pnpm install" >&2
  exit 1
fi

SEA_FUSE="NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"

if [ "${PLATFORM}" = "darwin" ]; then
  codesign --remove-signature "${BINARY}"
  "${POSTJECT}" "${BINARY}" NODE_SEA_BLOB "${BLOB}" \
    --sentinel-fuse "${SEA_FUSE}" \
    --macho-segment-name __NODE_SEA
  codesign -s - "${BINARY}"
elif [ "${PLATFORM}" = "linux" ]; then
  "${POSTJECT}" "${BINARY}" NODE_SEA_BLOB "${BLOB}" \
    --sentinel-fuse "${SEA_FUSE}"
else
  echo "[build-binary] WARNING: Unsupported platform '${PLATFORM}'. Attempting generic injection." >&2
  "${POSTJECT}" "${BINARY}" NODE_SEA_BLOB "${BLOB}" \
    --sentinel-fuse "${SEA_FUSE}"
fi

chmod +x "${BINARY}"

# ── Done ──────────────────────────────────────────────────────────────────────

BINARY_SIZE=$(du -sh "${BINARY}" | cut -f1)
echo ""
echo "[build-binary] Binary ready: ${BINARY} (${BINARY_SIZE})"
echo "[build-binary] Test with: ${BINARY} --version"
