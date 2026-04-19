# Benchmark Baselines

This directory holds **quick-reference baselines** — last-known-good throughput numbers for the matrix, committed alongside code so a local developer can run `scripts/compare-results.ts` without having to hit GitHub.

## Storage model

The authoritative baseline is an **Actions artifact**, not a file in the repo:

| Where                                        | Role                                  | Retention        |
|----------------------------------------------|---------------------------------------|------------------|
| Artifact `bench-baseline-main`               | Source of truth for CI diffs          | 365 days         |
| `benchmarks/baselines/main.json`             | Quick-reference for local dev + fallback when the artifact API is unreachable | tracked in git |
| Artifact `bench-results-<pr-number>`         | Historical trend per PR               | 90 days          |

### Why two stores

1. **Artifacts give trend history for free.** Downloading `bench-baseline-main@<run-id>` at any point in the past reconstructs the baseline of that day. No file churn in git.
2. **A committed fallback de-risks the artifact dependency.** If GitHub artifact downloads rate-limit or the action times out, CI falls back to `main.json` so PRs are never blocked on infrastructure. The file does not have to be fresh to be useful — being roughly right on order of magnitude is enough to flag a regression that a human can investigate.
3. **Local dev needs a zero-network path.** `npm run bench:matrix:ci` followed by `npm run bench:matrix:compare -- --baseline=baselines/main.json --current=bench-results.json` works entirely offline.

## Update procedure

`main.json` is refreshed **by hand via a one-line PR** after every merge to `main` whose benchmark numbers moved materially (>5% on any row). A follow-up iteration will automate this via a `benchmark-baseline-refresh` workflow that opens the PR from the push-to-main run, but until that lands, manual refresh is the policy.

```bash
# After a merge to main, pull the latest artifact:
gh run download --name bench-baseline-main --dir /tmp/baseline
cp /tmp/baseline/bench-results.json benchmarks/baselines/main.json

# Commit on a chore/ branch and open a PR:
git checkout -b chore/refresh-benchmark-baseline
git add benchmarks/baselines/main.json
git commit -m "chore(benchmarks): refresh main baseline"
git push -u origin HEAD
gh pr create --title "chore(benchmarks): refresh main baseline" \
  --body "Auto-refresh from the bench-baseline-main CI artifact."
```

## Format

Every `*.json` in this directory is the structured payload written by `bench-matrix.ts` (last line of its stdout when run standalone, or the full file when run via `scripts/run-matrix-ci.sh`):

```json
{
  "node": "v22.11.0",
  "platform": "linux/x64",
  "timestamp": "2026-04-19T18:00:00.000Z",
  "results": [
    {
      "name": "SimpleMessage :: toBinary (pre-built, 19 B)",
      "opsPerSec": 1065000,
      "rme": 1.3,
      "samples": 512
    }
  ]
}
```

Field names are stable; additional fields are additive (e.g. a future `bytesPerOp` for memory tracking will not break existing consumers).
