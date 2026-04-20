#!/usr/bin/env bash
# Copyright 2021-2026 Buf Technologies, Inc.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
# run-matrix-ci.sh — stable wrapper around `tsx src/bench-matrix.ts`.
#
# Intent
# ------
# bench-matrix.ts's default knobs (1000 ms measurement, 200 ms warmup) are
# tuned for local development — fast feedback, noisy numbers. CI needs the
# opposite: longer warmup so the V8 tier-up settles, longer measurement so
# RME shrinks, and a clean stdout stream that contains only the JSON
# payload so compare-results.ts can read it with fs.readFileSync.
#
# Additionally, this wrapper runs the matrix N times (default 5) and feeds
# the per-run JSON outputs through `scripts/median-results.ts` so the
# reported number is the median across runs.
#
# Variance control — the root-cause investigation
# (analysis/benchmark-variance-root-cause.md) measured a +76% run-to-run
# spread on `ExportTrace::toBinary` unpinned on a heterogeneous P/E-core
# host. Pinning the process to CPU 0 (`taskset -c 0`) collapsed the same
# workload to +7% spread — a 10x reduction. Frame proportions in the CPU
# profiles were identical across slow and fast runs, confirming the
# variance was pure environmental (scheduler migration + intel_pstate
# frequency scaling), not algorithmic. Pinning is therefore the primary
# noise reduction; median-of-5 is the secondary filter.
#
# This wrapper:
#   1. Logs the host profile (Node version, CPU, RAM) for trace records.
#   2. Detects `taskset` and pins each invocation to CPU 0 when available.
#   3. Does a throwaway warmup run of the matrix so JIT + ICs are warm on
#      the main benchmark functions.
#   4. Runs the real matrix N times (default 5) with CI-sized time budgets.
#   5. Extracts the JSON payload from each run's stdout.
#   6. Computes the per-fixture median and writes it to the output file.
#
# Usage: benchmarks/scripts/run-matrix-ci.sh [output.json]
#        defaults to bench-results.json in the current working directory.
#
# Env overrides:
#   BENCH_MATRIX_RUNS           number of measurement runs (default 5)
#   BENCH_MATRIX_CI_TIME        per-run measurement ms (default 3000)
#   BENCH_MATRIX_CI_WARMUP      per-run warmup ms (default 1000)
#   BENCH_MATRIX_WARMUP_TIME    throwaway warmup pass ms (default 500/200)

set -euo pipefail

out="${1:-bench-results.json}"
runs="${BENCH_MATRIX_RUNS:-5}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BENCH_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${BENCH_DIR}"

runs_dir=".bench-runs"
rm -rf "${runs_dir}"
mkdir -p "${runs_dir}"

# -------- 1. Host profile (trace only, never fails the job) --------
echo "::group::Host profile"
echo "node:        $(node --version)"
echo "platform:    $(uname -srm)"
if command -v nproc >/dev/null 2>&1; then
  echo "cpus:        $(nproc)"
fi
if [[ -r /proc/meminfo ]]; then
  echo "mem:         $(awk '/MemTotal/ {printf "%.1f GB", $2/1024/1024}' /proc/meminfo)"
fi
if command -v lscpu >/dev/null 2>&1; then
  lscpu | grep -E "Model name|CPU MHz|CPU max MHz" || true
fi
echo "runs:        ${runs}"

# -------- 1b. CPU pinning detection --------
# Pin each measurement invocation to a single CPU to eliminate scheduler
# migration jitter (primary source of >50% run-to-run variance on hosts
# with heterogeneous P/E-core topologies). CPU 0 is a P-core on Intel
# Core Ultra and the first available core on the GitHub ubuntu-latest
# runner fleet.
if command -v taskset >/dev/null 2>&1; then
  pin_prefix=(taskset -c 0)
  echo "cpu pinning: enabled (taskset -c 0)"
else
  pin_prefix=()
  echo "cpu pinning: DISABLED (taskset not available) — results will be noisy"
fi
echo "::endgroup::"

# -------- 2. Warmup pass (discarded) --------
echo "::group::Warmup"
BENCH_MATRIX_TIME="${BENCH_MATRIX_WARMUP_TIME:-500}" \
BENCH_MATRIX_WARMUP="${BENCH_MATRIX_WARMUP_TIME:-200}" \
  "${pin_prefix[@]}" npx tsx src/bench-matrix.ts >/dev/null 2>&1 || true
echo "Warmup complete."
echo "::endgroup::"

# -------- 3. Measurement passes --------
extract_json() {
  # $1 = stdout log, $2 = output json path
  node -e '
    const fs = require("node:fs");
    const src = process.argv[1];
    const dst = process.argv[2];
    const lines = fs.readFileSync(src, "utf8").split("\n");
    let payload = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const ln = lines[i].trim();
      if (ln.startsWith("{") && ln.endsWith("}")) {
        try { payload = JSON.parse(ln); break; } catch { /* keep looking */ }
      }
    }
    if (!payload) {
      console.error(`run-matrix-ci: could not locate JSON payload in ${src}.`);
      process.exit(1);
    }
    fs.writeFileSync(dst, JSON.stringify(payload, null, 2) + "\n");
    console.error(`run-matrix-ci: wrote ${payload.results.length} rows to ${dst}.`);
  ' "$1" "$2"
}

for i in $(seq 1 "${runs}"); do
  echo "::group::Measurement run ${i}/${runs}"
  log=".bench-stdout-${i}.log"
  BENCH_MATRIX_TIME="${BENCH_MATRIX_CI_TIME:-3000}" \
  BENCH_MATRIX_WARMUP="${BENCH_MATRIX_CI_WARMUP:-1000}" \
    "${pin_prefix[@]}" npx tsx src/bench-matrix.ts | tee "${log}"
  extract_json "${log}" "${runs_dir}/run-${i}.json"
  rm -f "${log}"
  echo "::endgroup::"
done

# -------- 4. Compute median across runs --------
echo "::group::Compute median across ${runs} run(s)"
npx tsx scripts/median-results.ts "${runs_dir}"/run-*.json > "${out}"
echo "run-matrix-ci: wrote median payload to ${out}."
echo "::endgroup::"

rm -rf "${runs_dir}"
