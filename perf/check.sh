#!/usr/bin/env bash
# Runs the checks of upstream's .github/workflows/ci.yaml against one
# committed revision, inside Docker: tests (BigInt and fallback), conformance,
# lint, attw, TypeScript compatibility, and the license-header, format and
# bundle-size jobs followed by gh-diffcheck (a job fails if it changes files).
#
# USAGE: perf/check.sh <git-ref> [--node IMAGE]... [--label NAME]
#
# The test and conformance jobs run once per --node image and per bigint
# mode, as upstream's matrix does; the other jobs run once, on the first
# image. Logs go to .tmp/perf/check-<label>/, one file per job, and a
# summary line per job to summary.txt. Exit status is 0 only if every job
# passed.
set -euo pipefail

ref= label= images=()
while [[ $# -gt 0 ]]; do
  case $1 in
    --node) images+=("$2"); shift 2 ;;
    --label) label=$2; shift 2 ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) [[ -z $ref ]] || { echo "unexpected argument: $1" >&2; exit 2; }; ref=$1; shift ;;
  esac
done
[[ -n $ref ]] || { echo "usage: perf/check.sh <git-ref> [--node IMAGE]... [--label NAME]" >&2; exit 2; }
# Debian trixie images: the conformance runner binary needs glibc >= 2.38,
# which the bookworm-based default tags (glibc 2.36) do not have.
[[ ${#images[@]} -gt 0 ]] || images=(node:22-trixie node:24-trixie node:26-trixie)

repo_root=$(git rev-parse --show-toplevel)
git_common=$(cd "$repo_root" && cd "$(git rev-parse --git-common-dir)" && pwd)
sha=$(git -C "$repo_root" rev-parse --verify "$ref^{commit}")
label=${label:-${sha:0:10}}
out="$repo_root/.tmp/perf/check-$label"
if [[ -e $out ]]; then
  echo "result directory exists, pick another --label: $out" >&2
  exit 1
fi
mkdir -p "$out"
cache="$repo_root/.tmp/perf/npm-cache"
mkdir -p "$cache"
# The source tree with node_modules lives on disk, not in a RAM-backed tmpfs.
work="$HOME/.cache/agent-work/protobuf-es/check-work"
mkdir -p "$work"
if [[ -n $(ls -A "$work") ]]; then
  echo "check directory not empty (another run, or a crashed one): $work" >&2
  exit 1
fi
echo "$sha" > "$out/sha.txt"

# One container per image: a job matrix row needs that image's Node.js.
first=1
status=0
for image in "${images[@]}"; do
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    -e HOME=/home/check \
    -e npm_config_cache=/npm-cache \
    -e CHECK_SHA="$sha" \
    -e CHECK_IMAGE="$image" \
    -e CHECK_ALL_JOBS="$first" \
    --tmpfs /home/check:exec \
    -v "$repo_root:$repo_root:ro" \
    -v "$git_common:$git_common:ro" \
    -v "$cache:/npm-cache" \
    -v "$work:/work" \
    -v "$out:/out" \
    -w "$repo_root" \
    "$image" \
    bash "$repo_root/perf/check-in-container.sh" || status=1
  first=0
done

cat "$out/summary.txt"
exit "$status"
