#!/usr/bin/env bash
# Aggregates the passes of one perf/run.sh result directory into summary.json
# and report.md. Safe to re-run on an existing directory.
#
# Per side and case: the median over passes of the per-pass median latency
# (p50) expressed as ops/s, plus min/max across passes. With two sides, each
# pass k of A is paired with pass k of B (they ran back to back), and the
# report gives the median of the B/A ratios, how many pairs B won, and an
# exact two-sided sign-test p-value. The sign test assumes nothing about the
# shape of the noise, which here is heavy-tailed.
set -euo pipefail

out=${1:?usage: perf/report.sh <result-dir>}

jq -n '
  def median: sort | if length == 0 then null
    else (length) as $n | if $n % 2 == 1 then .[($n - 1) / 2]
    else (.[$n / 2 - 1] + .[$n / 2]) / 2 end end;
  def choose($n; $k): reduce range(0; $k) as $i (1; . * ($n - $i) / ($i + 1));
  def sign_p($wins; $n): if $n == 0 then null else
    ([$wins, $n - $wins] | min) as $m
    | ([range(0; $m + 1) | choose($n; .)] | add) as $tail
    | ([1, 2 * $tail / pow(2; $n)] | min) end;

  def side($runs): $runs
    | [.[] | .rows[]] | group_by(.name)
    | map({
        key: .[0].name,
        value: {
          error: (map(.error) | map(select(. != null)) | first),
          p50: (map(.p50OpsPerSec) | map(select(. != null)) | median),
          p50Min: (map(.p50OpsPerSec) | map(select(. != null)) | min),
          p50Max: (map(.p50OpsPerSec) | map(select(. != null)) | max),
          mean: (map(.opsPerSec) | map(select(. != null)) | median),
          passes: length
        }
      }) | from_entries;

  $meta[0] as $m
  | side($a) as $A
  | (if ($b | length) > 0 then side($b) else null end) as $B
  | {
      meta: $m,
      a: $A,
      b: $B,
      ab: (if $B == null then null else
        [range(0; [$a, $b] | map(length) | min)] as $ks
        | [$A | keys[] | select($B[.] != null)]
        | map(. as $name | {
            key: $name,
            value: (
              [$ks[] as $k
                | ($a[$k].rows[] | select(.name == $name) | .p50OpsPerSec) as $x
                | ($b[$k].rows[] | select(.name == $name) | .p50OpsPerSec) as $y
                | select($x != null and $y != null) | $y / $x] as $r
              | ($r | map(select(. > 1)) | length) as $w
              | {ratio: ($r | median), wins: $w, pairs: ($r | length),
                 p: sign_p($w; $r | length)})
          }) | from_entries
        end)
    }
' --slurpfile meta "$out/meta.json" \
  --slurpfile a <(cat "$out"/a/run-*.json) \
  --slurpfile b <(cat "$out"/b/run-*.json 2>/dev/null || true) \
  > "$out/summary.json"

jq -r '
  def r0: if . == null then "–" else (. * 1 | round | tostring) end;
  def pct: if . == null then "–" else ((. - 1) * 1000 | round / 10 | tostring) + " %" end;
  def p3: if . == null then "–" else (. * 1000 | round / 1000 | tostring) end;
  "# perf result", "",
  "- base: `\(.meta.base)`",
  "- head: `\(.meta.head // "–")`",
  "- harness: `\(.meta.harness)`, image `\(.meta.image)`, CPUs \(.meta.cpus), passes \(.meta.passes), realistic \(.meta.realistic)",
  "",
  if .ab == null then
    "| case | p50 ops/s (median) | min | max | mean ops/s |",
    "|---|---:|---:|---:|---:|",
    (.a | to_entries[] | "| \(.key) | \(.value.p50 | r0) | \(.value.p50Min | r0) | \(.value.p50Max | r0) | \(.value.mean | r0) |")
  else
    "| case | A p50 ops/s | B p50 ops/s | B/A (median of pairs) | B wins | sign-test p |",
    "|---|---:|---:|---:|---:|---:|",
    (. as $s | .ab | to_entries[]
      | "| \(.key) | \($s.a[.key].p50 | r0) | \($s.b[.key].p50 | r0) | \(.value.ratio | pct) | \(.value.wins)/\(.value.pairs) | \(.value.p | p3) |")
  end
' "$out/summary.json" > "$out/report.md"

cat "$out/report.md"
