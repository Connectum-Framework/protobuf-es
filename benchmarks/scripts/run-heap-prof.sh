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

# Thin wrapper around `node --heap-prof` + analyzer. Keeps the three
# concerns (profile directory, sampling interval, analyzer invocation)
# in one place so `npm run bench:heap-prof` is a one-liner for users.

set -euo pipefail

# Positional args are passed through to the driver (e.g. --fixture=otel100).
# Defaults match the README example: OTel 100-span workload, 1000 iterations.
FIXTURE="${FIXTURE:-otel100}"
ENCODER="${ENCODER:-toBinaryFast}"
ITERATIONS="${ITERATIONS:-1000}"

# Allow overriding from the CLI: `npm run bench:heap-prof -- --fixture=k8s20`
for arg in "$@"; do
  case "$arg" in
    --fixture=*) FIXTURE="${arg#--fixture=}" ;;
    --encoder=*) ENCODER="${arg#--encoder=}" ;;
    --iterations=*) ITERATIONS="${arg#--iterations=}" ;;
  esac
done

# V8's default heap sample interval is 512 KB; we shrink to 8 KB so short
# workloads surface enough samples to attribute. This matches the interval
# used in the OpenTelemetry and K8s client debugging guides.
INTERVAL="${HEAP_PROF_INTERVAL:-8192}"

# Write profiles to `.heap-profs/` inside the benchmarks dir. Kept out of
# the default gitignore so a CI run's artifacts are reviewable locally;
# the outer `.gitignore` lists this pattern.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BENCH_DIR="$(dirname "$SCRIPT_DIR")"
PROF_DIR="$BENCH_DIR/.heap-profs"
mkdir -p "$PROF_DIR"

# Clean prior profiles for this fixture so the analyzer picks "this run"
# deterministically (it selects the newest .heapprofile by mtime).
rm -f "$PROF_DIR"/*.heapprofile

echo "heap-prof: fixture=$FIXTURE encoder=$ENCODER iterations=$ITERATIONS interval=${INTERVAL}B"
echo "heap-prof: profile dir=$PROF_DIR"

node \
  --heap-prof \
  --heap-prof-dir="$PROF_DIR" \
  --heap-prof-interval="$INTERVAL" \
  --import tsx \
  "$BENCH_DIR/src/heap-prof-driver.ts" \
  "--fixture=$FIXTURE" \
  "--encoder=$ENCODER" \
  "--iterations=$ITERATIONS"

echo
echo "heap-prof: analyzing newest .heapprofile in $PROF_DIR"
echo

# `--top=20` matches the README example; override via TOP env if needed.
TOP="${TOP:-20}"
ANALYZER_ARGS=("--top=$TOP")
# Pass `--focus-encoder` through so callers can narrow the report to the
# protobuf encoder source tree: `npm run bench:heap-prof -- --focus-encoder`.
for arg in "$@"; do
  case "$arg" in
    --focus-encoder) ANALYZER_ARGS+=("--focus-encoder") ;;
    --filter=*) ANALYZER_ARGS+=("$arg") ;;
  esac
done

tsx "$BENCH_DIR/scripts/analyze-heap-prof.ts" "$PROF_DIR" "${ANALYZER_ARGS[@]}"
