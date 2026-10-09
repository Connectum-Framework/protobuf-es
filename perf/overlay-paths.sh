#!/usr/bin/env bash
# Checks that the changes between two revisions are of one kind only:
#   library  packages/protobuf/, packages/protobuf-test/,
#            packages/protobuf-conformance/, packages/bundle-size/README.md
#   tooling  packages/protobuf-bench/, perf/, .github/workflows/bench-*.yaml,
#            .github/workflows/overlay-paths.yaml
# A library change is later proposed upstream by cherry-picking it onto
# upstream's main, so it must not carry fork tooling; a tooling change must
# not hide library edits. Any other path belongs to upstream and is synced
# from there, not changed in a fork pull request.
#
# USAGE: perf/overlay-paths.sh <base> <head>   (exit 1 on a violation)
set -euo pipefail

base=${1:?usage: perf/overlay-paths.sh <base> <head>} head=${2:?}

library='^(packages/protobuf/|packages/protobuf-test/|packages/protobuf-conformance/|packages/bundle-size/README\.md$)'
tooling='^(packages/protobuf-bench/|perf/|\.github/workflows/bench-[^/]+\.yaml$|\.github/workflows/overlay-paths\.yaml$)'

files=$(git diff --name-only "$base...$head")
lib=$(grep -E "$library" <<< "$files" || true)
tool=$(grep -E "$tooling" <<< "$files" || true)
other=$(grep -vE "$library|$tooling" <<< "$files" | grep -v '^$' || true)

status=0
if [[ -n $other ]]; then
  echo "::error::files outside the library and tooling sets (upstream-owned):"
  echo "$other"
  status=1
fi
if [[ -n $lib && -n $tool ]]; then
  echo "::error::a pull request changes library and tooling files together; split it"
  echo "library:"; echo "$lib"
  echo "tooling:"; echo "$tool"
  status=1
fi
if [[ $status -eq 0 ]]; then
  echo "kind: $([[ -n $lib ]] && echo library || echo tooling) ($(wc -l <<< "$files") files)"
fi
exit "$status"
