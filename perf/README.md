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
- Before the build it waits for an idle host (`perf/wait-idle.sh`, checked
  hourly): the pinned CPU and its hyperthread sibling must be idle, not just
  the machine on average. After the build it rests `--cooldown` seconds, then
  runs one warm-up pair that is discarded: on this 15 W laptop the rest
  refills the turbo budget and the first pass burns it down, so the first pair
  would run at a different frequency than the rest.
- A library revision whose `packages/protobuf/package.json` differs from the
  harness's is refused: the harness lockfile would not describe it.
- Library changes that alter code generation output fail the generated-code
  check on side B; such changes cannot be compared on this harness.
- `--filter` changes which cases run in the process, and with them the JIT
  state; filtered numbers are comparable only with runs using the same filter.
- CPU profiles show where time goes, not how much: profile runs are neither
  interleaved nor repeated, and their ops/s line is not a measurement.

## Reserving a core (`perf/isolate.sh`)

On a shared laptop the benchmark core is never idle, and its frequency
wanders with load. `sudo perf/isolate.sh on` takes CPU 2 and its sibling
CPU 3 away from `user.slice` and `system.slice` (everything users and services
run, Docker containers included), gives them to `pbbench.slice`, and pins
their frequency (`PERF_FREQ_KHZ`, default 2.4 GHz, below the level this 15 W
part sustains on one loaded core). `perf/run.sh --isolated` starts the
benchmark container in that slice and refuses to run if the reservation is
not in force. `sudo perf/isolate.sh off` restores everything; all settings are
runtime-only and also vanish on reboot. Kernel threads and interrupts are not
covered; `env.log` shows their CPU time per pass.

The rest of the machine still shares the L3 cache, memory bandwidth and the
package power budget with the reserved core. `freq.log` shows whether the
pinned frequency held; the A/A run shows how much noise remains.

## Usage

```sh
# With a reserved core (recommended on a shared machine):
sudo perf/isolate.sh on
perf/run.sh --isolated --base upstream/main --head upstream/main --label aa
sudo perf/isolate.sh off

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
| `meta.json` | resolved SHAs, image and its digest, CPUs, passes, cooldown, whether the core was reserved, corpus, host CPU model, kernel, governor, EPP, turbo, frequency limits |
| `<side>/run-NNN.json` | one pass: per case mean and p50 ops/s; `run-NNN.err` its stderr |
| `<side>/warmup.json` | the discarded warm-up pass |
| `<side>/lib.txt` | what the benchmark resolved: link target, version, sha256 of the built `dist` (identical for A/A, different for A/B) |
| `<side>/build.log` | install, build, codegen, generated-code check, typecheck |
| `order.log` | which side ran first in each pair |
| `env.log` | frequency and `/proc/stat` line of the pinned CPU and its sibling, before and after each pass |
| `freq.log` | frequency of the pinned CPU and its sibling every 250 ms, sampled from the host |
| `<side>/cpuprof/<case>/` | `.cpuprofile` files (open in speedscope) |
| `summary.json`, `report.md` | aggregate, see below |

## Reading the report

Decisions use the median latency (p50): per-sample latency is heavy-tailed.
For an A/B, passes are paired by file name; each pair gives a ratio B/A. The
report shows the median ratio, how many non-tied pairs B won, and an exact
two-sided sign-test p-value (with 10 pairs, 9 wins are needed for p < 0.05).
An effect is accepted only if it is outside the band an A/A run shows for the
same case. With some fifty cases per report, a few will cross p < 0.05 by
chance alone; a single significant case is a lead to replicate, not a result.

For sub-microsecond cases each sample also contains tinybench's fixed timing
overhead, on both sides, which shrinks the visible ratio slightly.
