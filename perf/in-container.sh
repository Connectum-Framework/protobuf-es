#!/usr/bin/env bash
# Runs inside the container started by perf/run.sh; not meant to be called
# directly. Inputs come from the BENCH_* environment variables.
set -euo pipefail

git config --global --add safe.directory '*'

# /work is a host directory (perf/run.sh refuses to start unless it is empty);
# the build trees are removed on any exit so the next run finds it empty.
trap 'rm -rf /work/a /work/b' EXIT

# The CPUs this container may actually run on, as the kernel applies them
# (a cgroup namespace shows the container's own cgroup at the root).
cat /sys/fs/cgroup/cpuset.cpus.effective > /out/container-cpuset.txt
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
  # The harness lockfile and the benchmark's exact dependency pin describe the
  # harness's packages/protobuf manifest. A library revision with another
  # manifest (version, dependencies) would be installed against a lockfile
  # that does not describe it, so it is refused rather than measured.
  if ! diff <(git -C "$src_repo" show "$BENCH_HARNESS:packages/protobuf/package.json") \
            <(git -C "$src_repo" show "$lib:packages/protobuf/package.json") > /dev/null; then
    echo "packages/protobuf/package.json of $lib differs from the harness" >&2
    exit 1
  fi
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

# Records which library the benchmark of one side actually resolves: where
# node_modules/@bufbuild/protobuf points, its version, and a digest of the
# built output. An A/A must show identical digests, an A/B different ones.
identify() {
  local dir=$1 side=$2
  (
    cd "$dir"
    echo "link=$(readlink -f node_modules/@bufbuild/protobuf)"
    echo "version=$(node -p 'require("./packages/protobuf/package.json").version')"
    echo "dist_sha256=$(cd packages/protobuf/dist && find . -type f | LC_ALL=C sort \
      | xargs sha256sum | sha256sum | cut -d' ' -f1)"
  ) > "/out/$side/lib.txt"
  # CPU profiles point at lines of the built JavaScript, and the build tree is
  # deleted on exit; keeping the output makes those lines readable later.
  cp -r "$dir/packages/protobuf/dist" "/out/$side/dist"
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
  local side=$1 name=$2
  snapshot "before $side/$name"
  (
    cd "/work/$side/packages/protobuf-bench"
    node --import tsx src/bench.ts --json "${filters[@]}"
  ) > "/out/$side/$name.json" 2> "/out/$side/$name.err"
  snapshot "after $side/$name"
}

# Runs one pair, A and B in random order (just A without --head).
pair() {
  local name=$1 order
  if [[ ${#sides[@]} -eq 2 && $((RANDOM % 2)) -eq 1 ]]; then
    order=(b a)
  else
    order=("${sides[@]}")
  fi
  echo "$name ${order[*]}" >> /out/order.log
  for side in "${order[@]}"; do
    pass "$side" "$name"
  done
}

read -r -a filters <<< "${BENCH_FILTERS:-}"
read -r -a profiles <<< "${BENCH_PROFILES:-}"

sides=(a)
[[ -n ${BENCH_HEAD:-} ]] && sides+=(b)

for side in "${sides[@]}"; do
  lib=$BENCH_BASE
  if [[ $side == b ]]; then lib=$BENCH_HEAD; fi
  mkdir -p "/out/$side" "/work/$side/.committed"
  assemble "/work/$side" "$lib"
  build "/work/$side" "/out/$side/build.log"
  identify "/work/$side" "$side"
done

# Builds load this CPU for minutes; the rest lets thermals settle. On a
# 15 W part it also refills the turbo budget, which the first pass then burns
# down, so that first pair runs under a different frequency than the rest; it
# is run as a warm-up and its files are not named run-*, so the report never
# reads them.
sleep "$BENCH_COOLDOWN"
pair warmup

# Zero-padded names: the report pairs a/run-007 with b/run-007 by file name.
for k in $(seq 1 "$BENCH_PASSES"); do
  pair "run-$(printf '%03d' "$k")"
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
