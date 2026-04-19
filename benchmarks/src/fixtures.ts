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
// ~10 attributes per span, short ASCII keys and values.
function buildAttributes(spanIdx: number) {
  const out = [] as ReturnType<typeof create<typeof KeyValueSchema>>[];
  const keys = [
    "http.method",
    "http.url",
    "http.status_code",
    "http.user_agent",
    "net.peer.name",
    "net.peer.port",
    "service.name",
    "service.version",
    "deployment.environment",
    "rpc.system",
  ];
  for (let i = 0; i < keys.length; i++) {
    out.push(
      create(KeyValueSchema, {
        key: keys[i],
        stringValue: `value-${spanIdx}-${i}`,
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
        stringValue: "bench-service",
      }),
      create(KeyValueSchema, {
        key: "service.version",
        stringValue: "1.0.0",
      }),
    ],
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
  const attributeKeys = [
    "http.method",
    "http.url",
    "http.status_code",
    "http.user_agent",
    "net.peer.name",
    "net.peer.port",
    "service.name",
    "service.version",
    "deployment.environment",
    "rpc.system",
  ];
  for (let i = 0; i < SPAN_COUNT; i++) {
    const attributes: unknown[] = [];
    for (let j = 0; j < attributeKeys.length; j++) {
      attributes.push({
        key: attributeKeys[j],
        stringValue: `value-${i}-${j}`,
      });
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
            { key: "service.name", stringValue: "bench-service" },
            { key: "service.version", stringValue: "1.0.0" },
          ],
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
