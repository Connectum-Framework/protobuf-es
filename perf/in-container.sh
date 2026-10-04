#!/usr/bin/env bash
# Runs inside the container started by perf/run.sh; not meant to be called
# directly. Inputs come from the BENCH_* environment variables.
set -euo pipefail

git config --global --add safe.directory '*'

git archive "$BENCH_SHA" | tar -x -C /work
cd /work

npm ci --no-audit --no-fund --loglevel=error > /out/npm-ci.log 2>&1
npx turbo run build \
  -F @bufbuild/protobuf -F @bufbuild/protoc-gen-es \
  --output-logs=errors-only > /out/build.log 2>&1

cd packages/protobuf-bench
# Generated code is regenerated from the committed protos and must match the
# committed copy; a mismatch means the measured tree is not what was reviewed.
npm run generate > /out/generate.log 2>&1
git archive "$BENCH_SHA" packages/protobuf-bench/src/gen | tar -x -C /tmp
if ! diff -r /tmp/packages/protobuf-bench/src/gen src/gen > /out/gen-drift.diff; then
  echo "generated code differs from the committed copy, see gen-drift.diff" >&2
  cp -r src/gen /out/gen
  exit 1
fi
npx tsc --noEmit > /out/typecheck.log 2>&1

read -r -a filters <<< "${BENCH_FILTERS:-}"
for i in $(seq 1 "$BENCH_RUNS"); do
  npx tsx src/bench.ts --json "${filters[@]}" > "/out/run-$i.json"
done

# Median over runs, per case. The median, not the mean: a single pass hit by
# scheduler noise must not move the reported figure.
jq -s '
  (.[0].node) as $node
  | [.[].rows[]] | group_by(.name)
  | map({
      name: .[0].name,
      error: (map(.error) | map(select(. != null)) | first),
      opsPerSec: (map(.opsPerSec) | map(select(. != null)) | sort
                  | if length == 0 then null else .[(length - 1) / 2 | floor] end),
      opsPerSecMin: (map(.opsPerSec) | map(select(. != null)) | min),
      opsPerSecMax: (map(.opsPerSec) | map(select(. != null)) | max),
      runs: length
    })
  | {sha: env.BENCH_SHA, node: $node, rows: .}
' /out/run-*.json > /out/summary.json

read -r -a profiles <<< "${BENCH_PROFILES:-}"
for name in "${profiles[@]}"; do
  safe=${name//\//_}
  node --cpu-prof --cpu-prof-dir "/out/cpuprof/$safe" \
    --import tsx src/profile.ts "$name" 10000 >> /out/profile.log
done
