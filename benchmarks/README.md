# protobuf-es Benchmark Suite

## Context

This directory contains microbenchmarks for the `@bufbuild/protobuf` serialization workloads. It addresses the measurement gap discussed in [#333](https://github.com/bufbuild/protobuf-es/issues/333) and [#1035](https://github.com/bufbuild/protobuf-es/issues/1035), where performance arguments have historically relied on ad-hoc user-provided numbers without a reproducible suite living alongside the library.

The OTLP-like fixture in `proto/nested.proto` is modelled on the real-world workload that produced [open-telemetry/opentelemetry-js#6221](https://github.com/open-telemetry/opentelemetry-js/issues/6221) (a ~13x serialization regression when protobuf-es was briefly adopted via the `fromJsonString + toBinary` path). Exercising the same message shape under controlled conditions makes that regression class observable against future protobuf-es versions.

## Running

```bash
# From the monorepo root (first time only)
npm ci
npx turbo run build --filter=@bufbuild/protobuf
npx turbo run generate --filter=@bufbuild/protobuf-benchmarks

# Run the full suite
npm run bench -w @bufbuild/protobuf-benchmarks

# Or run individual suites
npm run bench:create -w @bufbuild/protobuf-benchmarks
npm run bench:toBinary -w @bufbuild/protobuf-benchmarks
npm run bench:create-toBinary -w @bufbuild/protobuf-benchmarks
npm run bench:fromBinary -w @bufbuild/protobuf-benchmarks
npm run bench:fromJson-path -w @bufbuild/protobuf-benchmarks
npm run bench:comparison -w @bufbuild/protobuf-benchmarks
npm run bench:matrix -w @bufbuild/protobuf-benchmarks
npm run bench:memory -w @bufbuild/protobuf-benchmarks
```

## Benchmarks

| File | What it measures |
|------|------------------|
| `bench-create.ts` | Cost of `create(Schema, init)` in isolation — small flat message vs. full OTLP-like tree constructed via many nested `create()` calls |
| `bench-toBinary.ts` | Cost of `toBinary(Schema, message)` on pre-built messages — serialization-only, no allocation of the message graph |
| `bench-create-toBinary.ts` | Combined workload: build the message graph fresh each iteration, then serialize. This is the end-to-end shape of one OTLP export call |
| `bench-fromBinary.ts` | Cost of `fromBinary(Schema, bytes)` on pre-encoded payloads — reflective decoder walk in isolation |
| `bench-fromJson-path.ts` | `fromJsonString + toBinary` and `fromJson + toBinary` paths on the same fixture. The first one is the #6221 regression shape; the second is the partial-fix midpoint |
| `bench-comparison-protobufjs.ts` | Cross-library comparison: protobuf-es vs `protobufjs` (pbjs static codegen) on the same `.proto` fixture. Covers full roundtrip, encode-only, decode-only |
| `bench-matrix.ts` | `toBinary` + `fromBinary` across the full realistic-fixture matrix (OTel traces/metrics/logs, K8s Pod list, GraphQL request/response, RPC envelope, stress). Emits a JSON summary on stdout for CI diffing |
| `bench-memory.ts` | Heap allocations per operation (`heapUsed` delta after forced GC) for both libraries. Requires `--expose-gc` |

## Methodology

- Uses [tinybench](https://github.com/tinylibs/tinybench) for sampling, CI, and stats.
- 500 ms warmup, 2000 ms measurement per case.
- Node version taken from `.nvmrc` at repo root.
- Results are sensitive to host load. For tighter numbers pin to a single core:
  ```bash
  taskset -c 0 npm run bench -w @bufbuild/protobuf-benchmarks
  ```

## Fixtures

The suite runs across a matrix of payload shapes so a regression can be
attributed to a class of workload rather than lumped into a single "encoder
is slower" result. All fixtures live under `proto/` and are built by
helpers in `src/fixtures.ts`.

| Fixture | `.proto` | Shape | Typical encoded size | Notes |
|---------|----------|-------|---------------------:|-------|
| `SimpleMessage` | `small.proto` | 3 scalar fields | ~19 B | per-call overhead baseline |
| `ExportTraceRequest` | `nested.proto` | OTel traces: 100 spans × 10 attrs, fixed64 timestamps, bytes IDs | ~35 KB | repro of [open-telemetry/opentelemetry-js#6221](https://github.com/open-telemetry/opentelemetry-js/issues/6221) |
| `ExportMetricsRequest` | `otel-metrics.proto` | OTel metrics: 50 series with Gauge/Sum/Histogram mix, explicit bucket bounds | ~17 KB | exercises the `oneof data` dispatch + repeated doubles/uint64s |
| `ExportLogsRequest` | `otel-logs.proto` | OTel logs: 100 LogRecords, severity, string body, trace/span IDs | ~21 KB | string-heavy with attribute maps |
| `K8sPodList` | `k8s-pod.proto` | 20 Pods with labels/annotations, 2 containers each, ports + env + resource limits | ~29 KB | map-dominant config payload |
| `GraphQLRequest` | `graphql.proto` | Long query string + JSON-encoded variables map | ~0.6 KB | mixes a large string with `map<string,bytes>` |
| `GraphQLResponse` | `graphql.proto` | JSON-encoded `data` + structured errors | ~1.4 KB | bytes + repeated messages with string paths |
| `RpcRequest` | `rpc-simple.proto` | Routing fields + header map + 256-byte payload | ~0.5 KB | baseline RPC envelope |
| `RpcResponse` | `rpc-simple.proto` | Status + header map + 512-byte payload | ~0.6 KB | baseline RPC response |
| `StressMessage` | `stress.proto` | Depth-8 self-nested + 200-wide int32/string/attr arrays + 4KB blob + every scalar type | ~13 KB | synthetic — surfaces per-scalar-type regressions |

### Design notes

- **Map-heavy vs. list-heavy.** Kubernetes payloads stress `map<string,string>`
  encode paths; OTel payloads stress repeated nested messages. Both show up in
  production consumers and the encoder walks differ.
- **Deep nesting.** The stress fixture recurses through `StressMessage.child`
  eight levels deep. The encoder pays a length-prefix per level (fork buffer +
  measure + prefix), so depth is a distinct failure mode from total size.
- **All scalar types exactly once.** `StressMessage` declares each proto3
  scalar in a fixed slot so a regression specific to `sfixed64` or `sint32`
  varint zig-zag is visible in this fixture but not in realistic ones.
- **GraphQL/RPC payloads use `bytes` for opaque data** rather than structured
  sub-messages because real clients carry JSON-encoded variables and
  opaque RPC payloads as bytes on the wire; the benchmark reflects that.

### Future work

- `bench-matrix` currently measures `toBinary` + `fromBinary` on pre-built
  messages. A follow-up pass should add `create + toBinary` (full roundtrip)
  and `fromJsonString + toBinary` paths across the matrix to catch
  regressions in the JSON-input code paths that the existing
  `bench-fromJson-path` only exercises on the OTLP traces fixture.
- GraphQL variables are currently modelled as `map<string,bytes>` with JSON
  blobs per value. A richer fixture using a `google.protobuf.Struct`-like
  shape would exercise the same code paths the `@bufbuild/protobuf/wkt`
  `Value` type uses in real services.

## Report snapshot

Generated by `npm run bench:report -w @bufbuild/protobuf-benchmarks`. The
script writes `bench-results.json`, `chart.svg`, and the table below. See
`src/report.ts` for the generator and `src/report-helpers.ts` for the
rendering helpers.

![chart](./chart.svg)

<!--BENCHMARK_TABLE_START-->

| Fixture                            |  Bytes | toBinary | toBinaryFast | protobufjs | Best                 |
| ---------------------------------- | -----: | -------: | -----------: | ---------: | -------------------- |
| SimpleMessage                      |     19 |    1.39M |        1.81M |          - | toBinaryFast (1.30x) |
| ExportTraceRequest (100 spans)     | 32,926 |      525 |        2,501 |      3,110 | protobufjs (1.24x)   |
| ExportMetricsRequest (50 series)   | 17,696 |      891 |        4,773 |          - | toBinaryFast (5.36x) |
| ExportLogsRequest (100 records)    | 21,319 |      880 |        3,772 |          - | toBinaryFast (4.28x) |
| K8sPodList (20 pods)               | 28,900 |      712 |        3,510 |          - | toBinaryFast (4.93x) |
| GraphQLRequest                     |    624 |  113,985 |      214,019 |          - | toBinaryFast (1.88x) |
| GraphQLResponse                    |  1,366 |  145,325 |      558,123 |          - | toBinaryFast (3.84x) |
| RpcRequest                         |    501 |  111,194 |      373,729 |          - | toBinaryFast (3.36x) |
| RpcResponse                        |    602 |  171,243 |      639,426 |          - | toBinaryFast (3.73x) |
| StressMessage (depth=8, width=200) | 12,868 |    2,568 |       14,378 |          - | toBinaryFast (5.60x) |

<!--BENCHMARK_TABLE_END-->

## Current results

First local run on Node v25.8.1, linux/x64 (non-isolated host, margins of error are realistic for an unpinned benchmark machine — numbers are directionally stable but will shift on quieter hardware). All ops/sec are medians from `tinybench.table()`.

### create() cost

| Case | ops/sec (median) | ± |
|------|------------------|---|
| `create() SimpleMessage (3 scalar fields)` | 2,123,142 | 16% |
| `create() ExportTraceRequest nested (100 spans, 10 attrs each)` | 3,674 | 3.4% |

### toBinary() cost on pre-built messages

| Case | ops/sec (median) | ± |
|------|------------------|---|
| `toBinary() SimpleMessage (pre-built)` | 690,608 | 18% |
| `toBinary() ExportTraceRequest (pre-built, 100 spans)` | 267 | 26% |

### create() + toBinary() combined workload

| Case | ops/sec (median) | ± |
|------|------------------|---|
| `create() + toBinary() SimpleMessage` | 402,091 | 42% |
| `create() + toBinary() ExportTraceRequest (100 spans, OTel-like)` | 285 | 19% |

### fromJson / fromJsonString + toBinary paths

| Case | ops/sec (median) | ± |
|------|------------------|---|
| `fromJsonString + toBinary (100 spans) — OTel #6221 shape` | 235 | 15% |
| `fromJson + toBinary (100 spans) — plainObject path` | 275 | 12% |

### fromBinary() parsing cost

| Case | ops/sec (median) | ± |
|------|------------------|---|
| `fromBinary() SimpleMessage (19 B)` | 1,663,894 | 0.02% |
| `fromBinary() ExportTraceRequest (100 spans, 35,283 B)` | 1,501 | 0.40% |

Parsing (decode) is materially faster than encoding on the same nested workload: ~1,500 ops/s decode vs ~600 ops/s encode. The encode walk pays varint length prefixing (writing length-delimited sub-messages requires allocating a fork buffer, encoding into it, then measuring its length to write the length prefix) that does not have a symmetric cost in the decode path.

### protobuf-es vs protobufjs (same `.proto`, same host)

Bench run on the OTLP-like 100-span fixture; protobufjs generated via `pbjs -t static-module -w commonjs --force-long`. Numbers below are medians from standalone runs of `bench:comparison` (host not isolated; margins of error on protobuf-es cases are wider than on protobufjs because each protobuf-es iteration takes longer, giving fewer samples in the 2000 ms measurement window).

| Workload | protobuf-es ops/s | protobufjs ops/s | Ratio |
|----------|---------------------:|--------------------:|--------:|
| create + encode (100 spans) | 666 | 3,788 | **5.7x slower** |
| encode pre-built (100 spans) | 622 | 4,041 | **6.5x slower** |
| decode 100 spans | 1,501 | 6,868 | **4.6x slower** |

Run-to-run variance on an unpinned host moves these ratios by roughly ±20%. Observed ranges across multiple runs: 5.3x–6.3x on create+encode, 4.4x–6.5x on decode. For tighter numbers pin to a single core.

### Memory (heap bytes per operation)

Coarse measurement via `heapUsed` delta across 1,000 iterations after forced GC. Requires `--expose-gc`.

| Case | Bytes/op (avg) | Ratio vs protobufjs |
|------|----------------:|---------------------:|
| protobuf-es: create + toBinary (100 spans) | 23,524 | 3.2x more |
| protobufjs: create + encode (100 spans) | 7,449 | baseline |
| protobuf-es: fromBinary (100 spans) | 31,569 | 0.94x (less) |
| protobufjs: decode (100 spans) | 33,594 | baseline |

Observations:
- Encode side: protobuf-es allocates ~3x more heap per operation than protobufjs. Consistent with the reflective encoder path constructing intermediate length-prefix buffers via `BinaryWriter.fork()` + array joins per sub-message.
- Decode side: allocations are within jitter — both libraries materialize the message tree, and the decoded object graph dominates the delta.

### Reading these numbers

- On the 100-span nested workload, `toBinary` dominates: pre-built `toBinary` (267 ops/s) and combined `create() + toBinary()` (285 ops/s) are within jitter of each other, i.e. constructing the message graph is cheap compared to the reflective binary encode walk.
- The `fromJsonString + toBinary` path is roughly 20% slower than direct `create + toBinary` on this fixture (235 vs 285 ops/s median). The OTel incident report observed ~13x — most of that gap is the extra transformer-level traversals building the JSON-shaped object tree upstream of `fromJsonString`, which this benchmark does not exercise. Here we isolate just the `fromJsonString + toBinary` step, so the observed ratio is the lower bound on the regression's protobuf-es-side contribution.
- The `SimpleMessage` numbers illustrate per-call overhead on a trivial shape. Relevant when many small messages are serialized in tight loops (e.g. gRPC unary call payloads).
- The comparison vs protobufjs is consistent with the OTel report's directional claim (protobuf-es is slower on this shape), but the observed ratio here is ~5–7x, not the 13x–30x sometimes cited from external measurements. The difference is attributable to (a) pbjs static-module codegen producing ahead-of-time encoders, which isolates only the encoder/decoder walk; real-world numbers include app-level traversal, JSON conversion, BigInt handling, and allocator pressure which this suite deliberately does not measure; (b) different Node versions and host conditions. This suite reports what protobuf-es actually spends on encode/decode under controlled conditions — use those numbers for tracking, not for headline claims.

## Methodology notes

- The `bench-fromJson-path` cases deliberately reproduce a known-pathological pattern. Do not read the numbers there as "protobuf-es is slow" — they show the cost of an unnecessary extra traversal. See `bench-create-toBinary` for the idiomatic path.
- `create()` is called per sub-message in the nested benchmark (every `KeyValue`, `Span`, `ScopeSpans`, etc.) because protobuf-es's reflective `toBinary` relies on the `$typeName`-tagged prototype established by `create` — this matches the real-world cost of constructing an OTLP-like tree.
- The comparison benchmark uses pbjs static-module codegen (ahead-of-time encoder/decoder), which is the protobufjs mode most commonly adopted in production. pbjs reflection-mode numbers would be slower and not representative of what protobufjs users actually deploy.
- The memory benchmark uses a `heapUsed` delta across 1,000 iterations with `gc()` sandwiching the measurement. This is coarse — it does not separate young-gen allocations cleared between minor GCs from steady-state retained memory — but it is internally consistent across the libraries compared here. For finer attribution use `node --heap-prof` and inspect the resulting `.heapprofile` in Chrome DevTools.

## Future work

- CI integration — run on PR and publish trends; flag regressions above a configurable threshold.
- `ts-proto` comparison on the same fixtures (separate package, opt-in dependency). Would round out the "ahead-of-time codegen" comparison group alongside protobufjs.
- Streaming write benchmarks (`sizeDelimitedEncode`) for gRPC-style workloads.
- Allocation tracking via `node --heap-prof` for per-call-site attribution (replacing the coarse `heapUsed` delta in `bench-memory`).
