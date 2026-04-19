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

// Parsing benchmarks — symmetric counterpart of bench-toBinary.ts.
// Pre-encodes a payload once, then measures the cost of the reflective
// `fromBinary` walk on the resulting bytes. Isolates decoder hot-path
// work (varint decoding, UTF-8 decode, nested message construction).
//
// Useful because protobuf-es performance arguments often focus only on
// the encode path — but most RPC servers are dominated by the decode
// side (one encoded request per RPC, one or more decoded fields
// traversed by application code).

import { Bench } from "tinybench";
import { toBinary, fromBinary } from "@bufbuild/protobuf";
import { SimpleMessageSchema } from "./gen/small_pb.js";
import { ExportTraceRequestSchema } from "./gen/nested_pb.js";
import {
  buildSmallMessage,
  buildExportTraceRequest,
  SPAN_COUNT,
} from "./fixtures.js";

export async function runFromBinaryBench() {
  const bench = new Bench({ time: 2000, warmupTime: 500 });

  // Encode once outside the measurement window so the hot loop is just
  // the decoder walk — no allocation of the source message graph, no
  // re-encoding work per iteration.
  const smallBytes = toBinary(SimpleMessageSchema, buildSmallMessage());
  const traceBytes = toBinary(
    ExportTraceRequestSchema,
    buildExportTraceRequest(),
  );

  bench.add(`fromBinary() SimpleMessage (${smallBytes.byteLength} B)`, () => {
    fromBinary(SimpleMessageSchema, smallBytes);
  });

  bench.add(
    `fromBinary() ExportTraceRequest (${SPAN_COUNT} spans, ${traceBytes.byteLength} B)`,
    () => {
      fromBinary(ExportTraceRequestSchema, traceBytes);
    },
  );

  await bench.run();
  return bench;
}

// Run standalone: `tsx src/bench-fromBinary.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  const bench = await runFromBinaryBench();
  console.log("\n=== fromBinary() parsing cost ===");
  console.table(bench.table());
}
