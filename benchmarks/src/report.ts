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
// Runs a three-encoder matrix (upstream-protobuf-es, fork's toBinary,
// protobufjs) across the fixture set exposed by bench-matrix.ts, then emits:
//
//   1. bench-results.json — machine-readable raw data for CI diffing.
//   2. chart.svg          — grouped-bar SVG chart (log ops/sec per fixture)
//                            with numeric labels above each bar.
//   3. chart-delta.svg    — linear-scale bar chart showing the fork's
//                            `toBinary` percentage speedup over both
//                            baselines (upstream, protobufjs) per fixture.
//   4. README.md          — markdown table injected between the
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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { toBinary } from "@bufbuild/protobuf";
// `upstream-protobuf-es` is an npm alias for `@bufbuild/protobuf@latest`
// installed as a regular devDependency. This gives us the unmodified
// upstream encoder alongside the fork's in-tree copy in the same process,
// so the report can measure the honest cumulative gain from the original
// protobuf-es baseline (which predates the L0 contiguous-writer work in
// PR #8) instead of only showing the fork's current state in isolation.
import { toBinary as upstreamToBinary } from "upstream-protobuf-es";
import { Bench } from "tinybench";

import {
  GraphQLRequestSchema,
  GraphQLResponseSchema,
} from "./gen/graphql_pb.js";
import { K8sPodListSchema } from "./gen/k8s-pod_pb.js";
import { ExportTraceRequestSchema } from "./gen/nested_pb.js";
import { ExportLogsRequestSchema } from "./gen/otel-logs_pb.js";
import { ExportMetricsRequestSchema } from "./gen/otel-metrics_pb.js";
import { RpcRequestSchema, RpcResponseSchema } from "./gen/rpc-simple_pb.js";
import { SimpleMessageSchema } from "./gen/small_pb.js";
import { StressMessageSchema } from "./gen/stress_pb.js";

import {
  K8S_POD_COUNT,
  LOGS_RECORD_COUNT,
  METRICS_SERIES_COUNT,
  SPAN_COUNT,
  STRESS_ARRAY_WIDTH,
  STRESS_DEPTH,
  buildExportLogsRequest,
  buildExportMetricsRequest,
  buildExportTraceRequest,
  buildGraphQLRequest,
  buildGraphQLResponse,
  buildK8sPodList,
  buildRpcRequest,
  buildRpcResponse,
  buildSmallMessage,
  buildStressMessage,
} from "./fixtures.js";

import {
  type BenchmarkResult,
  generateBenchmarkChart,
  generateBenchmarkDeltaChart,
  generateBenchmarkMarkdownTable,
  injectTable,
} from "./report-helpers.js";

import { loadPbjsFixtures } from "./report-pbjs.js";

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
  //
  // The `upstream-protobuf-es` bar uses `@bufbuild/protobuf@latest` via
  // the aliased devDependency. The fork's generated schemas import from
  // the fork's `@bufbuild/protobuf`, but the descriptor protocol is
  // wire-compatible between the two v2 versions — upstream.toBinary
  // accepts the same schema/message pair and produces identical bytes.
  // That lets a single schema drive bars from both libraries, no
  // separate codegen needed.
  for (const p of prepared) {
    bench.add(`${p.name} :: upstream-protobuf-es`, () => {
      upstreamToBinary(p.schema, p.msg);
    });
    bench.add(`${p.name} :: toBinary`, () => {
      toBinary(p.schema, p.msg);
    });
  }

  // protobufjs bars are added per-fixture wherever the pbjs static-module
  // codegen is available. `loadPbjsFixtures` returns one entry per fixture
  // whose init object verify()s against the pbjs schema; missing stubs
  // produce a warning and leave that fixture's protobufjs cell empty, which
  // the chart and table already handle.
  const pbjsEntries = loadPbjsFixtures();
  const preparedNames = new Set(prepared.map((p) => p.name));
  for (const entry of pbjsEntries) {
    if (!preparedNames.has(entry.fixture)) {
      // Defensive: a fixture-name drift between `cases` and the pbjs
      // registry would silently pollute the chart. Warn loudly rather than
      // emit a row we cannot group.
      console.warn(
        `pbjs: fixture "${entry.fixture}" has no matching protobuf-es case; ` +
          `check report-pbjs.ts DESCRIPTORS vs report.ts cases`,
      );
      continue;
    }
    bench.add(`${entry.fixture} :: protobufjs`, () => {
      entry.encode();
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
const deltaChartPath = `${outDir}chart-delta.svg`;
const readmePath = `${outDir}README.md`;

let results: BenchmarkResult[];
if (process.env.BENCH_REPORT_READ_ONLY === "1" && existsSync(resultsPath)) {
  // Re-render mode: useful while iterating on chart / table layout so the
  // author does not pay the benchmark cost for each rendering tweak.
  const raw = JSON.parse(readFileSync(resultsPath, "utf-8")) as {
    results: BenchmarkResult[];
  };
  results = raw.results;
  console.log(`Loaded ${results.length} results from ${resultsPath}`);
} else {
  // Median-of-N runs to stabilize per-fixture numbers against host jitter.
  // Single-run measurements on small/fast fixtures (SimpleMessage, RPC
  // envelopes) easily vary by 2-8x across back-to-back runs on an
  // unpinned host; medians cancel that out. Override via
  // BENCH_REPORT_RUNS env var (default 5, min 1).
  const runsEnv = Number.parseInt(process.env.BENCH_REPORT_RUNS ?? "5", 10);
  const runs = Number.isFinite(runsEnv) && runsEnv > 0 ? runsEnv : 5;
  console.log(
    `Running benchmark matrix for report (${runs} runs × ~30s each, median aggregated)...`,
  );
  const runResults: BenchmarkResult[][] = [];
  for (let i = 0; i < runs; i++) {
    console.log(`  run ${i + 1}/${runs}`);
    runResults.push(await runReportBench());
  }
  // Median per (fixture, encoder) pair. encodedSize is identical across
  // runs for the same fixture/encoder, so first occurrence wins.
  const keyed = new Map<string, { ops: number[]; encodedSize: number }>();
  for (const run of runResults) {
    for (const r of run) {
      const key = `${r.fixture}::${r.encoder}`;
      const bucket = keyed.get(key);
      if (bucket) {
        bucket.ops.push(r.opsPerSec);
      } else {
        keyed.set(key, { ops: [r.opsPerSec], encodedSize: r.encodedSize });
      }
    }
  }
  const firstRunOrder = runResults[0];
  results = firstRunOrder.map((r) => {
    const key = `${r.fixture}::${r.encoder}`;
    const bucket = keyed.get(key);
    const sorted = bucket ? [...bucket.ops].sort((a, b) => a - b) : [];
    const median =
      sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)];
    return {
      fixture: r.fixture,
      encoder: r.encoder,
      opsPerSec: median,
      encodedSize: bucket?.encodedSize ?? r.encodedSize,
    };
  });
  const payload = {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    timestamp: new Date().toISOString(),
    runs,
    results,
  };
  writeFileSync(resultsPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`Wrote ${resultsPath} (median of ${runs} runs)`);
}

// Build outputs. The chart and table see identical inputs, so any
// divergence between them is a layout bug in one of the generators.
const table = generateBenchmarkMarkdownTable(results);
injectTable(readmePath, table);
console.log(`Injected table into ${readmePath}`);

const chart = generateBenchmarkChart(results);
writeFileSync(chartPath, chart);
console.log(`Wrote ${chartPath}`);

// Delta chart: linear-scale view of the fork's `toBinary` (L0) %
// improvement over the upstream @bufbuild/protobuf baseline, with an
// optional protobufjs comparison where the bar is available. Log-scale
// charts hide the absolute magnitude of the gain on shape-specific bars
// that already render close to each other on the main chart; the delta
// chart is the one consumers should look at when they want "how much
// faster than original protobuf-es, in plain terms".
const deltaChart = generateBenchmarkDeltaChart(results);
writeFileSync(deltaChartPath, deltaChart);
console.log(`Wrote ${deltaChartPath}`);
