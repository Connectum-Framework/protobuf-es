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

// Matrix benchmark runner.
//
// Runs each realistic fixture through the `toBinary` + `fromBinary` path
// and reports a combined table. Unlike bench-toBinary / bench-fromBinary
// which focus on a single shape in depth, bench-matrix is the "spread"
// view — useful for spotting whether a regression lands on one class of
// payloads (e.g. map-heavy k8s) vs another (e.g. deep nesting stress).
//
// Fixtures covered (see fixtures.ts and proto/ for the shapes):
//   - SimpleMessage          — 3 scalar fields, baseline per-call cost
//   - ExportTraceRequest     — OTel traces (existing fixture)
//   - ExportMetricsRequest   — OTel metrics: Gauge/Sum/Histogram mix
//   - ExportLogsRequest      — OTel logs: LogRecord batch
//   - K8sPodList             — Kubernetes: map-heavy configuration payload
//   - GraphQLRequest         — GraphQL query + variables (JSON-in-bytes)
//   - GraphQLResponse        — GraphQL response payload
//   - RpcRequest/RpcResponse — baseline RPC envelope
//   - StressMessage          — synthetic: deep nesting + all scalar types
//
// Output format: tinybench table + JSON dump to stdout (for CI). Each row
// is a `<Fixture> / <Op>` pair so downstream tooling can diff across runs.

import { Bench } from "tinybench";
import { toBinary, fromBinary } from "@bufbuild/protobuf";

import { SimpleMessageSchema } from "./gen/small_pb.js";
import { ExportTraceRequestSchema } from "./gen/nested_pb.js";
import { ExportMetricsRequestSchema } from "./gen/otel-metrics_pb.js";
import { ExportLogsRequestSchema } from "./gen/otel-logs_pb.js";
import { K8sPodListSchema } from "./gen/k8s-pod_pb.js";
import {
  GraphQLRequestSchema,
  GraphQLResponseSchema,
} from "./gen/graphql_pb.js";
import { RpcRequestSchema, RpcResponseSchema } from "./gen/rpc-simple_pb.js";
import { StressMessageSchema } from "./gen/stress_pb.js";

import {
  buildSmallMessage,
  buildExportTraceRequest,
  buildExportMetricsRequest,
  buildExportLogsRequest,
  buildK8sPodList,
  buildGraphQLRequest,
  buildGraphQLResponse,
  buildRpcRequest,
  buildRpcResponse,
  buildStressMessage,
  SPAN_COUNT,
  METRICS_SERIES_COUNT,
  LOGS_RECORD_COUNT,
  K8S_POD_COUNT,
  STRESS_DEPTH,
  STRESS_ARRAY_WIDTH,
} from "./fixtures.js";

// GenMessage<T> is how protobuf-es ties a runtime schema to a message type.
// We accept `unknown` here and rely on tinybench to just call into the
// right callback; there's no actual type relationship that survives the
// matrix dispatch, so the inner cast is load-bearing.
// biome-ignore lint/suspicious/noExplicitAny: matrix dispatch is intentionally loose
type AnySchema = any;
// biome-ignore lint/suspicious/noExplicitAny: matrix dispatch is intentionally loose
type AnyMsg = any;

interface MatrixCase {
  name: string;
  schema: AnySchema;
  build: () => AnyMsg;
  /**
   * Short description of what makes this fixture distinctive — shown in
   * the summary so downstream readers can correlate a regression row with
   * the payload class without having to open fixtures.ts.
   */
  shape: string;
}

const cases: MatrixCase[] = [
  {
    name: "SimpleMessage",
    schema: SimpleMessageSchema,
    build: () => buildSmallMessage(),
    shape: "3 scalar fields, baseline per-call cost",
  },
  {
    name: `ExportTraceRequest (${SPAN_COUNT} spans)`,
    schema: ExportTraceRequestSchema,
    build: () => buildExportTraceRequest(),
    shape: "OTel traces: repeated nested KeyValue + fixed64 timestamps",
  },
  {
    name: `ExportMetricsRequest (${METRICS_SERIES_COUNT} series)`,
    schema: ExportMetricsRequestSchema,
    build: () => buildExportMetricsRequest(),
    shape: "OTel metrics: Gauge/Sum/Histogram oneof + buckets + bounds",
  },
  {
    name: `ExportLogsRequest (${LOGS_RECORD_COUNT} records)`,
    schema: ExportLogsRequestSchema,
    build: () => buildExportLogsRequest(),
    shape: "OTel logs: LogRecord batch, string body, trace/span IDs",
  },
  {
    name: `K8sPodList (${K8S_POD_COUNT} pods)`,
    schema: K8sPodListSchema,
    build: () => buildK8sPodList(),
    shape:
      "map-heavy: labels, annotations, limits, requests + repeated containers",
  },
  {
    name: "GraphQLRequest",
    schema: GraphQLRequestSchema,
    build: () => buildGraphQLRequest(),
    shape: "long query string + map<string,bytes> variables",
  },
  {
    name: "GraphQLResponse",
    schema: GraphQLResponseSchema,
    build: () => buildGraphQLResponse(),
    shape: "JSON-in-bytes data + errors with paths",
  },
  {
    name: "RpcRequest",
    schema: RpcRequestSchema,
    build: () => buildRpcRequest(),
    shape: "baseline RPC envelope: small map + 256-byte payload",
  },
  {
    name: "RpcResponse",
    schema: RpcResponseSchema,
    build: () => buildRpcResponse(),
    shape: "baseline RPC response: small map + 512-byte payload",
  },
  {
    name: `StressMessage (depth=${STRESS_DEPTH}, width=${STRESS_ARRAY_WIDTH})`,
    schema: StressMessageSchema,
    build: () => buildStressMessage(),
    shape: "synthetic: deep nesting + all scalar types + 4KB blob",
  },
];

export async function runMatrixBench() {
  const bench = new Bench({ time: 1000, warmupTime: 200 });

  // Pre-build every message + pre-encoded bytes outside the measurement
  // loop so the encoder/decoder benchmarks reflect the encode/decode walk
  // in isolation.
  const prepared = cases.map((c) => {
    const msg = c.build();
    const bytes = toBinary(c.schema, msg);
    return { ...c, msg, bytes };
  });

  for (const p of prepared) {
    bench.add(`${p.name} :: toBinary (pre-built, ${p.bytes.length} B)`, () => {
      toBinary(p.schema, p.msg);
    });
  }
  for (const p of prepared) {
    bench.add(`${p.name} :: fromBinary (${p.bytes.length} B)`, () => {
      fromBinary(p.schema, p.bytes);
    });
  }

  await bench.run();
  return { bench, prepared };
}

function summarize(
  bench: Bench,
): Array<{ name: string; opsPerSec: number; rme: number; samples: number }> {
  return bench.tasks.map((t) => ({
    name: t.name,
    // tinybench exposes hz (ops/sec) + rme (%) + samples count on the task
    // result. We serialize this to JSON so CI can diff runs deterministically.
    opsPerSec: t.result?.hz ?? 0,
    rme: t.result?.rme ?? 0,
    samples: t.result?.samples.length ?? 0,
  }));
}

// Run standalone: `tsx src/bench-matrix.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  const { bench, prepared } = await runMatrixBench();
  console.log("\n=== Matrix: encoded sizes ===");
  console.table(
    prepared.map((p) => ({
      fixture: p.name,
      bytes: p.bytes.length,
      shape: p.shape,
    })),
  );
  console.log("\n=== Matrix: toBinary + fromBinary across fixtures ===");
  console.table(bench.table());

  // Emit machine-readable JSON on the last line — consumable by CI diff
  // tooling without having to scrape the tinybench table.
  const payload = {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    timestamp: new Date().toISOString(),
    results: summarize(bench),
  };
  console.log("\n=== Matrix JSON ===");
  console.log(JSON.stringify(payload));
}
