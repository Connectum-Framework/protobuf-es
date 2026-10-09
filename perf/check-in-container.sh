#!/usr/bin/env bash
# Runs inside the container started by perf/check.sh; not meant to be called
# directly. Mirrors the jobs of upstream's .github/workflows/ci.yaml.
set -uo pipefail

git config --global --add safe.directory '*'
src_repo=$PWD
trap 'rm -rf /work/src' EXIT

tag=$(echo "$CHECK_IMAGE" | tr ':/' '__')
summary=/out/summary.txt
failed=0

# Runs one job, logging to /out/<name>.log and recording PASS/FAIL.
job() {
  local name=$1; shift
  if (cd /work/src && "$@") > "/out/$name.log" 2>&1; then
    echo "PASS $name" >> "$summary"
  else
    echo "FAIL $name (see $name.log)" >> "$summary"
    failed=1
  fi
}

# Every job starts from a pristine tree, as each CI job starts from a fresh
# checkout: gh-diffcheck must only see what that job itself changed.
fresh() {
  rm -rf /work/src
  mkdir -p /work/src
  git -C "$src_repo" archive "$CHECK_SHA" | tar -x -C /work/src
  # gh-diffcheck and license-header ask git for the state of the tree.
  (cd /work/src && git init -q && git add -A \
    && git -c user.name=check -c user.email=check@localhost commit -qm base)
  (cd /work/src && npm ci --no-audit --no-fund --loglevel=error) > "/out/npm-ci-$tag.log" 2>&1
}

# A job followed by gh-diffcheck: it fails if the job changed tracked files.
diffcheck_job() {
  local name=$1; shift
  job "$name" bash -c "$* && node scripts/gh-diffcheck.js"
}

fresh
for bigint in 0 1; do
  job "test-$tag-bigint$bigint" env BUF_BIGINT_DISABLE=$bigint \
    npx turbo run test -F '!./packages/protobuf-conformance' -F '!./packages/typescript-compat/*'
  job "conformance-$tag-bigint$bigint" env BUF_BIGINT_DISABLE=$bigint \
    npx turbo run test -F './packages/protobuf-conformance'
done

if [[ $CHECK_ALL_JOBS == 1 ]]; then
  job lint npx turbo run lint
  job attw npx turbo run attw
  job typescript-compat npx turbo run test -F './packages/typescript-compat/*'
  fresh
  diffcheck_job license-header npx turbo run license-header
  fresh
  diffcheck_job format npx turbo run format
  fresh
  diffcheck_job bundle-size npx turbo run bundle-size
  fresh
  diffcheck_job bootstrap npx turbo run bootstrap
fi

exit "$failed"
