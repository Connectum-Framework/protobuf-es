#!/usr/bin/env bash
# Measures one committed revision of this repository with the
# packages/protobuf-bench corpus, inside Docker, pinned to one CPU.
#
# Only committed state is measured (the tree is taken with `git archive`), so
# a result always maps to a SHA and two revisions are compared on identical
# terms. See perf/README.md for usage and the output layout.
set -euo pipefail

usage() {
  cat <<'EOF'
USAGE: perf/run.sh <git-ref> [options]

  --runs N        full bench passes; the report keeps the median (default 5)
  --filter RE     only cases matching RE (passed to bench.ts, may repeat)
  --profile CASE  also record a CPU profile of CASE (may repeat)
  --cpu N         CPU the container is pinned to (default 2)
  --image IMG     Node.js image (default node:24.21.0)
  --label NAME    result directory name (default: short SHA)
EOF
}

[[ $# -ge 1 ]] || { usage >&2; exit 2; }
[[ $1 == -h || $1 == --help ]] && { usage; exit 0; }

ref=$1; shift
runs=5
cpu=2
image=node:24.21.0
label=
filters=()
profiles=()
while [[ $# -gt 0 ]]; do
  case $1 in
    --runs) runs=$2; shift 2 ;;
    --filter) filters+=("$2"); shift 2 ;;
    --profile) profiles+=("$2"); shift 2 ;;
    --cpu) cpu=$2; shift 2 ;;
    --image) image=$2; shift 2 ;;
    --label) label=$2; shift 2 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

repo_root=$(git rev-parse --show-toplevel)
# A worktree's .git is a pointer into the main repository's object store, so
# the common dir has to be mounted as well for `git archive` to work inside.
git_common=$(cd "$repo_root" && cd "$(git rev-parse --git-common-dir)" && pwd)
sha=$(git -C "$repo_root" rev-parse --verify "$ref^{commit}")
label=${label:-${sha:0:10}}
out="$repo_root/.tmp/perf/$label"
cache="$repo_root/.tmp/perf/npm-cache"
mkdir -p "$out" "$cache"

docker run --rm \
  --cpuset-cpus="$cpu" \
  --user "$(id -u):$(id -g)" \
  -e HOME=/home/bench \
  -e npm_config_cache=/npm-cache \
  -e BENCH_SHA="$sha" \
  -e BENCH_RUNS="$runs" \
  -e BENCH_FILTERS="${filters[*]:-}" \
  -e BENCH_PROFILES="${profiles[*]:-}" \
  --tmpfs /home/bench:exec \
  --tmpfs /work:exec,size=4g \
  -v "$repo_root:$repo_root:ro" \
  -v "$git_common:$git_common:ro" \
  -v "$cache:/npm-cache" \
  -v "$out:/out" \
  -w "$repo_root" \
  "$image" \
  bash "$repo_root/perf/in-container.sh"

echo "results: $out"
