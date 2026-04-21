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

// Combined `create() + toBinary()` workload. This is the direct-construction
// path from the OTel regression investigation (Phase 3): build the message
// graph fresh every iteration, then serialize. Matches the end-to-end shape
// of an OTLP trace export call made once per batch.

import { Bench } from "tinybench";
import { create, toBinary } from "@bufbuild/protobuf";
import { SimpleMessageSchema } from "./gen/small_pb.js";
import {
  AnyValueSchema,
  ExportTraceRequestSchema,
  ResourceSpansSchema,
  ScopeSpansSchema,
  SpanSchema,
  KeyValueSchema,
  ResourceSchema,
  InstrumentationScopeSchema,
} from "./gen/nested_pb.js";
import { SPAN_COUNT } from "./fixtures.js";

export async function runCreateToBinaryBench() {
  const bench = new Bench({ time: 2000, warmupTime: 500 });

  bench.add("create() + toBinary() SimpleMessage", () => {
    const m = create(SimpleMessageSchema, {
      name: "bench-message",
      value: 42,
      enabled: true,
    });
    toBinary(SimpleMessageSchema, m);
  });

  bench.add(
    `create() + toBinary() ExportTraceRequest (${SPAN_COUNT} spans, OTel-like)`,
    () => {
      const spans = [] as ReturnType<typeof create<typeof SpanSchema>>[];
      for (let i = 0; i < SPAN_COUNT; i++) {
        const attrs = [] as ReturnType<typeof create<typeof KeyValueSchema>>[];
        for (let j = 0; j < 10; j++) {
          attrs.push(
            create(KeyValueSchema, {
              key: `k${j}`,
              value: create(AnyValueSchema, {
                value: { case: "stringValue", value: `v${i}-${j}` },
              }),
            }),
          );
        }
        spans.push(
          create(SpanSchema, {
            traceId: new Uint8Array(16),
            spanId: new Uint8Array(8),
            name: `span-${i}`,
            startTimeUnixNano: 1_700_000_000_000_000_000n,
            endTimeUnixNano: 1_700_000_000_000_001_000n,
            attributes: attrs,
          }),
        );
      }
      const scope = create(InstrumentationScopeSchema, {
        name: "@example/tracer",
        version: "1.0.0",
      });
      const resource = create(ResourceSchema, { attributes: [] });
      const req = create(ExportTraceRequestSchema, {
        resourceSpans: [
          create(ResourceSpansSchema, {
            resource,
            scopeSpans: [create(ScopeSpansSchema, { scope, spans })],
          }),
        ],
      });
      toBinary(ExportTraceRequestSchema, req);
    },
  );

  await bench.run();
  return bench;
}

// Run standalone: `tsx src/bench-create-toBinary.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  const bench = await runCreateToBinaryBench();
  console.log("\n=== create() + toBinary() combined workload ===");
  console.table(bench.table());
}
