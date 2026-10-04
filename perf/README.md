# perf — reproducible measurements of @bufbuild/protobuf

Fork-only tooling. It is not part of any upstream pull request; upstream PRs
carry only library changes, with numbers produced by this tooling on the
upstream benchmark corpus.

## What it measures

`perf/run.sh` measures the library with `packages/protobuf-bench` inside
Docker (`node:24.21.0` by default), pinned to one CPU:

- The tree is assembled from committed revisions only (`git archive`): the
  benchmark code comes from `--harness`, `packages/protobuf` from `--base`
  (and `--head`). Both sides of a comparison run byte-identical benchmark code.
- Each pass is a fresh `node` process running the whole selected corpus.
  With `--head`, passes of A and B alternate in random order within each pair.
- By default the corpus is exactly upstream's. `--realistic` adds the
  production-shaped fixtures (OTel traces/metrics/logs, Kubernetes pods,
  GraphQL, RPC, stress), which also changes the JIT state the upstream cases run
  under, so the two corpora are never mixed in one comparison.
- Before the first pass it waits for an idle host (`perf/wait-idle.sh`,
  checked hourly), then rests `--cooldown` seconds after the build.

## Usage

```sh
# A/A: the noise floor. Run this before trusting any A/B on this machine.
perf/run.sh --base upstream/main --head upstream/main --label aa-upstream

# Baseline of one revision, with CPU profiles.
perf/run.sh --base upstream/main --label baseline --profile toBinary/general

# A/B of a library change on the realistic corpus.
perf/run.sh --base upstream/main --head my-branch --realistic --label my-change
```

`perf/report.sh <dir>` re-aggregates an existing result directory.

## Output (`.tmp/perf/<label>/`)

| File | Content |
|---|---|
| `meta.json` | resolved SHAs, image, CPUs, passes, corpus |
| `a/run-<k>.json`, `b/run-<k>.json` | one pass: per case mean and p50 ops/s |
| `order.log` | which side ran first in each pair |
| `env.log` | frequency and `/proc/stat` line of the pinned CPU and its sibling, before and after each pass |
| `a/cpuprof/<case>/` | `.cpuprofile` files (open in speedscope) |
| `summary.json`, `report.md` | aggregate, see below |

## Reading the report

Decisions use the median latency (p50): per-sample latency is heavy-tailed.
For an A/B, each pair gives a ratio B/A; the report shows the median ratio,
how many pairs B won, and an exact two-sided sign-test p-value. An effect is
accepted only if it is outside the band an A/A run shows for the same case.
