#!/usr/bin/env bash
# Derives the per-case noise band from the summary.json of an A/A run (both
# sides the same library), for perf/report.sh AA_NOISE=<file>.
#
# USAGE: perf/aa-noise.sh <A/A result dir>/summary.json > aa-noise.json
#
# Output: {"<case>": {"band": <max |ln(B/A)|>, "sdLog": <sd of ln(B/A)>}}.
# The band of a case is the largest |ln(B/A)| any single pair of that case
# showed while nothing differed: an A/B effect within it is indistinguishable
# from what the machine produces on its own. Refuses input whose two sides
# were not built from the same library.
set -euo pipefail

summary=${1:?usage: perf/aa-noise.sh <summary.json>}
jq -e '.lib.identical == true' "$summary" > /dev/null || {
  echo "not an A/A run (built libraries differ or unknown): $summary" >&2
  exit 1
}
jq '.ab | map_values({band: .maxAbsLog, sdLog: .sdLog})' "$summary"
