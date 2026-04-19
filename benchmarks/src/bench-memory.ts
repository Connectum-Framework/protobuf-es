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

// Memory / allocation benchmark.
//
// Approach: force GC before and after a tight loop of N iterations of
// the workload and report (heapUsed_after - heapUsed_before) / N as the
// per-op heap delta. This is a coarse approximation — V8 allocates
// young-gen objects in TLABs that are free to V8-manage until a minor
// GC sweeps them — but it lets us compare libraries on the same host
// under the same conditions, which is the only claim we make here.
//
// Requires --expose-gc. Run:
//   node --expose-gc --import tsx src/bench-memory.ts
//   (or)
//   npm run bench:memory  (package.json wires --expose-gc)

import { create, toBinary, toBinaryFast, fromBinary } from "@bufbuild/protobuf";
import { ExportTraceRequestSchema } from "./gen/nested_pb.js";
import { SPAN_COUNT } from "./fixtures.js";

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// biome-ignore lint/suspicious/noExplicitAny: generated pbjs has dynamic shape
const pbjsMod = require("./gen-protobufjs/nested.cjs") as any;
const ExportTraceRequestJs = pbjsMod.bench.v1.ExportTraceRequest as {
  create(init: Record<string, unknown>): Record<string, unknown>;
  encode(msg: Record<string, unknown>): { finish(): Uint8Array };
  decode(bytes: Uint8Array): Record<string, unknown>;
};

const ITERATIONS = 1000;

function buildInit(): Record<string, unknown> {
  const spans = [] as unknown[];
  for (let i = 0; i < SPAN_COUNT; i++) {
    const attributes: unknown[] = [];
    for (let j = 0; j < 10; j++) {
      attributes.push({ key: `k${j}`, stringValue: `v${i}-${j}` });
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
        resource: { attributes: [] },
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

function buildInitForPbjs(): Record<string, unknown> {
  const base = buildInit();
  // biome-ignore lint/suspicious/noExplicitAny: in-place shape munging
  const resourceSpans = (base.resourceSpans as any[])[0];
  for (const span of resourceSpans.scopeSpans[0].spans) {
    span.startTimeUnixNano = "1700000000000000000";
    span.endTimeUnixNano = "1700000000000001000";
  }
  return base;
}

interface MemSample {
  label: string;
  totalBytes: number;
  bytesPerOp: number;
  iterations: number;
}

function ensureGc(): () => void {
  if (typeof global.gc !== "function") {
    console.error(
      "bench-memory requires --expose-gc. Run with `node --expose-gc --import tsx ...` or `npm run bench:memory`.",
    );
    process.exit(1);
  }
  return global.gc;
}

function measure(label: string, body: () => void): MemSample {
  const gc = ensureGc();
  // Warm the code paths once so shape transitions settle before
  // the measured run. Otherwise first-call IC pollution adds noise.
  body();
  gc();
  gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < ITERATIONS; i++) {
    body();
  }
  const after = process.memoryUsage().heapUsed;
  const totalBytes = Math.max(0, after - before);
  return {
    label,
    totalBytes,
    bytesPerOp: totalBytes / ITERATIONS,
    iterations: ITERATIONS,
  };
}

async function main() {
  console.log(
    `memory bench — Node ${process.version}, ${ITERATIONS} iterations per case`,
  );
  console.log(
    "Approach: heapUsed delta after forced GC. Directional, not exact.",
  );

  const initEs = buildInit();
  const initPbjs = buildInitForPbjs();
  const preEncoded = toBinary(
    ExportTraceRequestSchema,
    create(ExportTraceRequestSchema, initEs),
  );
  const preEncodedPbjs = ExportTraceRequestJs.encode(
    ExportTraceRequestJs.create(initPbjs),
  ).finish();

  const samples: MemSample[] = [];

  samples.push(
    measure(
      `protobuf-es: create + toBinary (${SPAN_COUNT} spans)`,
      () => {
        const msg = create(ExportTraceRequestSchema, initEs);
        toBinary(ExportTraceRequestSchema, msg);
      },
    ),
  );

  samples.push(
    measure(
      `protobuf-es: create + toBinaryFast (${SPAN_COUNT} spans)`,
      () => {
        const msg = create(ExportTraceRequestSchema, initEs);
        toBinaryFast(ExportTraceRequestSchema, msg);
      },
    ),
  );

  samples.push(
    measure(`protobufjs: create + encode (${SPAN_COUNT} spans)`, () => {
      const msg = ExportTraceRequestJs.create(initPbjs);
      ExportTraceRequestJs.encode(msg).finish();
    }),
  );

  samples.push(
    measure(
      `protobuf-es: fromBinary (${SPAN_COUNT} spans, ${preEncoded.byteLength} B)`,
      () => {
        fromBinary(ExportTraceRequestSchema, preEncoded);
      },
    ),
  );

  samples.push(
    measure(
      `protobufjs: decode (${SPAN_COUNT} spans, ${preEncodedPbjs.byteLength} B)`,
      () => {
        ExportTraceRequestJs.decode(preEncodedPbjs);
      },
    ),
  );

  console.log();
  console.table(
    samples.map((s) => ({
      Case: s.label,
      "Total heap delta (B)": s.totalBytes.toLocaleString(),
      "Bytes/op (avg)": Math.round(s.bytesPerOp).toLocaleString(),
      Iterations: s.iterations,
    })),
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
