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
npm run bench:fromJson-path -w @bufbuild/protobuf-benchmarks
```

## Benchmarks

| File | What it measures |
|------|------------------|
| `bench-create.ts` | Cost of `create(Schema, init)` in isolation — small flat message vs. full OTLP-like tree constructed via many nested `create()` calls |
| `bench-toBinary.ts` | Cost of `toBinary(Schema, message)` on pre-built messages — serialization-only, no allocation of the message graph |
| `bench-create-toBinary.ts` | Combined workload: build the message graph fresh each iteration, then serialize. This is the end-to-end shape of one OTLP export call |
| `bench-fromJson-path.ts` | `fromJsonString + toBinary` and `fromJson + toBinary` paths on the same fixture. The first one is the #6221 regression shape; the second is the partial-fix midpoint |

## Methodology

- Uses [tinybench](https://github.com/tinylibs/tinybench) for sampling, CI, and stats.
- 500 ms warmup, 2000 ms measurement per case.
- Node version taken from `.nvmrc` at repo root.
- Results are sensitive to host load. For tighter numbers pin to a single core:
  ```bash
  taskset -c 0 npm run bench -w @bufbuild/protobuf-benchmarks
  ```

## Fixtures

The fixture in `proto/nested.proto` is a simplified subset of the [OTLP `ExportTraceServiceRequest`](https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/collector/trace/v1/trace_service.proto) — enough shape (bytes fields, fixed64 timestamps, repeated nested `KeyValue`, two levels of grouping) to be representative of a real export hot path without dragging in the full OpenTelemetry proto dependency graph. The default payload is 100 spans, each with 10 attributes.

`proto/small.proto` is a 3-scalar-field message that isolates per-call overhead (create/toBinary) without allocation noise.

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

### Reading these numbers

- On the 100-span nested workload, `toBinary` dominates: pre-built `toBinary` (267 ops/s) and combined `create() + toBinary()` (285 ops/s) are within jitter of each other, i.e. constructing the message graph is cheap compared to the reflective binary encode walk.
- The `fromJsonString + toBinary` path is roughly 20% slower than direct `create + toBinary` on this fixture (235 vs 285 ops/s median). The OTel incident report observed ~13x — most of that gap is the extra transformer-level traversals building the JSON-shaped object tree upstream of `fromJsonString`, which this benchmark does not exercise. Here we isolate just the `fromJsonString + toBinary` step, so the observed ratio is the lower bound on the regression's protobuf-es-side contribution.
- The `SimpleMessage` numbers illustrate per-call overhead on a trivial shape. Relevant when many small messages are serialized in tight loops (e.g. gRPC unary call payloads).

## Methodology notes

- The `bench-fromJson-path` cases deliberately reproduce a known-pathological pattern. Do not read the numbers there as "protobuf-es is slow" — they show the cost of an unnecessary extra traversal. See `bench-create-toBinary` for the idiomatic path.
- `create()` is called per sub-message in the nested benchmark (every `KeyValue`, `Span`, `ScopeSpans`, etc.) because protobuf-es's reflective `toBinary` relies on the `$typeName`-tagged prototype established by `create` — this matches the real-world cost of constructing an OTLP-like tree.
- The benchmarks measure serialization only; they do not exercise `fromBinary` (parsing). A parsing suite is listed under Future work.

## Future work

- CI integration — run on PR and publish trends; flag regressions above a configurable threshold.
- Comparison runs against `protobufjs` and `ts-proto` on the same fixtures (separate package, opt-in dependencies).
- Memory / allocation benchmarks via `node --heap-prof`.
- Streaming write benchmarks (`sizeDelimitedEncode`) for gRPC-style workloads.
- `fromBinary` parsing benchmarks symmetric to these.
