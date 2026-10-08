#!/usr/bin/env bash
# Prints the functions with the most self time in .cpuprofile files.
#
# USAGE: perf/profile-top.sh [-n N] <file.cpuprofile | directory>...
#
# Self time = samples whose top frame is the function (V8 records a sample
# hit on the innermost frame). Frames are grouped by function name, file and
# line, so two closures from the same source line are one row: that is the
# granularity at which a code change can act. Shares are of all samples,
# including (program), (garbage collector) and (idle).
set -euo pipefail

top=15
if [[ ${1:-} == -n ]]; then top=$2; shift 2; fi
[[ $# -ge 1 ]] || { sed -n '4p' "$0" | sed 's/^# //' >&2; exit 2; }

for arg in "$@"; do
  if [[ -d $arg ]]; then
    find "$arg" -name '*.cpuprofile' | LC_ALL=C sort
  else
    echo "$arg"
  fi
done | while read -r file; do
  echo "## $file"
  jq -r --argjson top "$top" '
    (.nodes | map(.hitCount) | add) as $total
    | .nodes
    | group_by([.callFrame.functionName, .callFrame.url, .callFrame.lineNumber])
    | map({
        hits: (map(.hitCount) | add),
        name: (.[0].callFrame.functionName | if . == "" then "(anonymous)" else . end),
        where: (.[0].callFrame | if .url == "" then "" else
                 "\(.url | split("/") | last):\(.lineNumber + 1)" end)
      })
    | sort_by(-.hits) | .[:$top][]
    | "\(.hits * 1000 / $total | round / 10)%\t\(.hits)\t\(.name)\t\(.where)"
  ' "$file" | column -t -s $'\t'
done
