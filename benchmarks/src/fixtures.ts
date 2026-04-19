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

import { create } from "@bufbuild/protobuf";
import { SimpleMessageSchema, type SimpleMessage } from "./gen/small_pb.js";
import {
  AnyValueSchema,
  ExportTraceRequestSchema,
  type ExportTraceRequest,
  KeyValueSchema,
  SpanSchema,
  ScopeSpansSchema,
  ResourceSpansSchema,
  ResourceSchema,
  InstrumentationScopeSchema,
} from "./gen/nested_pb.js";

// Shared fixture construction. Kept deterministic so benchmark runs are
// comparable: string lengths, attribute counts, and span counts are fixed.

export const SMALL_INIT = {
  name: "bench-message",
  value: 42,
  enabled: true,
} as const;

export function buildSmallMessage(): SimpleMessage {
  return create(SimpleMessageSchema, { ...SMALL_INIT });
}

// Produce a 16-byte Uint8Array deterministically from a numeric seed.
// Emulates the shape of trace IDs (16 bytes) / span IDs (8 bytes) without
// the cost of hex parsing — we care about the encoder path, not ID generation.
function bytes(seed: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = (seed + i) & 0xff;
  }
  return out;
}

// Mimics OTLP attribute cardinality in realistic trace exports:
// ~10 attributes per span, short ASCII keys, and a mix of AnyValue leaf
// types so that the oneof dispatch on the fast path gets exercised on
// every variant we encode in production (string dominates; bool, int,
// and double show up on status / error flags / durations).
function buildAttributes(spanIdx: number) {
  const out = [] as ReturnType<typeof create<typeof KeyValueSchema>>[];
  const descriptors = [
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
  for (let i = 0; i < descriptors.length; i++) {
    const d = descriptors[i];
    let anyInit: Parameters<typeof create<typeof AnyValueSchema>>[1];
    if (d.kind === "string") {
      anyInit = {
        value: { case: "stringValue", value: `value-${spanIdx}-${i}` },
      };
    } else if (d.kind === "int") {
      anyInit = {
        value: { case: "intValue", value: BigInt(200 + (i % 5)) },
      };
    } else {
      anyInit = {
        value: { case: "boolValue", value: (spanIdx + i) % 7 === 0 },
      };
    }
    out.push(
      create(KeyValueSchema, {
        key: d.key,
        value: create(AnyValueSchema, anyInit),
      }),
    );
  }
  return out;
}

// Build a single Span matching the OTLP ExportTraceServiceRequest.Span shape
// we use in bench-create-toBinary.ts. Not a literal copy of opentelemetry.proto;
// see benchmarks/proto/nested.proto for the simplified schema used here.
function buildSpan(i: number) {
  return create(SpanSchema, {
    traceId: bytes(i, 16),
    spanId: bytes(i + 1, 8),
    name: `span-${i}`,
    startTimeUnixNano: 1_700_000_000_000_000_000n + BigInt(i) * 1000n,
    endTimeUnixNano: 1_700_000_000_000_001_000n + BigInt(i) * 1000n,
    attributes: buildAttributes(i),
  });
}

// OTLP-like payload with SPAN_COUNT spans grouped under a single
// resource + scope. Matches the shape produced by a real OTLP exporter
// batching spans from one process.
export const SPAN_COUNT = 100;

export function buildExportTraceRequest(): ExportTraceRequest {
  const spans = [] as ReturnType<typeof buildSpan>[];
  for (let i = 0; i < SPAN_COUNT; i++) {
    spans.push(buildSpan(i));
  }
  const scope = create(InstrumentationScopeSchema, {
    name: "@example/tracer",
    version: "1.0.0",
  });
  const scopeSpans = create(ScopeSpansSchema, { scope, spans });
  const resource = create(ResourceSchema, {
    attributes: [
      create(KeyValueSchema, {
        key: "service.name",
        value: create(AnyValueSchema, {
          value: { case: "stringValue", value: "bench-service" },
        }),
      }),
      create(KeyValueSchema, {
        key: "service.version",
        value: create(AnyValueSchema, {
          value: { case: "stringValue", value: "1.0.0" },
        }),
      }),
    ],
    // Exercise map<string,string> encoding on the fast path. Realistic
    // cardinality: a handful of per-process deployment labels.
    labels: {
      env: "production",
      region: "us-east-1",
      cluster: "bench-cluster",
      az: "us-east-1a",
      tenant: "bench-tenant",
    },
  });
  const resourceSpans = create(ResourceSpansSchema, {
    resource,
    scopeSpans: [scopeSpans],
  });
  return create(ExportTraceRequestSchema, {
    resourceSpans: [resourceSpans],
  });
}

// Plain-object shape accepted by `create(ExportTraceRequestSchema, init)` —
// no pre-wrapped messages. Used by the fromJson-path benchmark to emulate
// the pattern that produced the OTel regression (build JS object, stringify,
// re-parse via fromJsonString).
export function buildExportTraceRequestJsonShape() {
  const spans = [] as unknown[];
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
  for (let i = 0; i < SPAN_COUNT; i++) {
    const attributes: unknown[] = [];
    for (let j = 0; j < attributeDescriptors.length; j++) {
      const d = attributeDescriptors[j];
      let value: unknown;
      if (d.kind === "string") {
        value = { case: "stringValue", value: `value-${i}-${j}` };
      } else if (d.kind === "int") {
        value = { case: "intValue", value: (200 + (j % 5)).toString() };
      } else {
        value = { case: "boolValue", value: (i + j) % 7 === 0 };
      }
      attributes.push({ key: d.key, value });
    }
    spans.push({
      traceId: bytes(i, 16),
      spanId: bytes(i + 1, 8),
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
              value: { case: "stringValue", value: "bench-service" },
            },
            {
              key: "service.version",
              value: { case: "stringValue", value: "1.0.0" },
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
