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
# This wrapper:
#   1. Logs the host profile (Node version, CPU, RAM) for trace records.
#   2. Does a throwaway warmup run of the matrix so JIT + ICs are warm on
#      the main benchmark functions.
#   3. Runs the real matrix with CI-sized time budgets.
#   4. Extracts the last JSON object from stdout and writes it to the
#      caller-specified output file.
#
# Usage: benchmarks/scripts/run-matrix-ci.sh [output.json]
#        defaults to bench-results.json in the current working directory.

set -euo pipefail

out="${1:-bench-results.json}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BENCH_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${BENCH_DIR}"

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
echo "::endgroup::"

# -------- 2. Warmup pass (discarded) --------
echo "::group::Warmup"
BENCH_MATRIX_TIME="${BENCH_MATRIX_WARMUP_TIME:-500}" \
BENCH_MATRIX_WARMUP="${BENCH_MATRIX_WARMUP_TIME:-200}" \
  npx tsx src/bench-matrix.ts >/dev/null 2>&1 || true
echo "Warmup complete."
echo "::endgroup::"

# -------- 3. Measurement pass --------
echo "::group::Measurement"
BENCH_MATRIX_TIME="${BENCH_MATRIX_CI_TIME:-3000}" \
BENCH_MATRIX_WARMUP="${BENCH_MATRIX_CI_WARMUP:-1000}" \
  npx tsx src/bench-matrix.ts | tee ".bench-stdout.log"
echo "::endgroup::"

# -------- 4. Extract JSON payload --------
# bench-matrix.ts prints human-readable tables and then one line of
# `=== Matrix JSON ===` followed by a single-line JSON object. Grab the
# last line that starts with '{' as the payload.
node -e '
const fs = require("node:fs");
const out = process.argv[1];
const lines = fs.readFileSync(".bench-stdout.log", "utf8").split("\n");
let payload = null;
for (let i = lines.length - 1; i >= 0; i--) {
  const ln = lines[i].trim();
  if (ln.startsWith("{") && ln.endsWith("}")) {
    try { payload = JSON.parse(ln); break; } catch { /* keep looking */ }
  }
}
if (!payload) {
  console.error("run-matrix-ci: could not locate JSON payload in bench-matrix output.");
  process.exit(1);
}
fs.writeFileSync(out, JSON.stringify(payload, null, 2) + "\n");
console.error(`run-matrix-ci: wrote ${payload.results.length} result rows to ${out}.`);
' "$out"

rm -f .bench-stdout.log
