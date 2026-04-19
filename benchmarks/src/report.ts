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

// Benchmark report generator.
//
// Runs a multi-encoder matrix (toBinary, toBinaryFast, protobufjs-where-
// generated) across the fixture set exposed by bench-matrix.ts, then emits:
//
//   1. bench-results.json — machine-readable raw data for CI diffing.
//   2. chart.svg          — grouped-bar SVG chart (log ops/sec per fixture).
//   3. README.md          — markdown table injected between the
//                            <!--BENCHMARK_TABLE_START/END--> markers.
//
// Inspired by the packages/bundle-size/src/report.ts pattern: read the raw
// stats, pass them through table+chart generators, write files next to the
// README. Unlike bundle-size which bundles TypeScript via esbuild on every
// run, we run tinybench — so this script takes tens of seconds even at the
// reduced 600ms-per-case setting below.
//
// Usage:
//   npm run bench:report -w @bufbuild/protobuf-benchmarks
//
// To re-render from an existing bench-results.json without re-running the
// benchmark (useful for iterating on the chart layout), set
// `BENCH_REPORT_READ_ONLY=1`.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { Bench } from "tinybench";
import { toBinary, toBinaryFast } from "@bufbuild/protobuf";

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

import {
  type BenchmarkResult,
  generateBenchmarkChart,
  generateBenchmarkMarkdownTable,
  injectTable,
} from "./report-helpers.js";

// biome-ignore lint/suspicious/noExplicitAny: matrix dispatch is loose by design
type AnySchema = any;
// biome-ignore lint/suspicious/noExplicitAny: matrix dispatch is loose by design
type AnyMsg = any;

interface FixtureCase {
  name: string;
  schema: AnySchema;
  build: () => AnyMsg;
}

const cases: FixtureCase[] = [
  {
    name: "SimpleMessage",
    schema: SimpleMessageSchema,
    build: buildSmallMessage,
  },
  {
    name: `ExportTraceRequest (${SPAN_COUNT} spans)`,
    schema: ExportTraceRequestSchema,
    build: buildExportTraceRequest,
  },
  {
    name: `ExportMetricsRequest (${METRICS_SERIES_COUNT} series)`,
    schema: ExportMetricsRequestSchema,
    build: buildExportMetricsRequest,
  },
  {
    name: `ExportLogsRequest (${LOGS_RECORD_COUNT} records)`,
    schema: ExportLogsRequestSchema,
    build: buildExportLogsRequest,
  },
  {
    name: `K8sPodList (${K8S_POD_COUNT} pods)`,
    schema: K8sPodListSchema,
    build: buildK8sPodList,
  },
  {
    name: "GraphQLRequest",
    schema: GraphQLRequestSchema,
    build: buildGraphQLRequest,
  },
  {
    name: "GraphQLResponse",
    schema: GraphQLResponseSchema,
    build: buildGraphQLResponse,
  },
  {
    name: "RpcRequest",
    schema: RpcRequestSchema,
    build: buildRpcRequest,
  },
  {
    name: "RpcResponse",
    schema: RpcResponseSchema,
    build: buildRpcResponse,
  },
  {
    name: `StressMessage (depth=${STRESS_DEPTH}, width=${STRESS_ARRAY_WIDTH})`,
    schema: StressMessageSchema,
    build: buildStressMessage,
  },
];

// protobufjs is only generated for nested.proto (the OTel traces shape),
// via the `generate:protobufjs` script. We still want it on the chart
// because it is the external baseline referenced in #6221; other fixtures
// simply leave the protobufjs bar missing, which the chart + table handle.
interface PbjsCtor {
  create(properties: Record<string, unknown>): Record<string, unknown>;
  encode(message: Record<string, unknown>): { finish(): Uint8Array };
}

function loadPbjsExportTraceRequest(): PbjsCtor | null {
  try {
    const require = createRequire(import.meta.url);
    // biome-ignore lint/suspicious/noExplicitAny: generated pbjs has dynamic shape
    const mod = require("./gen-protobufjs/nested.cjs") as any;
    return mod.bench.v1.ExportTraceRequest as PbjsCtor;
  } catch {
    // Missing codegen is non-fatal for the report — we just skip the
    // protobufjs bar. Running `npm run generate:protobufjs` remedies this.
    return null;
  }
}

/**
 * Construct a plain-JS init object for protobufjs's `ExportTraceRequest`.
 * Mirrors the init shape used in bench-comparison-protobufjs.ts, because
 * protobufjs accepts oneof fields on the parent message directly rather
 * than via the `{ case, value }` ADT protobuf-es uses — passing a
 * protobuf-es init object into pbjs silently produces an empty encode.
 */
function buildPbjsOtelInit(): Record<string, unknown> {
  const spans: unknown[] = [];
  for (let i = 0; i < SPAN_COUNT; i++) {
    const attributes: unknown[] = [];
    for (let j = 0; j < 10; j++) {
      let anyValue: Record<string, unknown>;
      if (j === 2 || j === 5) {
        anyValue = { intValue: (200 + j).toString() };
      } else if (j === 8) {
        anyValue = { boolValue: (i + j) % 7 === 0 };
      } else {
        anyValue = { stringValue: `v${i}-${j}` };
      }
      attributes.push({ key: `k${j}`, value: anyValue });
    }
    spans.push({
      traceId: new Uint8Array(16),
      spanId: new Uint8Array(8),
      name: `span-${i}`,
      startTimeUnixNano: "1700000000000000000",
      endTimeUnixNano: "1700000000000001000",
      attributes,
    });
  }
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [],
          labels: {
            env: "production",
            region: "us-east-1",
            cluster: "bench-cluster",
          },
        },
        scopeSpans: [
          {
            scope: { name: "@example/tracer", version: "1.0.0" },
            spans,
          },
        ],
      },
    ],
  };
}

/**
 * Run the matrix and return flat per-(fixture × encoder) rows.
 *
 * tinybench `time`/`warmupTime` here are intentionally tighter than the
 * main bench-matrix.ts (1000ms / 200ms) because the report runs 2–3x as
 * many cases as the matrix and we want it to finish in a single
 * development cycle. The noise floor is correspondingly higher; consumers
 * of the raw numbers should use bench-matrix.ts, not the report file.
 */
async function runReportBench(): Promise<BenchmarkResult[]> {
  const bench = new Bench({ time: 600, warmupTime: 150 });

  const prepared = cases.map((c) => {
    const msg = c.build();
    const bytes = toBinary(c.schema, msg);
    return { ...c, msg, bytes };
  });

  // protobuf-es encoders. We never change the schema/message references
  // inside the benchmark function body — that would pull allocation cost
  // into the measurement. Everything is captured in the closure once.
  for (const p of prepared) {
    bench.add(`${p.name} :: toBinary`, () => {
      toBinary(p.schema, p.msg);
    });
    bench.add(`${p.name} :: toBinaryFast`, () => {
      toBinaryFast(p.schema, p.msg);
    });
  }

  // protobufjs is only available for the OTel traces fixture. If the
  // CommonJS module is missing we quietly skip, which is handled
  // gracefully in the report output (table: "-", chart: no bar).
  const pbjs = loadPbjsExportTraceRequest();
  const pbjsFixtureName = `ExportTraceRequest (${SPAN_COUNT} spans)`;
  if (pbjs) {
    const init = buildPbjsOtelInit();
    const preBuilt = pbjs.create(init);
    bench.add(`${pbjsFixtureName} :: protobufjs`, () => {
      pbjs.encode(preBuilt).finish();
    });
  }

  await bench.run();

  // Flatten tinybench tasks into the BenchmarkResult shape. Task names
  // use the " :: " separator we constructed above — any future formatting
  // change must stay in sync here, which is why the split is load-bearing.
  const results: BenchmarkResult[] = [];
  for (const task of bench.tasks) {
    const separator = " :: ";
    const sepIdx = task.name.lastIndexOf(separator);
    if (sepIdx < 0) continue;
    const fixture = task.name.substring(0, sepIdx);
    const encoder = task.name.substring(sepIdx + separator.length);
    const prep = prepared.find((p) => p.name === fixture);
    const encodedSize = prep ? prep.bytes.length : 0;
    results.push({
      fixture,
      encoder,
      opsPerSec: task.result?.hz ?? 0,
      encodedSize,
    });
  }
  return results;
}

// --- main ------------------------------------------------------------------

const outDir = new URL("../", import.meta.url).pathname;
const resultsPath = `${outDir}bench-results.json`;
const chartPath = `${outDir}chart.svg`;
const readmePath = `${outDir}README.md`;

let results: BenchmarkResult[];
if (process.env.BENCH_REPORT_READ_ONLY === "1" && existsSync(resultsPath)) {
  // Re-render mode: useful while iterating on chart / table layout so the
  // author does not pay the ~30s benchmark cost for each rendering tweak.
  const raw = JSON.parse(readFileSync(resultsPath, "utf-8")) as {
    results: BenchmarkResult[];
  };
  results = raw.results;
  console.log(`Loaded ${results.length} results from ${resultsPath}`);
} else {
  console.log("Running benchmark matrix for report (this takes ~30s)...");
  results = await runReportBench();
  const payload = {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    timestamp: new Date().toISOString(),
    results,
  };
  writeFileSync(resultsPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`Wrote ${resultsPath}`);
}

// Build outputs. The chart and table see identical inputs, so any
// divergence between them is a layout bug in one of the generators.
const table = generateBenchmarkMarkdownTable(results);
injectTable(readmePath, table);
console.log(`Injected table into ${readmePath}`);

const chart = generateBenchmarkChart(results);
writeFileSync(chartPath, chart);
console.log(`Wrote ${chartPath}`);
