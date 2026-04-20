// Copyright 2021-2026 Buf Technologies, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Heap profile driver.
//
// Replaces the coarse `heapUsed` delta in `bench-memory.ts` with V8's
// sampling heap profiler (`node --heap-prof`). The driver runs a tight
// loop of a chosen workload and relies on the caller having launched
// Node with `--heap-prof` so V8 writes a `.heapprofile` file on exit.
//
// This file does NOT call `v8.startSamplingHeapProfile` itself — we use
// the Node CLI flag because it matches what engineers run locally when
// they want to attribute allocations in a failing service ("run it with
// --heap-prof and open the .heapprofile in DevTools"). The analyzer
// script (`scripts/analyze-heap-prof.ts`) then aggregates the profile to
// call-site totals so the attribution works headlessly in CI too.
//
// Usage:
//   node --heap-prof --heap-prof-dir=.heap-profs --heap-prof-interval=8192 \
//        --import tsx src/heap-prof-driver.ts --fixture=otel100
//
// Or via the wrapper script: `npm run bench:heap-prof`.

import { toBinary, toBinaryFast } from "@bufbuild/protobuf";

import { ExportTraceRequestSchema } from "./gen/nested_pb.js";
import { K8sPodListSchema } from "./gen/k8s-pod_pb.js";
import { RpcRequestSchema } from "./gen/rpc-simple_pb.js";
import { ExportMetricsRequestSchema } from "./gen/otel-metrics_pb.js";

import {
  buildExportTraceRequest,
  buildExportMetricsRequest,
  buildK8sPodList,
  buildRpcRequest,
} from "./fixtures.js";

// --- CLI parsing -----------------------------------------------------------
//
// Keep argument parsing minimal — a shell script wraps this driver so we
// don't need a full CLI framework. Accepted args:
//   --fixture=<name>    fixture key (default: otel100)
//   --encoder=<name>    toBinary | toBinaryFast (default: toBinaryFast)
//   --iterations=<n>    iterations to run (default: 1000)

function parseArg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const fixtureKey = parseArg("fixture", "otel100");
const encoderName = parseArg("encoder", "toBinaryFast");
const iterations = Number(parseArg("iterations", "1000"));

// biome-ignore lint/suspicious/noExplicitAny: dispatch is intentionally loose
type AnySchema = any;
// biome-ignore lint/suspicious/noExplicitAny: dispatch is intentionally loose
type AnyMsg = any;

interface Fixture {
  schema: AnySchema;
  build(): AnyMsg;
  describe: string;
}

// Registry of supported fixtures. Keys are short CLI-friendly aliases; the
// description is printed at startup so the .heapprofile's context is not
// lost in a post-hoc stdout capture.
const FIXTURES: Record<string, Fixture> = {
  // OTel export with 100 spans — the original regression shape from
  // open-telemetry/opentelemetry-js#6221. Primary target for this driver.
  otel100: {
    schema: ExportTraceRequestSchema,
    build: buildExportTraceRequest,
    describe: "ExportTraceRequest with 100 spans, 10 attributes each",
  },
  // Metrics export — Gauge/Sum/Histogram mix, exercises the oneof fast
  // path and repeated bucket bounds.
  metrics50: {
    schema: ExportMetricsRequestSchema,
    build: buildExportMetricsRequest,
    describe: "ExportMetricsRequest with 50 series, mixed Gauge/Sum/Histogram",
  },
  // K8s Pod list — map-heavy payload, exercises the map encode path.
  k8s20: {
    schema: K8sPodListSchema,
    build: buildK8sPodList,
    describe: "K8sPodList with 20 pods, labels/annotations/limits/requests",
  },
  // Small baseline — RpcRequest, useful to compare per-call overhead.
  rpc: {
    schema: RpcRequestSchema,
    build: buildRpcRequest,
    describe: "RpcRequest baseline envelope",
  },
};

function resolveEncoder(
  name: string,
): (schema: AnySchema, msg: AnyMsg) => Uint8Array {
  switch (name) {
    case "toBinary":
      return toBinary;
    case "toBinaryFast":
      return toBinaryFast;
    default:
      throw new Error(
        `unknown encoder '${name}' — use 'toBinary' or 'toBinaryFast'`,
      );
  }
}

function main() {
  const fixture = FIXTURES[fixtureKey];
  if (!fixture) {
    console.error(
      `unknown fixture '${fixtureKey}'. available: ${Object.keys(FIXTURES).join(", ")}`,
    );
    process.exit(2);
  }
  const encoder = resolveEncoder(encoderName);

  console.log(
    `heap-prof driver: node=${process.version}, fixture=${fixtureKey}, encoder=${encoderName}, iterations=${iterations}`,
  );
  console.log(`workload: ${fixture.describe}`);

  // Pre-build the message so the encode walk is the dominant cost in the
  // sampled window. Building the message graph is also interesting but we
  // isolate here to make the top-N attribution readable — a future driver
  // variant could opt into `--include-build` to cover the combined path.
  const msg = fixture.build();

  // Warm the code paths once so IC polymorphism settles before the
  // measured run. The heap profiler samples proportionally to allocation
  // rate; an unwarmed run would over-weight monomorphic-cache-miss paths.
  encoder(fixture.schema, msg);

  // Hot loop. Kept as simple as possible so the sampled stacks point at
  // the encoder itself rather than at driver-internal helpers.
  for (let i = 0; i < iterations; i++) {
    encoder(fixture.schema, msg);
  }

  console.log(
    `done. .heapprofile will be written to --heap-prof-dir (default: CWD) on process exit.`,
  );
}

main();
