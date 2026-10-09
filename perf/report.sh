#!/usr/bin/env bash
# Aggregates the passes of one perf/run.sh result directory into summary.json
# and report.md. Safe to re-run on an existing directory.
#
# Per side and case: the median over passes of the per-pass median latency
# (p50) expressed as ops/s, plus min/max across passes. With two sides, pass
# a/run-NNN is paired with b/run-NNN by file name (they ran back to back), and
# the report gives the median of the B/A ratios, how many pairs B won, and an
# exact two-sided sign-test p-value. The sign test assumes nothing about the
# shape of the noise, which here is heavy-tailed. Ties (ratio exactly 1) carry
# no sign and are left out of the test, as the standard sign test does.
set -euo pipefail

out=${1:?usage: perf/report.sh <result-dir>}

# Pairing by name is only sound when both sides hold the same complete set of
# passes; a missing or empty file (a crashed pass) is an error, not a gap.
passes_of() {
  local side=$1 f
  for f in "$out/$side"/run-*.json; do
    [[ -e $f ]] || continue
    if [[ ! -s $f ]]; then
      echo "empty pass file (crashed pass?): $f" >&2
      exit 1
    fi
    basename "$f" .json
  done
}
a_passes=$(passes_of a)
b_passes=
if [[ -d $out/b ]]; then
  b_passes=$(passes_of b)
  if [[ $a_passes != "$b_passes" ]]; then
    echo "sides hold different sets of passes; refusing to pair them" >&2
    diff <(echo "$a_passes") <(echo "$b_passes") >&2 || true
    exit 1
  fi
fi

# {"run-001": [rows...], ...} for one side.
by_pass() {
  jq -n '[inputs | {key: (input_filename | split("/") | last | rtrimstr(".json")), value: .rows}] | from_entries' \
    "$out/$1"/run-*.json
}
by_pass a > "$out/a/passes.json"
[[ -n $b_passes ]] && by_pass b > "$out/b/passes.json"

lib_of() { [[ -f $out/$1/lib.txt ]] && grep '^dist_sha256=' "$out/$1/lib.txt" | cut -d= -f2 || echo unknown; }

# Per pass: the share of 250 ms frequency samples of the pinned CPU that fell
# below 98 % of the pinned frequency, and the mean frequency. A pinned minimum
# is a request, not a guarantee: on this 15 W part, load on the other cores
# eats the package power budget and drags the reserved core below it.
# Only a numeric, pinned (min == max) frequency qualifies; a virtual machine
# without cpufreq reports "n/a" for both.
pinned_khz=$(jq -r '.host | if .scalingMinKhz == .scalingMaxKhz and (.scalingMinKhz | test("^[0-9]+$")) then .scalingMinKhz else "" end' "$out/meta.json")
pinned_cpu=$(jq -r '.cpus | split(" ")[0]' "$out/meta.json")
: > "$out/pass-freq.tsv"
if [[ -n $pinned_khz && -f $out/freq.log && -f $out/env.log ]]; then
  awk -v cpu="cpu$pinned_cpu" -v floor="$((pinned_khz * 98 / 100))" '
    NR == FNR {
      if ($4 == cpu) { if ($2 == "before") start[$3] = $1; else end_[$3] = $1 }
      next
    }
    {
      for (i = 2; i <= NF; i++) if (index($i, cpu "=") == 1) { v = substr($i, length(cpu) + 2) }
      for (p in start) if ($1 >= start[p] && $1 <= end_[p]) { n[p]++; sum[p] += v; if (v < floor) low[p]++ }
    }
    END { for (p in n) printf "%s\t%.2f\t%.0f\n", p, 100 * low[p] / n[p], sum[p] / n[p] / 1000 }
  ' "$out/env.log" "$out/freq.log" | LC_ALL=C sort > "$out/pass-freq.tsv"
fi

# With MAX_LOW_FREQ_PCT set, a pair is dropped when either of its passes spent
# more than that share of its time below the pinned frequency; both passes go,
# since a pair is only meaningful when both ran under the same conditions.
rejected='[]'
# A filtered aggregate is written next to the unfiltered one, never over it.
summary_name=summary.json report_name=report.md
if [[ -n ${MAX_LOW_FREQ_PCT:-} ]]; then
  summary_name=summary-freq${MAX_LOW_FREQ_PCT}.json report_name=report-freq${MAX_LOW_FREQ_PCT}.md
  if [[ ! -s $out/pass-freq.tsv ]]; then
    echo "MAX_LOW_FREQ_PCT needs a pinned frequency and freq.log/env.log" >&2
    exit 1
  fi
  rejected=$(awk -v max="$MAX_LOW_FREQ_PCT" '$2 > max { split($1, s, "/"); print s[2] }' "$out/pass-freq.tsv" \
    | { grep '^run-' || true; } | LC_ALL=C sort -u | jq -R . | jq -s .)
fi

jq -n '
  def median: sort | if length == 0 then null
    else (length) as $n | if $n % 2 == 1 then .[($n - 1) / 2]
    else (.[$n / 2 - 1] + .[$n / 2]) / 2 end end;
  def choose($n; $k): reduce range(0; $k) as $i (1; . * ($n - $i) / ($i + 1));
  def sign_p($wins; $n): if $n == 0 then null else
    ([$wins, $n - $wins] | min) as $m
    | ([range(0; $m + 1) | choose($n; .)] | add) as $tail
    | ([1, 2 * $tail / pow(2; $n)] | min) end;

  def side($passes): [$passes[][]] | group_by(.name)
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

  def p50($rows; $name): [$rows[] | select(.name == $name) | .p50OpsPerSec][0];

  # Sample standard deviation of ln(ratio): the pair noise, which decides the
  # smallest effect a given number of pairs can resolve.
  def sdlog: map(log) | length as $n | if $n < 2 then null else
    (add / $n) as $mu | (map((. - $mu) * (. - $mu)) | add / ($n - 1) | sqrt) end;

  $meta[0] as $m
  | ($pa[0] | with_entries(select(.key as $k | $rejected | index($k) | not))) as $a
  | (($pb[0] // null) | if . == null then null
      else with_entries(select(.key as $k | $rejected | index($k) | not)) end) as $b
  | side($a) as $A
  | (if $b == null then null else side($b) end) as $B
  # Signal threshold: the practical floor of 2 % plus the systematic bias
  # bound of the rig from an A/A run (perf/aa-noise.sh); without an A/A file
  # the bias is taken as zero and the report says so.
  | (1.02 | log) as $thetaMin
  | ($aa[0] // null) as $noise
  | (($noise.bias.bound) // 0) as $biasBound
  | ($thetaMin + $biasBound) as $theta
  | ([ (if $noise != null and ($noise.hostCpu != $m.host.cpu or $noise.cpus != $m.cpus
            or $noise.image != $m.image)
        then "the A/A calibration was measured on a different rig (host CPU, CPU set or runtime)"
        else empty end),
       (if $biasBound > $thetaMin / 2
        then "the rig bias bound (\($biasBound * 1000 | round / 10) %) is comparable to the practical floor; the A/A run does not certify this rig"
        else empty end) ]) as $warnings
  | {
      meta: $m,
      rejectedPairs: $rejected,
      maxLowFreqPct: (if $maxLow == "" then null else ($maxLow | tonumber) end),
      lib: {a: $libA, b: (if $b == null then null else $libB end),
            identical: (if $b == null then null else $libA == $libB end)},
      a: $A,
      b: $B,
      ab: (if $B == null then null else
        # Per case: the pair ratios r = B/A, their median, the sign test,
        # and the robust spread of ln r (1.4826 * MAD), which unlike the
        # standard deviation is not inflated by the heavy tails a loaded
        # host produces.
        ([$A | keys[] | select($B[.] != null)]
         | map(. as $name
             | [$a | keys[] as $k
                 | p50($a[$k]; $name) as $x | p50($b[$k]; $name) as $y
                 | select($x != null and $y != null) | $y / $x] as $r
             | ($r | map(select(. > 1)) | length) as $w
             | ($r | map(select(. != 1)) | length) as $n
             | ($r | map(log)) as $l
             | ($l | median) as $lm
             | {name: $name, ratio: ($r | median), wins: $w, pairs: ($r | length),
                ties: (($r | length) - $n), p: sign_p($w; $n), sdLog: ($r | sdlog),
                lnMedian: $lm,
                sigmaRobust: (if $lm == null then null
                              else 1.4826 * ($l | map(. - $lm | fabs) | median) end)})) as $cases
        # Benjamini-Hochberg over the cases of this report: with some fifty
        # cases, raw p < 0.05 would flag a few by chance in every run.
        | ([$cases[] | select(.p != null)] | sort_by(.p)) as $sorted
        | ($sorted | length) as $m
        | (reduce range($m - 1; -1; -1) as $i ({next: 1, adj: {}};
             ([.next, ($m * $sorted[$i].p / ($i + 1)), 1] | min) as $v
             | .adj[$sorted[$i].name] = $v | .next = $v) | .adj) as $padj
        | ($cases | map({key: .name, value: (del(.name) + {pAdj: $padj[.name],
            # A signal needs all three: the corrected sign test rejects "no
            # difference", the effect is at least the practical floor (2 %),
            # and it also exceeds the bias the A/A run found in the rig.
            signal: (if $padj[.name] != null and $padj[.name] <= 0.05 and .ratio != null
                       and ((.ratio | log | fabs) >= $theta)
                     then (if .ratio > 1 then "IMPROVEMENT" else "REGRESSION" end)
                     else null end)})}) | from_entries)
        end),
      theta: $theta,
      thetaMin: $thetaMin,
      biasBound: $biasBound,
      aaNoise: (if $aaSource == "" then null else $aaSource end),
      warnings: $warnings
    }
' --slurpfile meta "$out/meta.json" \
  --slurpfile pa "$out/a/passes.json" \
  --slurpfile pb <([[ -n $b_passes ]] && cat "$out/b/passes.json" || true) \
  --arg libA "$(lib_of a)" --arg libB "$(lib_of b)" \
  --argjson rejected "$rejected" --arg maxLow "${MAX_LOW_FREQ_PCT:-}" \
  --slurpfile aa <([[ -n ${AA_NOISE:-} ]] && cat "$AA_NOISE" || true) \
  --arg aaSource "${AA_NOISE:-}" \
  > "$out/$summary_name"
jq -r '
  def r0: if . == null then "–" else (. * 1 | round | tostring) end;
  def pct: if . == null then "–" else ((. - 1) * 1000 | round / 10 | tostring) + " %" end;
  def p3: if . == null then "–" else (. * 1000 | round / 1000 | tostring) end;
  "# perf result", "",
  "- base: `\(.meta.base)`",
  "- head: `\(.meta.head // "–")`",
  "- harness: `\(.meta.harness)`, image `\(.meta.image)`, CPUs \(.meta.cpus), passes \(.meta.passes) (+\(.meta.warmupPairs // 0) warm-up), cooldown \(.meta.cooldown // "?") s, realistic \(.meta.realistic)",
  "- built library dist sha256: A `\(.lib.a)`" + (if .lib.b == null then "" else ", B `\(.lib.b)` — " + (if .lib.identical then "identical (A/A)" else "different" end) end),
  (if .maxLowFreqPct == null then "- all pairs used"
   else "- pairs dropped (a pass > \(.maxLowFreqPct) % of its time below the pinned frequency): \(.rejectedPairs | length) of \(.meta.passes)" end),
  "",
  if .ab == null then
    "| case | p50 ops/s (median) | min | max | mean ops/s |",
    "|---|---:|---:|---:|---:|",
    (.a | to_entries[] | "| \(.key) | \(.value.p50 | r0) | \(.value.p50Min | r0) | \(.value.p50Max | r0) | \(.value.mean | r0) |")
  else
    "- signal: Benjamini-Hochberg-corrected sign test p ≤ 0.05 and |B/A − 1| ≥ \(((.theta | exp) - 1) * 1000 | round / 10) % (2 % floor + \(.biasBound * 1000 | round / 10) % rig bias bound" + (if .aaNoise == null then ", NOT calibrated: no A/A file given)" else " from `\(.aaNoise)`)" end),
    (.warnings[] | "- ⚠ \(.)"),
    "",
    "| case | A p50 ops/s | B p50 ops/s | B/A (median of pairs) | pair noise (robust σ of ln B/A) | B wins / non-tied pairs | sign-test p | BH p | signal |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---|",
    (. as $s | .ab | to_entries[]
      | "| \(.key) | \($s.a[.key].p50 | r0) | \($s.b[.key].p50 | r0) | \(.value.ratio | pct) | \(if .value.sigmaRobust == null then "–" else (.value.sigmaRobust * 1000 | round / 10 | tostring) + " %" end) | \(.value.wins)/\(.value.pairs - .value.ties) | \(.value.p | p3) | \(.value.pAdj | p3) | \(.value.signal // "–") |")
  end
' "$out/$summary_name" > "$out/$report_name"

cat "$out/$report_name"
