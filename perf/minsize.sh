#!/usr/bin/env bash
# Minified and minified+gzip size of one file of the built library on both
# sides of a perf/run.sh result, in Docker (esbuild, the bundler that
# upstream's packages/bundle-size uses). The upstream bundle-size job only
# covers what its entry points import; a change to a module they do not
# import (e.g. from-json.js) is measured here instead.
#
# USAGE: perf/minsize.sh <result-dir> <path under dist/esm, e.g. from-json.js>
set -euo pipefail

out=${1:?usage: perf/minsize.sh <result-dir> <file under dist/esm>}
file=${2:?usage: perf/minsize.sh <result-dir> <file under dist/esm>}
out_abs=$(realpath "$out")
repo_root=$(git rev-parse --show-toplevel)
version=$(jq -r '.packages["node_modules/esbuild"].version' "$repo_root/package-lock.json")

for side in a b; do
  [[ -f $out_abs/$side/dist/esm/$file ]] || continue
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp/h -e npm_config_cache=/tmp/npm \
    -v "$out_abs/$side/dist:/dist:ro" node:24-trixie bash -c '
      set -euo pipefail
      min=$(npx -y "esbuild@$0" --minify --log-level=error "/dist/esm/$1")
      printf "%s %s %s\n" "$2" "$(printf %s "$min" | wc -c)" "$(printf %s "$min" | gzip -9 | wc -c)"
    ' "$version" "$file" "$side"
done | awk -v f="$file" '{ printf "%s %s: %d B minified, %d B minified+gzip\n", $1, f, $2, $3 }'
