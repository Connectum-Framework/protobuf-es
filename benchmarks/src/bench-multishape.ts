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

// L3 multi-shape benchmark.
//
// Purpose: verify the core L3 claim — that alternating 3+ shapes through
// one schema is faster on the adaptive plan (variants graduate and each
// one is monomorphic on `msg[name]`) than on the generic L1+L2 plan (a
// single polymorphic plan that sees every shape's hidden class).
//
// Fixture: the `SimpleMessage` schema has 3 fields, which lets us sweep
// through exactly 3 distinct presence patterns (`{field1}`, `{field2}`,
// `{field3}`). We alternate them in strict round-robin to force the
// polymorphic property-read site to see all three shapes; V8 pushes it
// to 3-way polymorphic in the L1+L2 run, while in the L3 run each variant
// keeps its own monomorphic IC.
//
// The driver writes a JSON summary to stdout so `scripts/median-results.ts`
// and `scripts/compare-results.ts` can line-diff against `baselines/main.json`
// without shape-specific tooling.

import { Bench } from "tinybench";
import { toBinaryFast, create, toBinary } from "@bufbuild/protobuf";
import { SimpleMessageSchema } from "./gen/small_pb.js";
import { SpanSchema, KeyValueSchema, AnyValueSchema } from "./gen/nested_pb.js";

const ITERATIONS_WARMUP = 40; // well past L3_WARMUP=10 × 3 shapes

function buildShapes(): ReturnType<
  typeof create<typeof SimpleMessageSchema>
>[] {
  return [
    create(SimpleMessageSchema, {
      name: "the quick brown fox",
      value: 0,
      enabled: false,
    }),
    create(SimpleMessageSchema, {
      name: "",
      value: 0x6bad_f00d,
      enabled: false,
    }),
    create(SimpleMessageSchema, {
      name: "",
      value: 0,
      enabled: true,
    }),
  ];
}

/**
 * Three Span shapes with different presence patterns — mirrors the
 * three-shape OTel pattern called out in the L3 design spec (full /
 * event / error).
 */
function buildSpanShapes(): ReturnType<typeof create<typeof SpanSchema>>[] {
  const kv = (k: string, v: string) =>
    create(KeyValueSchema, {
      key: k,
      value: create(AnyValueSchema, {
        value: { case: "stringValue", value: v },
      }),
    });
  const traceId = new Uint8Array(16).fill(0x11);
  const spanId = new Uint8Array(8).fill(0x22);
  return [
    // Full-shape: all scalar + a short attrs list.
    create(SpanSchema, {
      traceId,
      spanId,
      name: "GET /v1/users",
      startTimeUnixNano: 1_700_000_000_000_000_000n,
      endTimeUnixNano: 1_700_000_001_000_000_000n,
      attributes: [kv("http.method", "GET"), kv("http.status_code", "200")],
    }),
    // Short-shape: no attrs, only IDs + timestamps (status/health spans).
    create(SpanSchema, {
      traceId,
      spanId,
      name: "healthcheck",
      startTimeUnixNano: 1_700_000_000_000_000_000n,
      endTimeUnixNano: 1_700_000_000_500_000_000n,
      attributes: [],
    }),
    // Error-shape: IDs + timestamp + attrs, no name (empty string omitted).
    create(SpanSchema, {
      traceId,
      spanId,
      name: "",
      startTimeUnixNano: 1_700_000_000_000_000_000n,
      endTimeUnixNano: 1_700_000_000_100_000_000n,
      attributes: [
        kv("error", "true"),
        kv("error.type", "timeout"),
        kv("error.message", "upstream deadline exceeded"),
      ],
    }),
  ];
}

async function main(): Promise<void> {
  const time = Number(process.env.BENCH_MATRIX_TIME ?? 1500);
  const warmupTime = Number(process.env.BENCH_MATRIX_WARMUP ?? 300);
  const bench = new Bench({ time, warmupTime });

  const shapes = buildShapes();
  const spans = buildSpanShapes();

  // Byte-parity sanity (fail fast before the measurement phase).
  for (const s of shapes) {
    const ref = toBinary(SimpleMessageSchema, s);
    const adaptive = toBinaryFast(SimpleMessageSchema, s, { adaptive: true });
    const generic = toBinaryFast(SimpleMessageSchema, s);
    if (
      ref.length !== adaptive.length ||
      ref.length !== generic.length ||
      !ref.every((b, i) => b === adaptive[i] && b === generic[i])
    ) {
      throw new Error(
        "bench-multishape: SimpleMessage byte parity check failed",
      );
    }
  }
  for (const s of spans) {
    const ref = toBinary(SpanSchema, s);
    const adaptive = toBinaryFast(SpanSchema, s, { adaptive: true });
    if (
      ref.length !== adaptive.length ||
      !ref.every((b, i) => b === adaptive[i])
    ) {
      throw new Error("bench-multishape: Span byte parity check failed");
    }
  }

  // Prime the observer: ensures variants are graduated before measurement.
  for (let i = 0; i < ITERATIONS_WARMUP; i++) {
    for (const s of shapes) {
      toBinaryFast(SimpleMessageSchema, s, { adaptive: true });
    }
    for (const s of spans) {
      toBinaryFast(SpanSchema, s, { adaptive: true });
    }
  }

  bench.add("SimpleMessage multi-shape :: L1+L2 generic", () => {
    toBinaryFast(SimpleMessageSchema, shapes[0]);
    toBinaryFast(SimpleMessageSchema, shapes[1]);
    toBinaryFast(SimpleMessageSchema, shapes[2]);
  });
  bench.add("SimpleMessage multi-shape :: L3 adaptive", () => {
    toBinaryFast(SimpleMessageSchema, shapes[0], { adaptive: true });
    toBinaryFast(SimpleMessageSchema, shapes[1], { adaptive: true });
    toBinaryFast(SimpleMessageSchema, shapes[2], { adaptive: true });
  });
  // Single-shape regression gate: run the same shape 3× per op so the
  // per-op cost comparison stays apples-to-apples.
  bench.add("SimpleMessage single-shape :: L1+L2 generic", () => {
    toBinaryFast(SimpleMessageSchema, shapes[0]);
    toBinaryFast(SimpleMessageSchema, shapes[0]);
    toBinaryFast(SimpleMessageSchema, shapes[0]);
  });
  bench.add("SimpleMessage single-shape :: L3 adaptive", () => {
    toBinaryFast(SimpleMessageSchema, shapes[0], { adaptive: true });
    toBinaryFast(SimpleMessageSchema, shapes[0], { adaptive: true });
    toBinaryFast(SimpleMessageSchema, shapes[0], { adaptive: true });
  });

  // Span multi-shape. More fields + repeated attrs give the L3 variant
  // more `isFieldSet` checks to skip per op.
  bench.add("Span multi-shape :: L1+L2 generic", () => {
    toBinaryFast(SpanSchema, spans[0]);
    toBinaryFast(SpanSchema, spans[1]);
    toBinaryFast(SpanSchema, spans[2]);
  });
  bench.add("Span multi-shape :: L3 adaptive", () => {
    toBinaryFast(SpanSchema, spans[0], { adaptive: true });
    toBinaryFast(SpanSchema, spans[1], { adaptive: true });
    toBinaryFast(SpanSchema, spans[2], { adaptive: true });
  });
  bench.add("Span single-shape :: L1+L2 generic", () => {
    toBinaryFast(SpanSchema, spans[0]);
    toBinaryFast(SpanSchema, spans[0]);
    toBinaryFast(SpanSchema, spans[0]);
  });
  bench.add("Span single-shape :: L3 adaptive", () => {
    toBinaryFast(SpanSchema, spans[0], { adaptive: true });
    toBinaryFast(SpanSchema, spans[0], { adaptive: true });
    toBinaryFast(SpanSchema, spans[0], { adaptive: true });
  });

  await bench.run();

  const rows = bench.tasks.map((t) => ({
    name: t.name,
    opsPerSec: t.result?.hz ?? 0,
    rme: t.result?.rme ?? 0,
    samples: t.result?.samples.length ?? 0,
  }));

  // Emit table for eyeballing.
  console.table(
    rows.map((r) => ({
      name: r.name,
      "ops/s": r.opsPerSec.toFixed(0),
      "rme %": r.rme.toFixed(2),
      samples: r.samples,
    })),
  );

  // Emit JSON for scripts/compare-results.ts.
  console.log(
    JSON.stringify(
      {
        fixture: "multishape",
        generatedAt: new Date().toISOString(),
        node: process.version,
        rows,
      },
      null,
      2,
    ),
  );

  // Compute deltas so the run self-reports its gates.
  const get = (name: string): number =>
    rows.find((r) => r.name === name)?.opsPerSec ?? 0;
  const delta = (baseline: string, current: string): number => {
    const b = get(baseline);
    const c = get(current);
    return b > 0 ? c / b - 1 : 0;
  };
  const multiSimple = delta(
    "SimpleMessage multi-shape :: L1+L2 generic",
    "SimpleMessage multi-shape :: L3 adaptive",
  );
  const singleSimple = delta(
    "SimpleMessage single-shape :: L1+L2 generic",
    "SimpleMessage single-shape :: L3 adaptive",
  );
  const multiSpan = delta(
    "Span multi-shape :: L1+L2 generic",
    "Span multi-shape :: L3 adaptive",
  );
  const singleSpan = delta(
    "Span single-shape :: L1+L2 generic",
    "Span single-shape :: L3 adaptive",
  );

  console.log(
    `\nSimpleMessage multi-shape:   ${(multiSimple * 100).toFixed(2)} %  (target >= +10%)`,
  );
  console.log(
    `SimpleMessage single-shape:  ${(singleSimple * 100).toFixed(2)} %  (regression <= 3%)`,
  );
  console.log(
    `Span multi-shape:            ${(multiSpan * 100).toFixed(2)} %  (target >= +10%)`,
  );
  console.log(
    `Span single-shape:           ${(singleSpan * 100).toFixed(2)} %  (regression <= 3%)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
