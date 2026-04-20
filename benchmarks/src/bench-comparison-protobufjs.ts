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

// Cross-library comparison: protobuf-es vs protobufjs on the same .proto
// fixture. Both libraries consume `proto/nested.proto` (OTLP-like). The
// protobufjs build uses pbjs static-module codegen so the measurements
// reflect the ahead-of-time encoder path (no Reflect/runtime descriptor
// lookups). This makes the comparison apples-to-apples against
// protobuf-es's reflective `toBinary`.
//
// Motivation: the OTel regression report
// (open-telemetry/opentelemetry-js#6221) attributed a ~13x serialization
// regression to protobuf-es adoption. Our earlier investigation measured a
// larger ~30x gap on a similar shape. This suite reproduces the
// comparison against a pinned protobufjs version on the same host so
// future protobuf-es changes can be tracked against a stable baseline.

import { Bench } from "tinybench";
import { create, toBinary, toBinary as toBinaryFast, fromBinary } from "@bufbuild/protobuf";
import { ExportTraceRequestSchema } from "./gen/nested_pb.js";
import { SPAN_COUNT } from "./fixtures.js";

// protobufjs is generated as CommonJS via pbjs static-module -w commonjs.
// The pbjs-generated module attaches the schema tree to $protobuf.roots
// via side effects, which requires a single shared `protobufjs/minimal`
// instance. Loading it via createRequire from ESM keeps that singleton
// intact and avoids the ESM namespace wrapping that breaks
// `$protobuf.roots["default"]`.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// biome-ignore lint/suspicious/noExplicitAny: generated pbjs has dynamic shape
const pbjsMod = require("./gen-protobufjs/nested.cjs") as any;

interface PbjsMessageCtor {
  create(properties: Record<string, unknown>): PbjsMessage;
  encode(message: PbjsMessage): PbjsWriter;
  decode(reader: Uint8Array): PbjsMessage;
}
type PbjsMessage = Record<string, unknown>;
interface PbjsWriter {
  finish(): Uint8Array;
}

const ExportTraceRequestJs = pbjsMod.bench.v1
  .ExportTraceRequest as PbjsMessageCtor;

// Plain JS init shared by both libraries. Values mirror buildOtelLikePayload
// in spirit; kept inline to make this file self-contained.
function buildOtelLikePayload(): Record<string, unknown> {
  const spans = [] as unknown[];
  for (let i = 0; i < SPAN_COUNT; i++) {
    const attributes: unknown[] = [];
    for (let j = 0; j < 10; j++) {
      // AnyValue oneof: mostly string, some int, some bool — matches the
      // distribution the fast-path benchmark feeds into the reflective
      // encoder via the same fixture.
      let anyValue: Record<string, unknown>;
      if (j === 2 || j === 5) {
        anyValue = { value: { case: "intValue", value: BigInt(200 + j) } };
      } else if (j === 8) {
        anyValue = { value: { case: "boolValue", value: (i + j) % 7 === 0 } };
      } else {
        anyValue = {
          value: { case: "stringValue", value: `v${i}-${j}` },
        };
      }
      attributes.push({ key: `k${j}`, value: anyValue });
    }
    spans.push({
      traceId: new Uint8Array(16),
      spanId: new Uint8Array(8),
      name: `span-${i}`,
      startTimeUnixNano: 1_700_000_000_000_000_000n,
      endTimeUnixNano: 1_700_000_000_000_001_000n,
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

// protobufjs uses Long for 64-bit fields by default. We generate with
// --force-long to get consistent typing; here we still pass BigInt-like
// plain numbers via strings so both paths encode the same timestamp.
// Prepare a payload variant for pbjs with:
//   - string timestamps (no JSON conversion cost inside the hot loop)
//   - AnyValue oneof represented as a plain field rather than the
//     `{ case, value }` ADT protobuf-es uses, because protobufjs stores
//     oneof members directly on the parent message.
function buildOtelLikePayloadForPbjs(): Record<string, unknown> {
  const base = buildOtelLikePayload();
  // biome-ignore lint/suspicious/noExplicitAny: in-place shape munging
  const resourceSpans = (base.resourceSpans as any[])[0];
  for (const span of resourceSpans.scopeSpans[0].spans) {
    span.startTimeUnixNano = "1700000000000000000";
    span.endTimeUnixNano = "1700000000000001000";
    // biome-ignore lint/suspicious/noExplicitAny: in-place shape munging
    for (const attr of span.attributes as any[]) {
      const adt = attr.value?.value as
        | { case: string; value: unknown }
        | undefined;
      if (adt) {
        const pbjsKey =
          adt.case === "intValue"
            ? "intValue"
            : adt.case === "boolValue"
              ? "boolValue"
              : "stringValue";
        // protobufjs also accepts int64 as string without Long.
        attr.value = {
          [pbjsKey]:
            adt.case === "intValue"
              ? (adt.value as bigint).toString()
              : adt.value,
        };
      }
    }
  }
  return base;
}

export async function runComparisonBench() {
  const bench = new Bench({ time: 2000, warmupTime: 500 });

  const initEs = buildOtelLikePayload();
  const initPbjs = buildOtelLikePayloadForPbjs();

  // --- Full roundtrip: create + encode
  bench.add(
    `protobuf-es: create+toBinary (${SPAN_COUNT} spans, OTel-like)`,
    () => {
      const msg = create(ExportTraceRequestSchema, initEs);
      toBinary(ExportTraceRequestSchema, msg);
    },
  );

  bench.add(
    `protobuf-es: create+toBinaryFast (${SPAN_COUNT} spans, OTel-like)`,
    () => {
      const msg = create(ExportTraceRequestSchema, initEs);
      toBinaryFast(ExportTraceRequestSchema, msg);
    },
  );

  bench.add(
    `protobufjs: create+encode (${SPAN_COUNT} spans, OTel-like)`,
    () => {
      const msg = ExportTraceRequestJs.create(initPbjs);
      ExportTraceRequestJs.encode(msg).finish();
    },
  );

  // --- Encode-only (pre-built messages) — fair comparison of encoder walk
  const esPrebuilt = create(ExportTraceRequestSchema, initEs);
  const pbjsPrebuilt = ExportTraceRequestJs.create(initPbjs);

  bench.add(`protobuf-es: toBinary pre-built (${SPAN_COUNT} spans)`, () => {
    toBinary(ExportTraceRequestSchema, esPrebuilt);
  });

  bench.add(`protobuf-es: toBinaryFast pre-built (${SPAN_COUNT} spans)`, () => {
    toBinaryFast(ExportTraceRequestSchema, esPrebuilt);
  });

  bench.add(`protobufjs: encode pre-built (${SPAN_COUNT} spans)`, () => {
    ExportTraceRequestJs.encode(pbjsPrebuilt).finish();
  });

  // --- Decode-only — pre-encode once, then measure parse path
  const encodedByEs = toBinary(ExportTraceRequestSchema, esPrebuilt);
  const encodedByPbjs = ExportTraceRequestJs.encode(pbjsPrebuilt).finish();

  bench.add(
    `protobuf-es: fromBinary (${SPAN_COUNT} spans, bytes from protobuf-es)`,
    () => {
      fromBinary(ExportTraceRequestSchema, encodedByEs);
    },
  );

  bench.add(
    `protobufjs: decode (${SPAN_COUNT} spans, bytes from protobufjs)`,
    () => {
      ExportTraceRequestJs.decode(encodedByPbjs);
    },
  );

  await bench.run();
  return bench;
}

// Run standalone: `tsx src/bench-comparison-protobufjs.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  const bench = await runComparisonBench();
  console.log("\n=== protobuf-es vs protobufjs ===");
  console.table(bench.table());
}
