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

// Isolates the cost of `toBinary(Schema, message)` on PRE-BUILT messages.
// Messages are constructed once outside the measurement loop so this
// reflects the reflective binary encoder cost in isolation.

import { Bench } from "tinybench";
import { toBinary, toBinary as toBinaryFast } from "@bufbuild/protobuf";
import { SimpleMessageSchema } from "./gen/small_pb.js";
import { ExportTraceRequestSchema } from "./gen/nested_pb.js";
import {
  buildSmallMessage,
  buildExportTraceRequest,
  SPAN_COUNT,
} from "./fixtures.js";

export async function runToBinaryBench() {
  const bench = new Bench({ time: 2000, warmupTime: 500 });

  const small = buildSmallMessage();
  const traceRequest = buildExportTraceRequest();

  bench.add("toBinary() SimpleMessage (pre-built)", () => {
    toBinary(SimpleMessageSchema, small);
  });

  bench.add(
    `toBinary() ExportTraceRequest (pre-built, ${SPAN_COUNT} spans)`,
    () => {
      toBinary(ExportTraceRequestSchema, traceRequest);
    },
  );

  bench.add("toBinaryFast() SimpleMessage (pre-built)", () => {
    toBinaryFast(SimpleMessageSchema, small);
  });

  bench.add(
    `toBinaryFast() ExportTraceRequest (pre-built, ${SPAN_COUNT} spans)`,
    () => {
      toBinaryFast(ExportTraceRequestSchema, traceRequest);
    },
  );

  await bench.run();
  return bench;
}

// Run standalone: `tsx src/bench-toBinary.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  const bench = await runToBinaryBench();
  console.log("\n=== toBinary() cost on pre-built messages ===");
  console.table(bench.table());
}
