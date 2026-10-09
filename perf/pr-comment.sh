#!/usr/bin/env bash
# Creates or updates one comment on a pull request, identified by a marker,
# so that each re-run of a benchmark replaces its previous table instead of
# adding another comment. Uses the gh CLI with GH_TOKEN from the workflow.
#
# USAGE: perf/pr-comment.sh <repo> <pr-number> <marker> <body-file>
set -euo pipefail

repo=${1:?usage: perf/pr-comment.sh <repo> <pr-number> <marker> <body-file>}
pr=${2:?} marker=${3:?} body_file=${4:?}

tag="<!-- $marker -->"
body=$(printf '%s\n\n%s\n' "$tag" "$(cat "$body_file")")

id=$(gh api --paginate "repos/$repo/issues/$pr/comments" \
  --jq ".[] | select(.body | startswith(\"$tag\")) | .id" | head -n 1)
if [[ -n $id ]]; then
  gh api --method PATCH "repos/$repo/issues/comments/$id" -f body="$body" > /dev/null
else
  gh api --method POST "repos/$repo/issues/$pr/comments" -f body="$body" > /dev/null
fi
