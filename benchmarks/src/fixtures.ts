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
import {
  ExportMetricsRequestSchema,
  type ExportMetricsRequest,
  GaugeSchema,
  HistogramDataPointSchema,
  HistogramSchema,
  MetricAnyValueSchema,
  MetricInstrumentationScopeSchema,
  MetricKeyValueSchema,
  MetricResourceSchema,
  MetricSchema,
  NumberDataPointSchema,
  ResourceMetricsSchema,
  ScopeMetricsSchema,
  SumSchema,
} from "./gen/otel-metrics_pb.js";
import {
  ExportLogsRequestSchema,
  type ExportLogsRequest,
  LogAnyValueSchema,
  LogInstrumentationScopeSchema,
  LogKeyValueSchema,
  LogRecordSchema,
  LogResourceSchema,
  ResourceLogsSchema,
  ScopeLogsSchema,
} from "./gen/otel-logs_pb.js";
import {
  K8sContainerSchema,
  K8sContainerStatusSchema,
  K8sEnvVarSchema,
  K8sObjectMetaSchema,
  K8sPodListSchema,
  type K8sPodList,
  K8sPodSchema,
  K8sPodSpecSchema,
  K8sPodStatusSchema,
  K8sPortSchema,
  K8sResourceRequirementsSchema,
} from "./gen/k8s-pod_pb.js";
import {
  GraphQLErrorSchema,
  GraphQLRequestSchema,
  type GraphQLRequest,
  GraphQLResponseSchema,
  type GraphQLResponse,
  GraphQLSourceLocationSchema,
} from "./gen/graphql_pb.js";
import {
  RpcRequestSchema,
  type RpcRequest,
  RpcResponseSchema,
  type RpcResponse,
} from "./gen/rpc-simple_pb.js";
import {
  StressKeyValueSchema,
  StressMessageSchema,
  type StressMessage,
} from "./gen/stress_pb.js";

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

// ---------------------------------------------------------------------------
// Matrix fixtures — each builder is parameterized by a scale `n` so that the
// same shape can be measured at a few realistic cardinalities. Defaults are
// chosen to match what we see in production traffic for each payload class.
// ---------------------------------------------------------------------------

// ---- OTel metrics ---------------------------------------------------------
//
// A batched metrics export: one Resource, one Scope, a mix of Gauge/Sum and
// a Histogram with explicit bucket bounds. `n` controls the number of
// distinct metric series; each series contributes a handful of data points.

export const METRICS_SERIES_COUNT = 50;

function buildMetricAttributes(metricIdx: number) {
  const keys = [
    "service.name",
    "service.version",
    "deployment.environment",
    "host.name",
    "cloud.region",
  ];
  return keys.map((key, i) =>
    create(MetricKeyValueSchema, {
      key,
      value: create(MetricAnyValueSchema, {
        value: { case: "stringValue", value: `v-${metricIdx}-${i}` },
      }),
    }),
  );
}

function buildNumberDataPoint(idx: number, asDouble: boolean) {
  return create(NumberDataPointSchema, {
    attributes: buildMetricAttributes(idx),
    startTimeUnixNano: 1_700_000_000_000_000_000n,
    timeUnixNano: 1_700_000_000_000_001_000n + BigInt(idx) * 1000n,
    value: asDouble
      ? { case: "asDouble", value: 1.0 + idx * 0.125 }
      : { case: "asInt", value: BigInt(idx * 17) },
  });
}

function buildHistogramDataPoint(idx: number) {
  const buckets = [0, 1, 5, 10, 50, 100];
  return create(HistogramDataPointSchema, {
    attributes: buildMetricAttributes(idx),
    startTimeUnixNano: 1_700_000_000_000_000_000n,
    timeUnixNano: 1_700_000_000_000_001_000n + BigInt(idx) * 1000n,
    count: BigInt(100 + idx),
    sum: 123.456 * idx,
    bucketCounts: buckets.map((b) => BigInt(b + idx)),
    explicitBounds: [0.005, 0.01, 0.05, 0.1, 0.5, 1.0, 5.0],
    min: 0,
    max: 9999.0,
  });
}

export function buildExportMetricsRequest(
  n: number = METRICS_SERIES_COUNT,
): ExportMetricsRequest {
  const metrics = [] as ReturnType<typeof create<typeof MetricSchema>>[];
  for (let i = 0; i < n; i++) {
    const kind = i % 3;
    if (kind === 0) {
      metrics.push(
        create(MetricSchema, {
          name: `metric.gauge.${i}`,
          description: "gauge metric",
          unit: "1",
          data: {
            case: "gauge",
            value: create(GaugeSchema, {
              dataPoints: [
                buildNumberDataPoint(i, true),
                buildNumberDataPoint(i + 1, true),
              ],
            }),
          },
        }),
      );
    } else if (kind === 1) {
      metrics.push(
        create(MetricSchema, {
          name: `metric.sum.${i}`,
          description: "monotonic counter",
          unit: "By",
          data: {
            case: "sum",
            value: create(SumSchema, {
              aggregationTemporality: 2,
              isMonotonic: true,
              dataPoints: [
                buildNumberDataPoint(i, false),
                buildNumberDataPoint(i + 1, false),
              ],
            }),
          },
        }),
      );
    } else {
      metrics.push(
        create(MetricSchema, {
          name: `metric.histogram.${i}`,
          description: "request duration",
          unit: "s",
          data: {
            case: "histogram",
            value: create(HistogramSchema, {
              aggregationTemporality: 2,
              dataPoints: [buildHistogramDataPoint(i)],
            }),
          },
        }),
      );
    }
  }
  const scope = create(MetricInstrumentationScopeSchema, {
    name: "@example/metrics",
    version: "1.0.0",
  });
  const resource = create(MetricResourceSchema, {
    attributes: buildMetricAttributes(0),
  });
  return create(ExportMetricsRequestSchema, {
    resourceMetrics: [
      create(ResourceMetricsSchema, {
        resource,
        scopeMetrics: [create(ScopeMetricsSchema, { scope, metrics })],
      }),
    ],
  });
}

// ---- OTel logs ------------------------------------------------------------
//
// Batched logs export with string body, severity, attributes, and trace
// correlation IDs. `n` controls the number of log records in the batch.

export const LOGS_RECORD_COUNT = 100;

function buildLogAttributes(recordIdx: number) {
  const keys = ["code.namespace", "code.function", "thread.id", "log.source"];
  return keys.map((key, i) =>
    create(LogKeyValueSchema, {
      key,
      value: create(LogAnyValueSchema, {
        value: { case: "stringValue", value: `v-${recordIdx}-${i}` },
      }),
    }),
  );
}

export function buildExportLogsRequest(
  n: number = LOGS_RECORD_COUNT,
): ExportLogsRequest {
  const records = [] as ReturnType<typeof create<typeof LogRecordSchema>>[];
  for (let i = 0; i < n; i++) {
    records.push(
      create(LogRecordSchema, {
        timeUnixNano: 1_700_000_000_000_000_000n + BigInt(i) * 1000n,
        observedTimeUnixNano: 1_700_000_000_000_001_000n + BigInt(i) * 1000n,
        severityNumber: 9 + (i % 4),
        severityText: ["INFO", "WARN", "ERROR", "DEBUG"][i % 4],
        body: create(LogAnyValueSchema, {
          value: {
            case: "stringValue",
            value: `log message #${i}: operation completed in ${i % 100}ms`,
          },
        }),
        attributes: buildLogAttributes(i),
        droppedAttributesCount: 0,
        flags: i & 0xff,
        traceId: bytes(i, 16),
        spanId: bytes(i + 1, 8),
      }),
    );
  }
  const scope = create(LogInstrumentationScopeSchema, {
    name: "@example/logger",
    version: "1.0.0",
  });
  const resource = create(LogResourceSchema, {
    attributes: buildLogAttributes(0),
  });
  return create(ExportLogsRequestSchema, {
    resourceLogs: [
      create(ResourceLogsSchema, {
        resource,
        scopeLogs: [
          create(ScopeLogsSchema, {
            scope,
            logRecords: records,
            schemaUrl: "",
          }),
        ],
        schemaUrl: "",
      }),
    ],
  });
}

// ---- K8s Pod list ---------------------------------------------------------
//
// Representative payload for a kubelet → apiserver listing call. Maps
// (labels, annotations, limits, requests) dominate; each pod has 2
// containers with env vars, ports, resource requirements, and a few
// container statuses.

export const K8S_POD_COUNT = 20;

function buildK8sContainer(podIdx: number, containerIdx: number) {
  return create(K8sContainerSchema, {
    name: `container-${containerIdx}`,
    image: `ghcr.io/example/app:v1.${podIdx}.${containerIdx}`,
    command: ["/bin/app", "--config=/etc/app/config.yaml"],
    args: ["--log-level=info", `--instance=pod-${podIdx}`],
    env: [
      create(K8sEnvVarSchema, { name: "NODE_ENV", value: "production" }),
      create(K8sEnvVarSchema, { name: "PORT", value: "8080" }),
      create(K8sEnvVarSchema, {
        name: "POD_NAME",
        value: `example-pod-${podIdx}`,
      }),
      create(K8sEnvVarSchema, { name: "POD_NAMESPACE", value: "default" }),
    ],
    ports: [
      create(K8sPortSchema, {
        name: "http",
        containerPort: 8080,
        protocol: "TCP",
      }),
      create(K8sPortSchema, {
        name: "metrics",
        containerPort: 9090,
        protocol: "TCP",
      }),
    ],
    resources: create(K8sResourceRequirementsSchema, {
      limits: { cpu: "1000m", memory: "512Mi" },
      requests: { cpu: "100m", memory: "128Mi" },
    }),
    imagePullPolicy: "IfNotPresent",
  });
}

function buildK8sPod(i: number) {
  const meta = create(K8sObjectMetaSchema, {
    name: `example-pod-${i}`,
    namespace: "default",
    uid: `uid-${i.toString().padStart(8, "0")}`,
    resourceVersion: `${100000 + i}`,
    generation: BigInt(1),
    labels: {
      app: "example",
      component: "api",
      "app.kubernetes.io/name": "example",
      "app.kubernetes.io/instance": `instance-${i}`,
      tier: "backend",
    },
    annotations: {
      "prometheus.io/scrape": "true",
      "prometheus.io/port": "9090",
      "kubectl.kubernetes.io/last-applied-configuration": "{}",
    },
    creationTimestampUnixNano: 1_700_000_000_000_000_000n + BigInt(i) * 1000n,
  });
  const spec = create(K8sPodSpecSchema, {
    containers: [buildK8sContainer(i, 0), buildK8sContainer(i, 1)],
    restartPolicy: "Always",
    nodeName: `node-${i % 5}.cluster.local`,
    serviceAccountName: "default",
    terminationGracePeriodSeconds: BigInt(30),
  });
  const status = create(K8sPodStatusSchema, {
    phase: "Running",
    podIp: `10.0.${(i >> 8) & 0xff}.${i & 0xff}`,
    hostIp: `10.1.0.${i % 255}`,
    startTimeUnixNano: 1_700_000_000_000_000_000n + BigInt(i) * 1000n,
    containerStatuses: [
      create(K8sContainerStatusSchema, {
        name: "container-0",
        ready: true,
        restartCount: 0,
        image: `ghcr.io/example/app:v1.${i}.0`,
        imageId: `sha256:${"a".repeat(64)}`,
        containerId: `containerd://${"b".repeat(64)}`,
        started: true,
      }),
      create(K8sContainerStatusSchema, {
        name: "container-1",
        ready: true,
        restartCount: 0,
        image: `ghcr.io/example/app:v1.${i}.1`,
        imageId: `sha256:${"c".repeat(64)}`,
        containerId: `containerd://${"d".repeat(64)}`,
        started: true,
      }),
    ],
  });
  return create(K8sPodSchema, { metadata: meta, spec, status });
}

export function buildK8sPodList(n: number = K8S_POD_COUNT): K8sPodList {
  const items = [] as ReturnType<typeof buildK8sPod>[];
  for (let i = 0; i < n; i++) {
    items.push(buildK8sPod(i));
  }
  return create(K8sPodListSchema, { items });
}

// ---- GraphQL --------------------------------------------------------------
//
// A medium-size GraphQL request/response pair: long query string, several
// variables (JSON-encoded bytes), small response payload. Mirrors a typical
// authenticated GraphQL API call.

const GRAPHQL_QUERY = `
  query GetUser($id: ID!, $includePosts: Boolean!, $postLimit: Int!) {
    user(id: $id) {
      id
      email
      displayName
      avatarUrl
      createdAt
      lastSeenAt
      posts(limit: $postLimit) @include(if: $includePosts) {
        id
        title
        body
        createdAt
        tags
        author { id displayName }
      }
      followers(first: 10) {
        edges { node { id displayName } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`.trim();

export function buildGraphQLRequest(): GraphQLRequest {
  const encoder = new TextEncoder();
  return create(GraphQLRequestSchema, {
    query: GRAPHQL_QUERY,
    operationName: "GetUser",
    variables: {
      id: encoder.encode('"user-42"'),
      includePosts: encoder.encode("true"),
      postLimit: encoder.encode("25"),
    },
    extensions: {
      traceId: "00000000000000000000000000000000",
      "x-client-version": "web/1.2.3",
    },
  });
}

export function buildGraphQLResponse(): GraphQLResponse {
  const encoder = new TextEncoder();
  // Smallish JSON response body — 2 KB-ish.
  const data = encoder.encode(
    JSON.stringify({
      user: {
        id: "user-42",
        email: "alice@example.com",
        displayName: "Alice",
        avatarUrl: "https://cdn.example.com/avatars/42.png",
        createdAt: "2024-01-15T10:00:00Z",
        lastSeenAt: "2026-04-19T09:30:00Z",
        posts: Array.from({ length: 5 }, (_, i) => ({
          id: `post-${i}`,
          title: `Example post ${i}`,
          body: `Lorem ipsum dolor sit amet, consectetur ${i}`,
          createdAt: "2025-01-01T00:00:00Z",
          tags: ["news", "update"],
          author: { id: "user-42", displayName: "Alice" },
        })),
      },
    }),
  );
  return create(GraphQLResponseSchema, {
    data,
    errors: [
      create(GraphQLErrorSchema, {
        message: "deprecated field 'lastSeenAt' will be removed in v2",
        locations: [
          create(GraphQLSourceLocationSchema, { line: 7, column: 7 }),
        ],
        path: ["user", "lastSeenAt"],
        extensions: {
          code: encoder.encode('"DEPRECATED_FIELD"'),
        },
      }),
    ],
    extensions: {
      traceId: encoder.encode('"00000000000000000000000000000000"'),
    },
  });
}

// ---- RPC simple -----------------------------------------------------------
//
// Baseline lightweight RPC envelope. Small headers map, modest payload,
// routing fields. This is the shape of a typical gRPC unary call; useful as
// a lower bound on per-call overhead.

export function buildRpcRequest(): RpcRequest {
  return create(RpcRequestSchema, {
    service: "example.api.v1.UserService",
    method: "GetUser",
    headers: {
      "x-request-id": "req-00000000-0000-0000-0000-000000000000",
      authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      "content-type": "application/grpc",
      "grpc-accept-encoding": "identity,gzip",
    },
    payload: new Uint8Array(256).fill(0xab),
    requestId: 0x0123456789abcdefn,
    deadlineMs: BigInt(5_000),
  });
}

export function buildRpcResponse(): RpcResponse {
  return create(RpcResponseSchema, {
    requestId: 0x0123456789abcdefn,
    statusCode: 0,
    headers: {
      "content-type": "application/grpc",
      "grpc-status": "0",
      "x-response-time-ms": "12",
    },
    payload: new Uint8Array(512).fill(0xcd),
    errorMessage: "",
  });
}

// ---- Stress ---------------------------------------------------------------
//
// Synthetic payload with deep nesting, wide repeated fields, every scalar
// type exercised once, and a large opaque blob. Used to surface
// type-specific encoder regressions.

export const STRESS_DEPTH = 8;
export const STRESS_ARRAY_WIDTH = 200;
export const STRESS_BLOB_SIZE = 4096;

export function buildStressMessage(
  depth: number = STRESS_DEPTH,
  width: number = STRESS_ARRAY_WIDTH,
  blobSize: number = STRESS_BLOB_SIZE,
): StressMessage {
  const ids = new Array<number>(width);
  const tags = new Array<string>(width);
  const attrs = [] as ReturnType<typeof create<typeof StressKeyValueSchema>>[];
  for (let i = 0; i < width; i++) {
    ids[i] = i;
    tags[i] = `tag-${i}`;
    attrs.push(create(StressKeyValueSchema, { key: `k${i}`, value: `v${i}` }));
  }
  const blob = "x".repeat(blobSize);
  const blobBytes = new Uint8Array(blobSize).fill(0x42);

  // Build from the leaf up so we don't recurse through `create()` closures.
  let current = create(StressMessageSchema, {
    ids,
    tags,
    attrs,
    blob,
    blobBytes,
    i32: -1,
    i64: -1n,
    u32: 0xffffffff >>> 0,
    u64: 0xffffffffffffffffn,
    s32: -2,
    s64: -2n,
    b: true,
    f32: 3.14,
    f64: Math.E,
    str: "stress",
    fx32: 0xdeadbeef >>> 0,
    fx64: 0xcafebabedeadbeefn,
    sfx32: -3,
    sfx64: -3n,
  });
  for (let i = 1; i < depth; i++) {
    current = create(StressMessageSchema, {
      child: current,
      // Leave all other fields at defaults at intermediate levels to keep
      // the message size growth bounded by depth rather than exploding.
    });
  }
  return current;
}
