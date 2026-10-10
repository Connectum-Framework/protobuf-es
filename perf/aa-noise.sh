#!/usr/bin/env bash
# Derives the rig calibration from the summary.json of an A/A run (both sides
# the same library), for perf/report.sh AA_NOISE=<file>.
#
# USAGE: perf/aa-noise.sh <A/A result dir>/summary.json > aa-noise.json
#
# The one number the signal rule uses is bias.bound: an upper bound on a
# systematic difference between the two sides of this rig, from how far the
# per-case median ratios of an A/A run sit from 1 on average,
#   bound = |mean_c ln median(r_c)| + 2 * sd_c / sqrt(cases).
# The pair-to-pair noise itself needs no band: the sign test accounts for it.
# Per-case robust spreads are kept for reference (they tell which cases a run
# of n pairs can resolve). The summary must come from the current report.sh
# (it carries lnMedian and sigmaRobust); too small an A/A is refused because
# its bound would mean nothing.
set -euo pipefail

summary=${1:?usage: perf/aa-noise.sh <summary.json>}
jq -e '.lib.identical == true' "$summary" > /dev/null || {
  echo "not an A/A run (built libraries differ or unknown): $summary" >&2
  exit 1
}
jq -e '[.ab[] | .lnMedian, .sigmaRobust] | all(. != null)' "$summary" > /dev/null || {
  echo "summary lacks lnMedian/sigmaRobust; re-run perf/report.sh on that directory" >&2
  exit 1
}
jq -e '(.ab | length) >= 20 and ([.ab[].pairs] | min) >= 20' "$summary" > /dev/null || {
  echo "A/A too small for a bias bound (need >= 20 cases and >= 20 pairs): $summary" >&2
  exit 1
}

jq --arg source "$summary" '
  [.ab[] | .lnMedian] as $l
  | ($l | length) as $k
  | ($l | add / $k) as $mean
  | ($l | map((. - $mean) * (. - $mean)) | add / ($k - 1) | sqrt) as $sd
  | {
      source: $source,
      harness: .meta.harness, image: .meta.image, cpus: .meta.cpus,
      hostCpu: .meta.host.cpu,
      cases: $k, pairs: ([.ab[].pairs] | min),
      bias: {
        meanLnMedian: $mean,
        sdLnMedianAcrossCases: $sd,
        bound: (($mean | fabs) + 2 * $sd / ($k | sqrt)),
        maxAbsLnMedian: ($l | map(fabs) | max),
        negativeCases: ($l | map(select(. < 0)) | length)
      },
      perCase: (.ab | map_values({lnMedian, sigmaRobust, sdLog}))
    }
' "$summary"
