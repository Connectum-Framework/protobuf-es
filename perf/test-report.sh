#!/usr/bin/env bash
# Tests perf/report.sh and perf/aa-noise.sh on a real A/A result directory:
#   1. the A/A itself must produce no signal (no false positives);
#   2. the same data with every B-side p50 scaled by 1.05 must flag
#      IMPROVEMENT and nothing else;
#   3. scaled by 0.95, REGRESSION and nothing else.
# A uniform 5 % shift on top of real pair noise is the size of effect the
# protocol is meant to detect, so (2) and (3) also check its power.
#
# USAGE: perf/test-report.sh <A/A result dir>
# Works on copies under .tmp/perf/test-report/; the input is not modified.
set -euo pipefail

src=${1:?usage: perf/test-report.sh <A/A result dir>}
repo_root=$(git rev-parse --show-toplevel)
dst=$repo_root/.tmp/perf/test-report
if [[ -e $dst ]]; then
  echo "remove the previous test output first: $dst" >&2
  exit 1
fi
mkdir -p "$dst"

# Copies the pass files and metadata of an A/A, scaling the B side's p50.
variant() {
  local name=$1 factor=$2 f
  mkdir -p "$dst/$name/a" "$dst/$name/b"
  cp "$src/meta.json" "$dst/$name/"
  cp "$src/a/lib.txt" "$dst/$name/a/"
  cp "$src/b/lib.txt" "$dst/$name/b/"
  for f in "$src"/a/run-*.json; do cp "$f" "$dst/$name/a/"; done
  for f in "$src"/b/run-*.json; do
    jq --argjson k "$factor" '.rows |= map(if .p50OpsPerSec == null then . else .p50OpsPerSec *= $k end)' \
      "$f" > "$dst/$name/b/$(basename "$f")"
  done
}

variant aa 1
variant up5 1.05
variant down5 0.95

"$repo_root/perf/report.sh" "$dst/aa" > /dev/null
"$repo_root/perf/aa-noise.sh" "$dst/aa/summary.json" > "$dst/aa-noise.json"

fail=0
check() {
  local name=$1 want=$2 summary counts
  AA_NOISE="$dst/aa-noise.json" "$repo_root/perf/report.sh" "$dst/$name" > /dev/null
  summary=$dst/$name/summary.json
  counts=$(jq -r '[.ab[] | .signal // "none"] | group_by(.) | map("\(.[0])=\(length)") | join(" ")' "$summary")
  echo "$name: cases=$(jq '.ab | length' "$summary") $counts"
  case $want in
    none) jq -e '[.ab[] | select(.signal != null)] | length == 0' "$summary" > /dev/null || fail=1 ;;
    *) jq -e --arg w "$want" '([.ab[] | select(.signal != null and .signal != $w)] | length == 0)
                              and ([.ab[] | select(.signal == $w)] | length > 0)' "$summary" > /dev/null || fail=1 ;;
  esac
}

jq -r '"bias bound: \(.bias.bound * 1000 | round / 10) % (mean ln median \(.bias.meanLnMedian * 10000 | round / 100) %, \(.cases) cases, \(.pairs) pairs)"' "$dst/aa-noise.json"
check aa none
check up5 IMPROVEMENT
check down5 REGRESSION

if [[ $fail -eq 0 ]]; then echo "PASS"; else echo "FAIL"; fi
exit "$fail"
