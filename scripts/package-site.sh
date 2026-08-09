#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CrisisMode Contributors
#
# Package site/ as a zip for Cloudflare Pages direct upload.
#
# Pages resolves the site from the ZIP ROOT, so index.html must be a top-level
# entry — a zip containing `site/index.html` deploys to /site/index.html and the
# landing page 404s. This script therefore zips from inside site/ with relative
# paths, and asserts the root layout afterwards rather than trusting it.
#
# WHAT GOES IN: index.html, blog/, assets/. Nothing else — the zip is a publish
# artifact, not a copy of the working tree.
#
# WHAT IS KEPT OUT, and why each one matters:
#   - .DS_Store            Finder litter; site/.DS_Store exists today.
#   - *.zip                a previously built bundle must never nest inside the
#                          next one (site/index.html.zip is a stale committed
#                          artifact that would otherwise ride along).
#   - ._* / __MACOSX/      AppleDouble resource forks, which `zip -X` also
#                          suppresses by not recording Apple extra fields.
#
# REPRODUCIBILITY: the entry set and entry order are deterministic — the file
# list is built by find and LC_ALL=C sort, and passed to zip on stdin, so
# directory iteration order cannot leak in. The output is removed before each
# build so a rerun never appends to a stale archive. The archive is NOT
# byte-identical across runs: Info-ZIP records each entry's filesystem mtime and
# offers no way to override it, so re-recording an asset changes those bytes.
# Same inputs, same tree -> same bytes; touched inputs -> new bytes.
#
# Usage: bash scripts/package-site.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SITE_DIR="$REPO_ROOT/site"
OUT_DIR="$REPO_ROOT/output"
ZIP="$OUT_DIR/crisismode-site.zip"

for tool in zip unzip; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "error: '$tool' not found." >&2
    exit 1
  }
done

[ -f "$SITE_DIR/index.html" ] || {
  echo "error: $SITE_DIR/index.html is missing; nothing to publish." >&2
  exit 1
}

cd "$SITE_DIR"

# Every local asset the page references must be present. This is the exact
# failure the stale site/index.html.zip demonstrates: it carries index.html and
# blog/ but no assets/, so the deployed page loads with a dead player and a dead
# GIF. Catch that here instead of in production.
#
# Match any quoted assets//blog/ path, not just src=/href= attributes: the cast
# is loaded from script (AsciinemaPlayer.create('assets/demo.cast', ...)), and an
# attribute-only scan would happily ship a bundle with no recording in it.
missing=0
while IFS= read -r ref; do
  [ -z "$ref" ] && continue
  [ -e "$ref" ] || {
    echo "error: index.html references '$ref', which does not exist in site/" >&2
    missing=1
  }
done <<EOF
$(grep -oE "[\"'](assets|blog)/[^\"'?#]+" index.html \
    | sed -E "s/^[\"']//" \
    | LC_ALL=C sort -u)
EOF
[ "$missing" -eq 0 ] || exit 1

mkdir -p "$OUT_DIR"
rm -f "$ZIP"

# -X   omit extra file attributes (uid/gid, Apple extra fields / resource forks)
# -q   quiet; the listing below is the report
# -@   read the entry list from stdin, so ordering is ours and not the FS's
echo "==> packaging site/ -> $ZIP"
find index.html blog assets \
     -type f \
     ! -name '.DS_Store' \
     ! -name '*.zip' \
     ! -name '._*' \
     -print \
  | LC_ALL=C sort \
  | zip -q -X -@ "$ZIP" -x '.DS_Store' '*/.DS_Store' '*.zip' '._*' '*/._*' '__MACOSX/*'

# Assert the layout Pages needs rather than asking the reader to eyeball it.
unzip -Z1 "$ZIP" | grep -qx 'index.html' || {
  echo "error: index.html is not at the zip root; Pages would 404 on /." >&2
  exit 1
}
if unzip -Z1 "$ZIP" | grep -qE '(^|/)(\.DS_Store|\._|__MACOSX/)|\.zip$'; then
  echo "error: excluded files leaked into the archive:" >&2
  unzip -Z1 "$ZIP" | grep -E '(^|/)(\.DS_Store|\._|__MACOSX/)|\.zip$' >&2
  exit 1
fi

ZIP_BYTES="$(wc -c < "$ZIP" | tr -d ' ')"

echo
unzip -l "$ZIP"
echo
echo "done: $ZIP"
echo "      $((ZIP_BYTES / 1024)) KiB ($ZIP_BYTES bytes), $(unzip -Z1 "$ZIP" | wc -l | tr -d ' ') entries"
echo "      upload this file to Cloudflare Pages (Create project -> Direct Upload)."
