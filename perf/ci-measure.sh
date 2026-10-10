#!/usr/bin/env bash
# Measures on a GitHub Actions runner with the same procedure as the local
# Docker runner (perf/measure.sh), so CI and local numbers are comparable in
# method. Run from the repository root of a full checkout (fetch-depth: 0).
#
# USAGE: perf/ci-measure.sh <corpus> <base-sha> <head-sha> <passes> <out-dir>
#   corpus  "upstream" (upstream's protobuf-bench corpus, unchanged) or
#           "realistic" (the production-shaped fixtures)
#
# The harness is <head-sha> (for a pull request: the merge commit), so both
# sides run the benchmark code under review. Every measured process is pinned
# to CPU 2 with taskset; the runner agent and the build are free to use the
# other vCPUs. Fails if taskset is missing rather than measuring unpinned.
set -euo pipefail

corpus=${1:?usage: perf/ci-measure.sh <corpus> <base-sha> <head-sha> <passes> <out-dir>}
base=${2:?} head=${3:?} passes=${4:?} out=${5:?}

command -v taskset > /dev/null || { echo "taskset not found; refusing to measure unpinned" >&2; exit 1; }

case $corpus in
  upstream) realistic=0 filters= ;;
  # The same case selection as the local realistic A/A runs, so their noise
  # figures apply.
  realistic) realistic=1 filters='/(simple|otel-traces|otel-metrics|otel-logs|k8s-pods|graphql-request|graphql-response|rpc-request|rpc-response|stress)$' ;;
  *) echo "unknown corpus: $corpus" >&2; exit 2 ;;
esac

mkdir -p "$out"
work=${RUNNER_TEMP:?}/bench-work-$corpus
mkdir -p "$work"

export BENCH_HARNESS=$head BENCH_BASE=$base BENCH_HEAD=$head
export BENCH_PASSES=$passes BENCH_COOLDOWN=30 BENCH_CPUS=2
export BENCH_REALISTIC=$realistic BENCH_FILTERS=$filters BENCH_PROFILES=
export BENCH_PIN="taskset -c 2" BENCH_WORK=$work BENCH_OUT=$out

META_RUNTIME="github-actions $(node --version) $(uname -m)" \
  META_DIGEST="${ImageOS:-unknown}-${ImageVersion:-unknown}" \
  perf/write-meta.sh "$out/meta.json"

bash perf/measure.sh
