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

`perf/report.sh <dir>` re-aggregates an existing result directory. With
`MAX_LOW_FREQ_PCT=N` it drops every pair in which a pass spent more than N %
of its time below the pinned frequency (from `freq.log`), and writes
`summary-freqN.json` / `report-freqN.md` next to the unfiltered files.
`pass-freq.tsv` lists that share and the mean frequency for every pass.

`perf/profile-top.sh [-n N] <dir|file>...` lists the functions with the most
self time in `.cpuprofile` files; locations refer to `<side>/dist/`.

## Output (`.tmp/perf/<label>/`)

| File | Content |
|---|---|
| `meta.json` | resolved SHAs, image and its digest, CPUs, passes, cooldown, whether the core was reserved, corpus, host CPU model, kernel, governor, EPP, turbo, frequency limits |
| `<side>/run-NNN.json` | one pass: per case mean and p50 ops/s; `run-NNN.err` its stderr |
| `<side>/warmup.json` | the discarded warm-up pass |
| `<side>/lib.txt` | what the benchmark resolved: link target, version, sha256 of the built `dist` (identical for A/A, different for A/B) |
| `<side>/dist/` | the built library; CPU profile lines refer to these files |
| `<side>/build.log` | install, build, codegen, generated-code check, typecheck |
| `container-cpuset.txt` | CPUs the container could actually run on; `run.sh` rejects the run unless it is exactly the pinned CPU |
| `order.log` | which side ran first in each pair |
| `env.log` | frequency and `/proc/stat` line of the pinned CPU and its sibling, before and after each pass |
| `freq.log` | frequency of the pinned CPU and its sibling every 250 ms, sampled from the host |
| `<side>/cpuprof/<case>/` | `.cpuprofile` files (open in speedscope) |
| `summary.json`, `report.md` | aggregate, see below |

## Reading the report

Decisions use the median latency (p50): per-sample latency is heavy-tailed.
For an A/B, passes are paired by file name; each pair gives a ratio r = B/A.
Per case the report shows the median of r, the robust pair noise (1.4826 ×
MAD of ln r; the standard deviation is inflated several-fold by the tails a
loaded host produces), how many non-tied pairs B won, the exact two-sided
sign-test p, and that p corrected over all cases of the report
(Benjamini-Hochberg).

A case is flagged IMPROVEMENT or REGRESSION only if all of these hold:

- the corrected p is ≤ 0.05 — with some fifty cases, raw p < 0.05 would
  flag a few by chance in every run;
- |ln median r| ≥ ln 1.02 + bias bound: a practical floor of 2 %, plus the
  rig's systematic bias bound measured by an A/A run (`AA_NOISE=`, below).

Measured on this laptop (two local A/A runs, 30 pairs, 40 and 66 cases): no
false signal; the bias bound was 0.3 % and 0.2 %. A uniform 5 % shift of one
side is flagged in 106 of 106 cases upwards and 105 of 106 downwards
(`perf/test-report.sh`). With 30 pairs a single-case effect of about 3 % is
detectable; with 10 pairs a single case cannot reach significance at all
after the correction (10 of 10 wins gives p = 0.002 > 0.05 / 40), so 10
pairs is a smoke run, not a measurement.

For sub-microsecond cases each sample also contains tinybench's fixed timing
overhead, on both sides, which shrinks the visible ratio slightly.

A signal on a path the change does not touch is not proof of a cost to that
path. All cases of a corpus run in one process, in a fixed order, for a fixed
time each; a change that makes one case faster also changes how much garbage
and JIT state the next case starts with. In one local A/B of a fromJson
change, `toBinary/stress` (which runs right after `fromJson` of the previous
fixture) was flagged −4.8 %; it stayed at −3…−4 % in the pairs without
frequency drops, but ran at −0.2 %, p 0.86 when measured alone — which
removes the preceding cases and the noise at once, so it cannot tell them
apart. The control is two filtered runs: the affected operation alone, and
the affected operation together with the changed one.

On a loaded host, also read the report with `MAX_LOW_FREQ_PCT`: frequency
drops widen the pair noise, and the A/A calibration of a quiet host does not
describe them.

## Calibration and self-test

```sh
perf/report.sh <A/A dir>                       # refresh its summary.json
perf/aa-noise.sh <A/A dir>/summary.json > aa-noise.json
AA_NOISE=aa-noise.json perf/report.sh <A/B dir>
perf/test-report.sh <A/A dir>                  # rule self-test, see above
```

`aa-noise.sh` refuses a run whose two sides differ, and an A/A smaller than
20 cases × 20 pairs. The report warns when the A/A came from another rig
(host CPU, CPU set or runtime).

## Library checks (`perf/check.sh`)

`perf/check.sh <ref>` runs the jobs of upstream's `ci.yaml` against a
committed revision in Docker: tests and conformance on Node.js 22, 24 and 26
in both bigint modes, lint, attw, TypeScript compatibility, and the
license-header, format, bundle-size and bootstrap jobs followed by
`gh-diffcheck`. Results: `.tmp/perf/check-<label>/summary.txt` and one log
per job. Trixie-based images are required: the conformance runner needs
glibc 2.38.

## The fork and its CI

The fork's `main` is upstream's `main` plus a linear overlay of two kinds of
squash-merged commits, never mixed in one pull request
(`overlay-paths.yaml`, rules in `perf/overlay-paths.sh`):

- library changes — `packages/protobuf/`, `packages/protobuf-test/`,
  `packages/protobuf-conformance/`, `packages/bundle-size/README.md`; each is
  later proposed upstream by cherry-picking it onto upstream's `main`;
- fork tooling — `packages/protobuf-bench/`, `perf/`, `bench-*` and
  `overlay-paths` workflows; never part of an upstream pull request.

`bench-ab.yaml` measures every pull request that touches the library or the
tooling against its base, on both corpora in parallel jobs (30 pairs each, up
to about 2 hours), with `perf/ci-measure.sh` → `perf/measure.sh` (each
measured process pinned with `taskset -c 2`), and posts the report as one
comment per corpus that later runs replace. `bench-aa.yaml` measures `main`
against itself weekly and on demand; bench-ab takes the bias bound from its
latest successful run. Re-run bench-aa after every sync with upstream.

Tags are never pushed to the fork: upstream's `publish.yaml` would publish
on a `v*` tag.
