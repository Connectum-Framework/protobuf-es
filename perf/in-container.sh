#!/usr/bin/env bash
# Runs inside the container started by perf/run.sh; not meant to be called
# directly. Inputs come from the BENCH_* environment variables; the
# measurement itself is perf/measure.sh, shared with the CI workflows.
set -euo pipefail

git config --global --add safe.directory '*'

# /work is a host directory (perf/run.sh refuses to start unless it is empty);
# the build trees are removed on any exit so the next run finds it empty.
trap 'rm -rf /work/a /work/b' EXIT

# The CPUs this container may actually run on, as the kernel applies them
# (a cgroup namespace shows the container's own cgroup at the root).
cat /sys/fs/cgroup/cpuset.cpus.effective > /out/container-cpuset.txt

# The container is already confined to the benchmark CPU by its cpuset, so no
# per-process pinning is needed.
BENCH_WORK=/work BENCH_OUT=/out BENCH_PIN= bash "$PWD/perf/measure.sh"
