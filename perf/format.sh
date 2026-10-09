#!/usr/bin/env bash
# Runs upstream's formatter (`npx turbo run format`, Biome) on a committed
# revision inside Docker and writes the resulting changes as a patch, so that
# no dependency is installed on the host. Apply with `git apply <patch>`.
#
# USAGE: perf/format.sh <git-ref> <patch-file> [--image IMAGE]
set -euo pipefail

ref=${1:?usage: perf/format.sh <git-ref> <patch-file> [--image IMAGE]}
patch=${2:?usage: perf/format.sh <git-ref> <patch-file> [--image IMAGE]}
image=node:24-trixie
if [[ ${3:-} == --image ]]; then image=${4:?}; fi

repo_root=$(git rev-parse --show-toplevel)
git_common=$(cd "$repo_root" && cd "$(git rev-parse --git-common-dir)" && pwd)
sha=$(git -C "$repo_root" rev-parse --verify "$ref^{commit}")
cache="$repo_root/.tmp/perf/npm-cache"
work="$HOME/.cache/agent-work/protobuf-es/format-work"
mkdir -p "$cache" "$work"
if [[ -n $(ls -A "$work") ]]; then
  echo "format directory not empty (another run, or a crashed one): $work" >&2
  exit 1
fi
patch_abs=$(realpath -m "$patch")
mkdir -p "$(dirname "$patch_abs")"

docker run --rm \
  --user "$(id -u):$(id -g)" \
  -e HOME=/home/fmt -e npm_config_cache=/npm-cache \
  --tmpfs /home/fmt:exec \
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
    git -c user.name=fmt -c user.email=fmt@localhost commit -qm base
    npm ci --no-audit --no-fund --loglevel=error > /dev/null
    npx turbo run format --output-logs=errors-only > /dev/null
    git diff > "/out/$1"
  ' "$sha" "$(basename "$patch_abs")"

if [[ -s $patch_abs ]]; then
  echo "formatter changes: $patch_abs ($(grep -c '^diff --git' "$patch_abs") files)"
else
  echo "no formatter changes"
fi
