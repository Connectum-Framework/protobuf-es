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

// Streaming write benchmark (sizeDelimitedEncode).
//
// gRPC, Connect, and any length-prefixed framing protocol encodes each
// message in a stream with a size prefix: a varint (or 5-byte gRPC frame
// header for HTTP/2 transports). The per-message cost therefore includes
// both the encode walk and the allocation + copy of a prefix + body into
// the outbound buffer. `bench-toBinary.ts` measures the encode walk in
// isolation; this suite measures the streaming shape.
//
// We use `sizeDelimitedEncode` from `@bufbuild/protobuf/wire` because it is
// the closest public API to the length-prefixed frame used by gRPC/Connect
// servers, and it exercises the same `BinaryWriter.bytes()` path that
// `toBinary` uses internally for sub-messages. The absolute bytes differ
// from gRPC's 5-byte frame header (1 compression flag + 4 BE length) but
// the hot path is the same: encode the body once, then prefix it.
//
// Three stream shapes cover the realistic distribution:
//   - small:  100 RpcRequest messages (unary RPC chain)
//   - medium: 10 ExportTraceRequest batches × 100 spans each (OTel export)
//   - large:  5 K8sPodList chunks × 20 pods each (kubelet list pagination)
//
// Three encoders are compared per shape:
//   - reflective (toBinary + length prefix)
//   - fast (toBinaryFast + length prefix, L0+L1+L2 stack)
//   - protobufjs (ctor.encodeDelimited, ahead-of-time codegen, where loaded)
//
// The output is:
//   - a tinybench table printed to stdout
//   - `bench-streaming-results.json` written alongside `bench-results.json`
//     with per-case ops/sec, margin of error, total bytes per stream, and
//     implied throughput in MB/s. CI can diff the JSON in the usual way.

import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { toBinary, toBinaryFast } from "@bufbuild/protobuf";
import { BinaryWriter } from "@bufbuild/protobuf/wire";
import { Bench } from "tinybench";

import { ExportTraceRequestSchema } from "./gen/nested_pb.js";
import { K8sPodListSchema } from "./gen/k8s-pod_pb.js";
import { RpcRequestSchema } from "./gen/rpc-simple_pb.js";

import {
  buildExportTraceRequest,
  buildK8sPodList,
  buildRpcRequest,
  SPAN_COUNT,
  K8S_POD_COUNT,
} from "./fixtures.js";

// --- protobufjs loader -----------------------------------------------------
//
// We reuse the same per-fixture pbjs modules the rest of the suite loads.
// Each `.cjs` module is generated with a distinct `--root` name so sibling
// modules don't stomp each other's registered types; loading through
// `createRequire` keeps the `protobufjs/minimal` singleton intact.

const require = createRequire(import.meta.url);

interface PbjsCtor {
  create(properties: Record<string, unknown>): Record<string, unknown>;
  encode(message: Record<string, unknown>): { finish(): Uint8Array };
  encodeDelimited(
    message: Record<string, unknown>,
    writer?: unknown,
  ): { finish(): Uint8Array };
}

function loadPbjsCtor(
  modulePath: string,
  messagePath: string,
): PbjsCtor | null {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: generated pbjs has dynamic shape
    const mod = require(modulePath) as any;
    // biome-ignore lint/suspicious/noExplicitAny: dynamic walk through namespace tree
    let cursor: any = mod;
    for (const part of ["bench", "v1", ...messagePath.split(".")]) {
      if (cursor == null) return null;
      cursor = cursor[part];
    }
    return (cursor as PbjsCtor) ?? null;
  } catch (err) {
    console.warn(
      `pbjs: failed to load ${modulePath}: ${(err as Error).message}`,
    );
    return null;
  }
}

// --- fixture streams -------------------------------------------------------
//
// Each stream is a pre-built array of messages that the benchmark encodes
// back-to-back in one iteration. Building the messages outside the hot
// loop keeps the measurement focused on the encode + prefix path, not on
// the fixture builders (which are themselves already covered by
// `bench-create.ts`).

const SMALL_STREAM_LEN = 100;
const MEDIUM_STREAM_LEN = 10;
const LARGE_STREAM_LEN = 5;

// biome-ignore lint/suspicious/noExplicitAny: stream dispatch is intentionally loose
type AnySchema = any;
// biome-ignore lint/suspicious/noExplicitAny: stream dispatch is intentionally loose
type AnyMsg = any;

interface StreamShape {
  /** Short human label for the stream. */
  label: string;
  /** One-line description of the workload the stream models. */
  shape: string;
  /** Schema used by protobuf-es encoders. */
  schema: AnySchema;
  /** Pre-built array of protobuf-es messages. */
  esMessages: AnyMsg[];
  /** pbjs constructor + pre-built messages, or `null` if pbjs is unavailable. */
  pbjs: {
    ctor: PbjsCtor;
    messages: Record<string, unknown>[];
  } | null;
  /** Count used for reporting (pulled out so labels stay stable). */
  streamLen: number;
}

// --- pbjs init builders ----------------------------------------------------
//
// Each builder mirrors the matching `fixtures.ts` shape but in the flat
// oneof / string-int64 form that pbjs expects. Kept inline so this file
// is self-contained for the streaming comparison; the main report reuses
// the equivalent builders in `report-pbjs.ts`.

function buildPbjsRpcRequest(): Record<string, unknown> {
  return {
    service: "example.api.v1.UserService",
    method: "GetUser",
    headers: {
      "x-request-id": "req-00000000-0000-0000-0000-000000000000",
      authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      "content-type": "application/grpc",
      "grpc-accept-encoding": "identity,gzip",
    },
    payload: new Uint8Array(256).fill(0xab),
    requestId: "81985529216486895",
    deadlineMs: "5000",
  };
}

function bytesFromSeed(seed: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = (seed + i) & 0xff;
  }
  return out;
}

function buildPbjsOtelTrace(): Record<string, unknown> {
  // Mirrors buildExportTraceRequest on the wire. Flattened oneof and
  // string-valued int64 fields so pbjs accepts it.
  const attributeDescriptors = [
    { key: "http.method", kind: "string" as const },
    { key: "http.url", kind: "string" as const },
    { key: "http.status_code", kind: "int" as const },
    { key: "http.user_agent", kind: "string" as const },
    { key: "net.peer.name", kind: "string" as const },
    { key: "net.peer.port", kind: "int" as const },
    { key: "service.name", kind: "string" as const },
    { key: "service.version", kind: "string" as const },
    { key: "error", kind: "bool" as const },
    { key: "rpc.system", kind: "string" as const },
  ];
  const spans = [] as Record<string, unknown>[];
  for (let i = 0; i < SPAN_COUNT; i++) {
    const attributes: Record<string, unknown>[] = [];
    for (let j = 0; j < attributeDescriptors.length; j++) {
      const d = attributeDescriptors[j];
      let value: Record<string, unknown>;
      if (d.kind === "string") {
        value = { stringValue: `value-${i}-${j}` };
      } else if (d.kind === "int") {
        value = { intValue: (200 + (j % 5)).toString() };
      } else {
        value = { boolValue: (i + j) % 7 === 0 };
      }
      attributes.push({ key: d.key, value });
    }
    spans.push({
      traceId: bytesFromSeed(i, 16),
      spanId: bytesFromSeed(i + 1, 8),
      name: `span-${i}`,
      startTimeUnixNano: (
        1_700_000_000_000_000_000n +
        BigInt(i) * 1000n
      ).toString(),
      endTimeUnixNano: (
        1_700_000_000_000_001_000n +
        BigInt(i) * 1000n
      ).toString(),
      attributes,
    });
  }
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            {
              key: "service.name",
              value: { stringValue: "bench-service" },
            },
            {
              key: "service.version",
              value: { stringValue: "1.0.0" },
            },
          ],
          labels: {
            env: "production",
            region: "us-east-1",
            cluster: "bench-cluster",
            az: "us-east-1a",
            tenant: "bench-tenant",
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

// --- stream builders -------------------------------------------------------

function buildSmallStream(): StreamShape {
  const esMessages = Array.from({ length: SMALL_STREAM_LEN }, () =>
    buildRpcRequest(),
  );
  const rpcCtor = loadPbjsCtor("./gen-protobufjs/rpc-simple.cjs", "RpcRequest");
  return {
    label: `small stream (${SMALL_STREAM_LEN} × RpcRequest)`,
    shape: "gRPC unary chain — per-call envelope with small header map",
    schema: RpcRequestSchema,
    esMessages,
    pbjs: rpcCtor
      ? {
          ctor: rpcCtor,
          messages: Array.from({ length: SMALL_STREAM_LEN }, () =>
            rpcCtor.create(buildPbjsRpcRequest()),
          ),
        }
      : null,
    streamLen: SMALL_STREAM_LEN,
  };
}

function buildMediumStream(): StreamShape {
  const esMessages = Array.from({ length: MEDIUM_STREAM_LEN }, () =>
    buildExportTraceRequest(),
  );
  const traceCtor = loadPbjsCtor(
    "./gen-protobufjs/nested.cjs",
    "ExportTraceRequest",
  );
  return {
    label: `medium stream (${MEDIUM_STREAM_LEN} × ExportTraceRequest, ${SPAN_COUNT} spans each)`,
    shape: "OTel export — batched span uploads, KV-heavy nested messages",
    schema: ExportTraceRequestSchema,
    esMessages,
    pbjs: traceCtor
      ? {
          ctor: traceCtor,
          messages: Array.from({ length: MEDIUM_STREAM_LEN }, () =>
            traceCtor.create(buildPbjsOtelTrace()),
          ),
        }
      : null,
    streamLen: MEDIUM_STREAM_LEN,
  };
}

function buildLargeStream(): StreamShape {
  const esMessages = Array.from({ length: LARGE_STREAM_LEN }, () =>
    buildK8sPodList(),
  );
  // K8s has a deeper init shape for pbjs; we skip pbjs on the large stream
  // rather than duplicate hundreds of lines from report-pbjs.ts here. The
  // intent of the large stream is primarily protobuf-es self-comparison
  // (toBinary vs toBinaryFast) on big payloads; pbjs parity is covered by
  // the main report for the same fixture, just without the streaming wrap.
  return {
    label: `large stream (${LARGE_STREAM_LEN} × K8sPodList, ${K8S_POD_COUNT} pods each)`,
    shape: "kubelet list pagination — map-heavy configuration payloads",
    schema: K8sPodListSchema,
    esMessages,
    pbjs: null,
    streamLen: LARGE_STREAM_LEN,
  };
}

// --- encoders --------------------------------------------------------------
//
// `sizeDelimitedEncode` in `@bufbuild/protobuf/wire` calls
// `new BinaryWriter().bytes(toBinary(...))` and returns the finished
// buffer per message. For the streaming benchmark we want one contiguous
// buffer covering the whole stream, not per-message allocations, because
// that matches what a gRPC transport does when batching writes on the
// socket. We reuse a single `BinaryWriter` across the stream and call
// `.bytes()` per message to prepend each length-prefixed body. That keeps
// the measurement honest: one allocation amortized across the stream.

function encodeStreamReflective(
  schema: AnySchema,
  messages: AnyMsg[],
): Uint8Array {
  const writer = new BinaryWriter();
  for (let i = 0; i < messages.length; i++) {
    writer.bytes(toBinary(schema, messages[i]));
  }
  return writer.finish();
}

function encodeStreamFast(schema: AnySchema, messages: AnyMsg[]): Uint8Array {
  const writer = new BinaryWriter();
  for (let i = 0; i < messages.length; i++) {
    writer.bytes(toBinaryFast(schema, messages[i]));
  }
  return writer.finish();
}

function encodeStreamPbjs(
  ctor: PbjsCtor,
  messages: Record<string, unknown>[],
): Uint8Array {
  // protobufjs exposes `encodeDelimited` which writes the varint length
  // prefix + body into the same writer. We thread one writer through the
  // stream by letting `encodeDelimited` fork+ldelim for every message,
  // yielding the exact same wire shape protobuf-es's sizeDelimitedEncode
  // produces (varint length + body). Seed with the first message so
  // `writer` is never undefined inside the loop — avoids a non-null
  // assertion at the finish() call and keeps biome happy.
  if (messages.length === 0) return new Uint8Array(0);
  let writer = ctor.encodeDelimited(messages[0]);
  for (let i = 1; i < messages.length; i++) {
    writer = ctor.encodeDelimited(messages[i], writer);
  }
  return writer.finish();
}

// --- bench runner ----------------------------------------------------------

interface StreamingResult {
  fixture: string;
  encoder: "toBinary" | "toBinaryFast" | "protobufjs";
  streamLen: number;
  bytes: number;
  opsPerSec: number;
  rme: number;
  samples: number;
  /** MB/s = (bytes * ops/sec) / 1024 / 1024. */
  mbPerSec: number;
}

async function runStreamingBench() {
  // Time budgets mirror bench-matrix: enough to converge on unpinned hosts
  // while keeping the full suite under a minute. Streaming cases are
  // inherently slower than single-message encode, so we use the same
  // defaults the matrix runner does; CI can override via env vars.
  const time = Number(process.env.BENCH_STREAMING_TIME) || 1500;
  const warmupTime = Number(process.env.BENCH_STREAMING_WARMUP) || 300;
  const bench = new Bench({ time, warmupTime });

  const streams: StreamShape[] = [
    buildSmallStream(),
    buildMediumStream(),
    buildLargeStream(),
  ];

  // Measure stream byte size once (all iterations produce the same bytes).
  const prepared = streams.map((s) => {
    const reflectiveBytes = encodeStreamReflective(s.schema, s.esMessages);
    const fastBytes = encodeStreamFast(s.schema, s.esMessages);
    // Parity check — if toBinary and toBinaryFast disagree on stream bytes
    // we are measuring different workloads. Log so CI flags it.
    if (reflectiveBytes.byteLength !== fastBytes.byteLength) {
      console.warn(
        `stream ${s.label}: toBinary=${reflectiveBytes.byteLength}B vs toBinaryFast=${fastBytes.byteLength}B — byte counts differ, investigate`,
      );
    }
    const pbjsBytes = s.pbjs
      ? encodeStreamPbjs(s.pbjs.ctor, s.pbjs.messages).byteLength
      : null;
    return { ...s, streamBytes: reflectiveBytes.byteLength, pbjsBytes };
  });

  for (const p of prepared) {
    bench.add(
      `${p.label} :: sizeDelimitedEncode via toBinary (${p.streamBytes} B)`,
      () => {
        encodeStreamReflective(p.schema, p.esMessages);
      },
    );
  }
  for (const p of prepared) {
    bench.add(
      `${p.label} :: sizeDelimitedEncode via toBinaryFast (${p.streamBytes} B)`,
      () => {
        encodeStreamFast(p.schema, p.esMessages);
      },
    );
  }
  for (const p of prepared) {
    const pbjs = p.pbjs;
    if (!pbjs) continue;
    bench.add(
      `${p.label} :: protobufjs encodeDelimited (${p.pbjsBytes} B)`,
      () => {
        encodeStreamPbjs(pbjs.ctor, pbjs.messages);
      },
    );
  }

  await bench.run();
  return { bench, prepared };
}

// --- results extraction + JSON output --------------------------------------

function collectResults(
  bench: Bench,
  prepared: (StreamShape & { streamBytes: number; pbjsBytes: number | null })[],
): StreamingResult[] {
  const out: StreamingResult[] = [];
  const streamByLabel = new Map(prepared.map((p) => [p.label, p]));
  for (const task of bench.tasks) {
    const match = task.name.match(/^(.*?) :: (.*?) \((\d+) B\)$/);
    if (!match) continue;
    const [, label, kind, bytesStr] = match;
    const stream = streamByLabel.get(label);
    if (!stream) continue;
    const encoder: StreamingResult["encoder"] = kind.includes(
      "via toBinaryFast",
    )
      ? "toBinaryFast"
      : kind.includes("via toBinary")
        ? "toBinary"
        : "protobufjs";
    const bytes = Number(bytesStr);
    const opsPerSec = task.result?.hz ?? 0;
    out.push({
      fixture: label,
      encoder,
      streamLen: stream.streamLen,
      bytes,
      opsPerSec,
      rme: task.result?.rme ?? 0,
      samples: task.result?.samples.length ?? 0,
      mbPerSec: (bytes * opsPerSec) / 1024 / 1024,
    });
  }
  return out;
}

// Render a compact markdown table grouped by stream shape. One row per
// encoder per stream. Keeps the output readable even when all three
// encoders land on the same fixture.
function renderMarkdownTable(results: StreamingResult[]): string {
  const header = [
    "| Stream | Encoder | Stream bytes | ops/sec | MB/s | ± (%) |",
    "| ------ | ------- | -----------: | ------: | ---: | ----: |",
  ];
  const body = results.map(
    (r) =>
      `| ${r.fixture} | ${r.encoder} | ${r.bytes.toLocaleString()} | ${r.opsPerSec.toFixed(0)} | ${r.mbPerSec.toFixed(1)} | ${r.rme.toFixed(1)} |`,
  );
  return [...header, ...body].join("\n");
}

// Run standalone: `tsx src/bench-streaming.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  const { bench, prepared } = await runStreamingBench();
  console.log("\n=== Streaming: stream sizes ===");
  console.table(
    prepared.map((p) => ({
      stream: p.label,
      "stream bytes": p.streamBytes,
      "pbjs bytes": p.pbjsBytes ?? "—",
      shape: p.shape,
    })),
  );
  console.log(
    "\n=== Streaming: sizeDelimitedEncode across encoders and shapes ===",
  );
  console.table(bench.table());

  const results = collectResults(bench, prepared);
  const payload = {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    timestamp: new Date().toISOString(),
    results,
  };
  const here = dirname(fileURLToPath(import.meta.url));
  const outPath = resolve(here, "../bench-streaming-results.json");
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`\nWrote ${outPath}`);
  console.log("\n=== Markdown summary ===\n");
  console.log(renderMarkdownTable(results));
}
