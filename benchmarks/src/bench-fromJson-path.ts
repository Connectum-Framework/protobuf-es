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

// The "indirect" path — build a JSON-shaped plain object, stringify, then
// fromJsonString → toBinary. Included specifically because this exact
// pattern caused a 13x serialization regression in
// open-telemetry/opentelemetry-js#6221. Measuring it here makes the
// regression reproducible against protobuf-es versions and schema shapes.
//
// Also includes the `fromJson(plainObject)` path (no JSON.stringify
// intermediate) as the partial-fix midpoint: fewer traversals but still
// reflective parsing.

import { Bench } from "tinybench";
import { fromJsonString, fromJson, toBinary } from "@bufbuild/protobuf";
import { ExportTraceRequestSchema } from "./gen/nested_pb.js";
import { buildExportTraceRequestJsonShape, SPAN_COUNT } from "./fixtures.js";

export async function runFromJsonPathBench() {
  const bench = new Bench({ time: 2000, warmupTime: 500 });

  const jsonShape = buildExportTraceRequestJsonShape();
  // protobuf-es's fromJson expects Uint8Array bytes fields to be encoded
  // as base64 strings in JSON mode. Pre-encode once so we compare parse
  // paths without measuring base64 overhead per iteration.
  const jsonEncodedShape = deepEncodeBytesToBase64(jsonShape);
  const jsonString = JSON.stringify(jsonEncodedShape);

  bench.add(
    `fromJsonString + toBinary (${SPAN_COUNT} spans) — OTel #6221 shape`,
    () => {
      const msg = fromJsonString(ExportTraceRequestSchema, jsonString);
      toBinary(ExportTraceRequestSchema, msg);
    },
  );

  bench.add(
    `fromJson + toBinary (${SPAN_COUNT} spans) — plainObject path`,
    () => {
      const msg = fromJson(ExportTraceRequestSchema, jsonEncodedShape);
      toBinary(ExportTraceRequestSchema, msg);
    },
  );

  await bench.run();
  return bench;
}

// biome-ignore lint/suspicious/noExplicitAny: deep traversal of anonymous JSON
function deepEncodeBytesToBase64(value: any): any {
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }
  if (Array.isArray(value)) {
    return value.map(deepEncodeBytesToBase64);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      out[key] = deepEncodeBytesToBase64(value[key]);
    }
    return out;
  }
  return value;
}

// Run standalone: `tsx src/bench-fromJson-path.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  const bench = await runFromJsonPathBench();
  console.log("\n=== fromJson / fromJsonString + toBinary paths ===");
  console.table(bench.table());
}
