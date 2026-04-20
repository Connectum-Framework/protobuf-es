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
# Additionally, this wrapper runs the matrix N times (default 3) and feeds
# the per-run JSON outputs through `scripts/median-results.ts` so the
# reported number is the median across runs. A 5-run local experiment on
# untouched main showed ~2x host-level spread on fast fixtures
# (SimpleMessage, GraphQLRequest > 100K ops/s) even with tinybench's own
# RME at < 0.2%. Taking the median makes single-outlier runs unable to
# drive false-positive regressions in the PR comment.
#
# This wrapper:
#   1. Logs the host profile (Node version, CPU, RAM) for trace records.
#   2. Does a throwaway warmup run of the matrix so JIT + ICs are warm on
#      the main benchmark functions.
#   3. Runs the real matrix N times with CI-sized time budgets.
#   4. Extracts the JSON payload from each run's stdout.
#   5. Computes the per-fixture median and writes it to the output file.
#
# Usage: benchmarks/scripts/run-matrix-ci.sh [output.json]
#        defaults to bench-results.json in the current working directory.
#
# Env overrides:
#   BENCH_MATRIX_RUNS           number of measurement runs (default 3)
#   BENCH_MATRIX_CI_TIME        per-run measurement ms (default 3000)
#   BENCH_MATRIX_CI_WARMUP      per-run warmup ms (default 1000)
#   BENCH_MATRIX_WARMUP_TIME    throwaway warmup pass ms (default 500/200)

set -euo pipefail

out="${1:-bench-results.json}"
runs="${BENCH_MATRIX_RUNS:-3}"
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
echo "::endgroup::"

# -------- 2. Warmup pass (discarded) --------
echo "::group::Warmup"
BENCH_MATRIX_TIME="${BENCH_MATRIX_WARMUP_TIME:-500}" \
BENCH_MATRIX_WARMUP="${BENCH_MATRIX_WARMUP_TIME:-200}" \
  npx tsx src/bench-matrix.ts >/dev/null 2>&1 || true
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
    npx tsx src/bench-matrix.ts | tee "${log}"
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
