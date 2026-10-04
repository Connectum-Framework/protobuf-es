#!/usr/bin/env bash
# Runs inside the container started by perf/run.sh; not meant to be called
# directly. Inputs come from the BENCH_* environment variables.
set -euo pipefail

git config --global --add safe.directory '*'
# The measured repository is the mounted worktree, the working directory at
# start. Every git call names it explicitly, because each build tree gets its
# own empty .git below.
src_repo=$PWD

# Assembles one build tree: the harness revision with packages/protobuf taken
# from the library revision. Both sides of a comparison therefore run the very
# same benchmark code and differ only in the library under test.
assemble() {
  local dir=$1 lib=$2
  mkdir -p "$dir"
  git -C "$src_repo" archive "$BENCH_HARNESS" | tar -x -C "$dir"
  rm -rf "$dir/packages/protobuf"
  git -C "$src_repo" archive "$lib" packages/protobuf | tar -x -C "$dir"
  # The license-header step of `npm run generate` locates the repository root
  # with `git rev-parse --show-toplevel`; an archive extract has no .git.
  git -C "$dir" init -q
}

build() {
  local dir=$1 log=$2
  (
    cd "$dir"
    npm ci --no-audit --no-fund --loglevel=error
    npx turbo run build \
      -F @bufbuild/protobuf -F @bufbuild/protoc-gen-es --output-logs=errors-only
    cd packages/protobuf-bench
    npm run generate
    # Generated code must match the committed copy; a mismatch means the
    # measured tree is not the one that was reviewed.
    git -C "$src_repo" archive "$BENCH_HARNESS" packages/protobuf-bench/src/gen \
      | tar -x -C "$dir/.committed"
    diff -r "$dir/.committed/packages/protobuf-bench/src/gen" src/gen
    npx tsc --noEmit
  ) > "$log" 2>&1
}

# One line per sample of the benchmark CPU and its hyperthread sibling, so a
# pass disturbed by another process or a frequency drop can be recognised
# afterwards.
snapshot() {
  local tag=$1 cpu freq
  for cpu in $BENCH_CPUS; do
    freq=$(cat "/sys/devices/system/cpu/cpu$cpu/cpufreq/scaling_cur_freq" 2>/dev/null || echo n/a)
    echo "$(date +%s.%N) $tag cpu$cpu freq_khz=$freq $(grep "^cpu$cpu " /proc/stat)"
  done >> /out/env.log
}

pass() {
  local side=$1 k=$2
  snapshot "before $side/$k"
  (
    cd "/work/$side/packages/protobuf-bench"
    node --import tsx src/bench.ts --json "${filters[@]}"
  ) > "/out/$side/run-$k.json"
  snapshot "after $side/$k"
}

read -r -a filters <<< "${BENCH_FILTERS:-}"
read -r -a profiles <<< "${BENCH_PROFILES:-}"

sides=(a)
[[ -n ${BENCH_HEAD:-} ]] && sides+=(b)

mkdir -p /out/a
assemble /work/a "$BENCH_BASE"
mkdir -p /work/a/.committed
build /work/a /out/a/build.log
if [[ -n ${BENCH_HEAD:-} ]]; then
  mkdir -p /out/b /work/b/.committed
  assemble /work/b "$BENCH_HEAD"
  build /work/b /out/b/build.log
fi

# Builds load this CPU for minutes; let frequency and thermals settle so the
# first pass does not start under a different budget than the later ones.
sleep "$BENCH_COOLDOWN"

for k in $(seq 1 "$BENCH_PASSES"); do
  if [[ ${#sides[@]} -eq 2 && $((RANDOM % 2)) -eq 1 ]]; then
    order=(b a)
  else
    order=("${sides[@]}")
  fi
  echo "$k ${order[*]}" >> /out/order.log
  for side in "${order[@]}"; do
    pass "$side" "$k"
  done
done

for name in "${profiles[@]}"; do
  safe=${name//\//_}
  for side in "${sides[@]}"; do
    (
      cd "/work/$side/packages/protobuf-bench"
      node --cpu-prof --cpu-prof-dir "/out/$side/cpuprof/$safe" \
        --import tsx src/profile.ts "$name" 10000
    ) >> "/out/$side/profile.log"
  done
done
