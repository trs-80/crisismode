#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CrisisMode Contributors
#
# Record `crisismode demo` as an asciinema cast (+ GIF fallback) for the website.
#
# The demo blocks on stdin at the human_approval gate, so the run is driven by
# expect: it waits for the prompt and types the decision with human-like timing.
#
# THIS RECORDING MAKES A LIVE ANTHROPIC API CALL. Phase 5 runs the real AI
# diagnosis, so ANTHROPIC_API_KEY must be exported in the environment or the
# demo silently falls back to rule-based heuristics and the capture is wrong.
# Consequences of that being live:
#   - The cast is NOT byte-reproducible. The model's root cause, findings and
#     confidence differ on every run; so does the wall-clock latency (measured
#     28-40s for claude-sonnet-5 against this prompt).
#   - The result is pace-adjusted afterwards by scripts/pace-cast.mjs, which
#     re-times every line for readability and clamps any single idle gap to 4s.
#     Output bytes are never altered; only timing is synthesized.
#   - Do not set CRISISMODE_AI_MODEL here. The demo must show the
#     out-of-the-box path, which is whatever ai-model.ts defaults to.
# After recording, confirm the cast really shows model reasoning rather than the
# fallback — the rule-based path prints a fixed 92%-confidence three-finding
# diagnosis, so a cast that matches it byte-for-byte across runs is a red flag.
#
# Usage: bash scripts/record-demo.sh [approve|skip|reject]

set -euo pipefail

DECISION="${1:-approve}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$REPO_ROOT/site/assets"
CAST="$OUT_DIR/demo.cast"
# The unpaced capture is a build artifact, not a site asset — keep it out of
# site/assets so it is not published. /output/ is gitignored.
RAW_CAST="$REPO_ROOT/output/demo.raw.cast"
GIF="$OUT_DIR/demo.gif"

# 100 cols keeps the demo's 72-char rules and plan table intact while limiting
# how often the long prose lines (risk/what descriptions) wrap.
COLS=100
ROWS=30

for tool in asciinema agg expect; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "error: '$tool' not found. Install with: brew install asciinema agg" >&2
    exit 1
  }
done

[ -f "$REPO_ROOT/dist/cli/index.js" ] || {
  echo "error: dist/cli/index.js missing. Run 'pnpm run build' first." >&2
  exit 1
}

# Fail fast rather than ship a cast that quietly shows the rule-based fallback:
# a missing key is indistinguishable from a working recording until someone
# reads the diagnosis text closely.
[ -n "${ANTHROPIC_API_KEY:-}" ] || {
  echo "error: ANTHROPIC_API_KEY is not set. This recording requires a live AI" >&2
  echo "       diagnosis; without the key the demo falls back to rule-based" >&2
  echo "       heuristics and the capture would misrepresent the product." >&2
  exit 1
}

mkdir -p "$OUT_DIR" "$(dirname "$RAW_CAST")"

DRIVER="$(mktemp -t crisismode-demo-driver).exp"
trap 'rm -f "$DRIVER"' EXIT

cat > "$DRIVER" <<EXPECT_SCRIPT
#!/usr/bin/env expect -f
# Drives the demo through its interactive approval gate.
#
# 180s still has room after the move to live AI: the diagnosis call is bounded
# at 60s by the framework's own deadline (src/framework/ai-diagnosis.ts) and the
# rest of the run to the approval prompt takes ~15s, so the worst case is ~75s.
set timeout 180
# Human-like typing: avg 90ms/char, 20ms stddev, 0.2 min, 0.4s at word end.
set send_human {0.09 0.02 1 0.20 0.40}

# A beat before the first keystroke so the recording does not open mid-command.
sleep 1.2
spawn -noecho node "$REPO_ROOT/dist/cli/index.js" demo
expect {
  -re {Enter your decision \(approve/skip/reject\): } {
    # Let the viewer read the approval panel before answering.
    sleep 2.5
    send -h -- "$DECISION"
    sleep 0.6
    send -- "\r"
  }
  timeout { puts stderr "\nrecord-demo: timed out waiting for approval prompt"; exit 1 }
  eof     { puts stderr "\nrecord-demo: demo exited before approval prompt"; exit 1 }
}
expect eof
# Hold on the final frame so the summary is readable at the end of the loop.
sleep 2.5
EXPECT_SCRIPT

chmod +x "$DRIVER"

echo "==> recording ${COLS}x${ROWS} -> $RAW_CAST"
rm -f "$RAW_CAST"

# ANTHROPIC_API_KEY is inherited deliberately: Phase 5 must reach the real API.
env TERM=xterm-256color \
    FORCE_COLOR=3 \
    COLUMNS="$COLS" \
    LINES="$ROWS" \
  asciinema rec "$RAW_CAST" \
    --window-size "${COLS}x${ROWS}" \
    --overwrite \
    --return \
    --title "crisismode demo — PostgreSQL replication lag cascade recovery" \
    --command "$DRIVER"

# The demo emits each phase in one instantaneous write, so re-time the cast to
# reading speed. Timing only — pace-cast verifies output bytes are unchanged.
echo "==> pacing -> $CAST"
node "$REPO_ROOT/scripts/pace-cast.mjs" "$RAW_CAST" "$CAST"

# Theme matched to the site palette in site/index.html (--bg-primary, --amber,
# --red, --green, --cyan) so the GIF sits in the page without clashing.
THEME="0a0a0b,e4e4e7,27272a,ef4444,22c55e,f59e0b,3b82f6,ec4899,06b6d4,e4e4e7,52525b,f87171,4ade80,fbbf24,60a5fa,f472b6,22d3ee,fafafa"

# The GIF is a fallback/social teaser, not the whole story: a full-length 100x30
# GIF is >7MB at any usable quality. Cover the opening arc (alert -> live AI
# diagnosis) and let the player carry the rest.
#
# The cut point is found in the cast rather than fixed at a percentage: the live
# AI diagnosis varies in length run to run, so a percentage lands somewhere
# different every time (36% used to reach the plan table; with a wordier model
# response it stops short of it). Anchor on the Phase 6 heading instead, which
# is exactly where the diagnosis verdict ends.
#
# Phase 6 and not Phase 7: the repo refuses to commit a file over 1MB, and
# rendering through the plan table costs 1.3MB even at font-size 10 / 4fps,
# which is past legible. Ending on the diagnosis keeps the part that matters —
# the model's own root-cause paragraph, which is the whole reason this is
# recorded live — inside the budget.
CUT="$(node -e '
const fs = require("node:fs");
const lines = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").slice(1);
let t = 0;
let cut = null;
for (const line of lines) {
  if (!line.trim()) continue;
  const [interval, code, data] = JSON.parse(line);
  t += interval;
  if (code === "o" && String(data).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").includes("Phase 6:")) {
    // A beat past the heading so the transition is visible in the last frame.
    cut = t + 0.8;
    break;
  }
}
if (cut === null) {
  console.error("record-demo: could not find the Phase 6 heading; cannot place the GIF cut");
  process.exit(1);
}
process.stdout.write(cut.toFixed(2));
' "$CAST")"

# 2fps, not 6: the window has to span a real 8-20s AI call, and the diagnosis
# text is expensive to render (6fps costs 2.9MB, 3fps still 1.4MB). At 2fps the
# GIF lands near 900KB, inside the repo's 1MB commit ceiling. The demo reveals
# text in bursts and the cast is already re-timed for reading speed, so the
# frame rate costs smoothness rather than content.
echo "==> rendering GIF teaser (0..${CUT}s) -> $GIF"
agg -q \
  --select "0..$CUT" \
  --fps-cap 2 \
  --font-size 14 \
  --line-height 1.4 \
  --theme "$THEME" \
  "$CAST" "$GIF"

# The teaser is embedded in the landing page, so guard the budget out loud
# rather than discovering a 5MB GIF in production.
# 1MB is not a soft budget: the pre-commit hook rejects files above it, so a
# regression here blocks the commit rather than quietly shipping a heavy page.
GIF_BYTES="$(wc -c < "$GIF" | tr -d ' ')"
if [ "$GIF_BYTES" -gt 1048576 ]; then
  echo "error: GIF is $((GIF_BYTES / 1024))KiB, over the 1MB pre-commit ceiling." >&2
  echo "       Lower --fps-cap or --font-size, or move the cut anchor earlier." >&2
  exit 1
fi

echo
echo "done:"
ls -lh "$CAST" "$GIF" | awk '{print "  " $5 "\t" $9}'
echo "  (raw unpaced capture kept at $RAW_CAST)"
