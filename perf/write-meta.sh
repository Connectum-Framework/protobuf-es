#!/usr/bin/env bash
# Writes meta.json for one measurement: what was measured (revisions, corpus,
# passes) and where (runtime, host CPU and its frequency policy). Shared by
# perf/run.sh and perf/ci-measure.sh so that local and CI results describe
# themselves the same way; perf/report.sh reads it.
#
# USAGE: perf/write-meta.sh <out-file>
# Inputs (environment): BENCH_BASE, BENCH_HEAD (may be empty), BENCH_HARNESS,
# BENCH_PASSES, BENCH_COOLDOWN, BENCH_CPUS, BENCH_REALISTIC, BENCH_FILTERS,
# BENCH_PROFILES, META_RUNTIME (image or runner description), META_DIGEST,
# META_WAITED (0/1), META_ISOLATED (0/1). Missing sysfs entries (as on some
# virtual machines) are recorded as "n/a".
set -euo pipefail

file=${1:?usage: perf/write-meta.sh <out-file>}
cpu=${BENCH_CPUS%% *}
cpufreq=/sys/devices/system/cpu/cpu$cpu/cpufreq
read_or_na() { cat "$1" 2>/dev/null || echo n/a; }

jq -n \
  --arg base "$BENCH_BASE" --arg head "${BENCH_HEAD:-}" --arg harness "$BENCH_HARNESS" \
  --arg runtime "${META_RUNTIME:-unknown}" --arg digest "${META_DIGEST:-unknown}" \
  --arg cpus "$BENCH_CPUS" --argjson passes "$BENCH_PASSES" \
  --argjson cooldown "$BENCH_COOLDOWN" --argjson wait "${META_WAITED:-0}" \
  --argjson realistic "${BENCH_REALISTIC:-0}" --argjson isolated "${META_ISOLATED:-0}" \
  --arg filters "${BENCH_FILTERS:-}" --arg profiles "${BENCH_PROFILES:-}" \
  --arg model "$(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2- | sed 's/^ //')" \
  --arg kernel "$(uname -r)" \
  --arg governor "$(read_or_na "$cpufreq/scaling_governor")" \
  --arg epp "$(read_or_na "$cpufreq/energy_performance_preference")" \
  --arg no_turbo "$(read_or_na /sys/devices/system/cpu/intel_pstate/no_turbo)" \
  --arg fmin "$(read_or_na "$cpufreq/scaling_min_freq")" \
  --arg fmax "$(read_or_na "$cpufreq/scaling_max_freq")" \
  '{base: $base, head: (if $head == "" then null else $head end),
    harness: $harness, image: $runtime, imageDigest: $digest, cpus: $cpus,
    passes: $passes, warmupPairs: 1, cooldown: $cooldown, waitedForIdle: ($wait == 1),
    isolated: ($isolated == 1),
    realistic: ($realistic == 1), filters: $filters, profiles: $profiles,
    host: {cpu: $model, kernel: $kernel, governor: $governor, epp: $epp,
           noTurbo: $no_turbo, scalingMinKhz: $fmin, scalingMaxKhz: $fmax}}' > "$file"
