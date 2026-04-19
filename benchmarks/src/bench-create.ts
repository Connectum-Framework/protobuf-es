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

// Isolates the cost of `create(Schema, init)` — message graph allocation
// without any serialization. Useful for comparing: small flat message vs
// nested OTLP-like tree where `create` is invoked per sub-message.

import { Bench } from "tinybench";
import { create } from "@bufbuild/protobuf";
import { SimpleMessageSchema } from "./gen/small_pb.js";
import {
  ExportTraceRequestSchema,
  ResourceSpansSchema,
  ScopeSpansSchema,
  SpanSchema,
  KeyValueSchema,
  ResourceSchema,
  InstrumentationScopeSchema,
} from "./gen/nested_pb.js";
import { SPAN_COUNT } from "./fixtures.js";

export async function runCreateBench() {
  const bench = new Bench({ time: 2000, warmupTime: 500 });

  bench.add("create() SimpleMessage (3 scalar fields)", () => {
    create(SimpleMessageSchema, {
      name: "bench-message",
      value: 42,
      enabled: true,
    });
  });

  // Nested: construct the full OTLP-like tree via repeated `create` calls.
  // This is the path used by the OTel direct-serializer experiment
  // (Phase 3 of otel-protobuf-regression analysis) — every sub-message
  // wrapped in create() because reflective toBinary relies on the
  // $typeName-tagged prototype set by create.
  bench.add(
    `create() ExportTraceRequest nested (${SPAN_COUNT} spans, 10 attrs each)`,
    () => {
      const spans = [] as ReturnType<typeof create<typeof SpanSchema>>[];
      for (let i = 0; i < SPAN_COUNT; i++) {
        const attrs = [] as ReturnType<typeof create<typeof KeyValueSchema>>[];
        for (let j = 0; j < 10; j++) {
          attrs.push(
            create(KeyValueSchema, {
              key: `k${j}`,
              stringValue: `v${i}-${j}`,
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
      create(ExportTraceRequestSchema, {
        resourceSpans: [
          create(ResourceSpansSchema, {
            resource,
            scopeSpans: [create(ScopeSpansSchema, { scope, spans })],
          }),
        ],
      });
    },
  );

  await bench.run();
  return bench;
}

// Run standalone: `tsx src/bench-create.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  const bench = await runCreateBench();
  console.log("\n=== create() cost ===");
  console.table(bench.table());
}
