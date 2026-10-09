#!/usr/bin/env bash
# Runs one of upstream's generating turbo tasks on a committed revision inside
# Docker and writes the files it changed as a patch, so that no dependency is
# installed on the host. Apply with `git apply <patch>`. These are the tasks
# that upstream's CI follows with gh-diffcheck, i.e. whose output must be
# committed:
#   format          Biome formatting
#   bundle-size     packages/bundle-size/README.md and chart.svg
#   license-header  license headers
#
# USAGE: perf/turbo-patch.sh <git-ref> <task> <patch-file> [--image IMAGE]
set -euo pipefail

usage="usage: perf/turbo-patch.sh <git-ref> <task> <patch-file> [--image IMAGE]"
ref=${1:?$usage}
task=${2:?$usage}
patch=${3:?$usage}
image=node:24-trixie
if [[ ${4:-} == --image ]]; then image=${5:?$usage}; fi
case $task in
  format|bundle-size|license-header) ;;
  *) echo "unsupported task: $task" >&2; echo "$usage" >&2; exit 2 ;;
esac

repo_root=$(git rev-parse --show-toplevel)
git_common=$(cd "$repo_root" && cd "$(git rev-parse --git-common-dir)" && pwd)
sha=$(git -C "$repo_root" rev-parse --verify "$ref^{commit}")
cache="$repo_root/.tmp/perf/npm-cache"
work="$HOME/.cache/agent-work/protobuf-es/turbo-patch-work"
mkdir -p "$cache" "$work"
if [[ -n $(ls -A "$work") ]]; then
  echo "work directory not empty (another run, or a crashed one): $work" >&2
  exit 1
fi
patch_abs=$(realpath -m "$patch")
mkdir -p "$(dirname "$patch_abs")"

docker run --rm \
  --user "$(id -u):$(id -g)" \
  -e HOME=/home/tp -e npm_config_cache=/npm-cache \
  --tmpfs /home/tp:exec \
  -v "$repo_root:$repo_root:ro" -v "$git_common:$git_common:ro" \
  -v "$cache:/npm-cache" -v "$work:/work" \
  -v "$(dirname "$patch_abs"):/out" \
  -w "$repo_root" "$image" bash -c '
    set -euo pipefail
    trap "rm -rf /work/src" EXIT
    git config --global --add safe.directory "*"
    mkdir -p /work/src
    git archive "$0" | tar -x -C /work/src
    cd /work/src
    git init -q && git add -A
    git -c user.name=tp -c user.email=tp@localhost commit -qm base
    npm ci --no-audit --no-fund --loglevel=error > /dev/null
    npx turbo run "$1" --output-logs=errors-only > /dev/null
    git diff > "/out/$2"
  ' "$sha" "$task" "$(basename "$patch_abs")"

if [[ -s $patch_abs ]]; then
  echo "$task changes: $patch_abs ($(grep -c '^diff --git' "$patch_abs") files)"
else
  echo "no $task changes"
fi
