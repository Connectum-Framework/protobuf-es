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

// Per-fixture protobufjs adapters for the benchmark report.
//
// protobufjs accepts a very different init shape from protobuf-es:
//   - oneof members live directly on the parent message (no `{ case, value }`).
//   - int64 / fixed64 fields come in as strings or Long; here we pass strings
//     built from the same seeds as `fixtures.ts` to keep the two libraries
//     encoding identical bytes.
//   - map fields are plain JS objects (both libraries agree here).
//
// We intentionally build each init object by hand rather than transforming a
// protobuf-es message at runtime: the transform logic is fixture-specific
// (oneof keys, int64 locations) and doing it once here keeps the hot loop in
// `report.ts` clean — everything inside `bench.add(...)` is just
// `ctor.encode(preBuilt).finish()`.

import { createRequire } from "node:module";

import {
  K8S_POD_COUNT,
  LOGS_RECORD_COUNT,
  METRICS_SERIES_COUNT,
  SMALL_INIT,
  SPAN_COUNT,
  STRESS_ARRAY_WIDTH,
  STRESS_BLOB_SIZE,
  STRESS_DEPTH,
} from "./fixtures.js";

const require = createRequire(import.meta.url);

/**
 * Minimal subset of the pbjs static-module message constructor interface we
 * rely on. `create` builds an internal representation; `encode` returns a
 * writer whose `finish()` yields the wire bytes. `verify` is optional but
 * kept here for the shape check we run at load time.
 */
export interface PbjsCtor {
  create(properties: Record<string, unknown>): Record<string, unknown>;
  encode(message: Record<string, unknown>): { finish(): Uint8Array };
  verify?(message: Record<string, unknown>): string | null;
}

/**
 * One pbjs bench entry per (fixture × encoder) row. `bytes` is the encoded
 * size we use as a sanity check — if it diverges from the protobuf-es
 * encoded size on the same fixture we would be measuring apples vs oranges,
 * so `report.ts` logs a warning in that case.
 */
export interface PbjsFixtureEntry {
  /** Fixture name — must match the name used in `cases` in report.ts. */
  fixture: string;
  /** Run a single encode + finish() call, the hot loop in the benchmark. */
  encode(): Uint8Array;
  /** Encoded size from one dry run — used for consistency checks. */
  bytes: number;
}

// Produce a 16-byte Uint8Array deterministically from a numeric seed — same
// seed scheme as `fixtures.ts` so the pbjs and protobuf-es bytes match.
function bytesFromSeed(seed: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = (seed + i) & 0xff;
  }
  return out;
}

// --- small.proto -----------------------------------------------------------

function buildPbjsSmall(): Record<string, unknown> {
  return { ...SMALL_INIT };
}

// --- nested.proto (OTel traces) --------------------------------------------

// Matches `buildExportTraceRequest` in fixtures.ts on the wire, but uses the
// flat-oneof / string-int64 shape that protobufjs expects.
function buildPbjsOtelTrace(): Record<string, unknown> {
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
  const spans: unknown[] = [];
  for (let i = 0; i < SPAN_COUNT; i++) {
    const attributes: unknown[] = [];
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
            { key: "service.name", value: { stringValue: "bench-service" } },
            { key: "service.version", value: { stringValue: "1.0.0" } },
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

// --- otel-metrics.proto ----------------------------------------------------

function buildPbjsMetricAttributes(metricIdx: number): unknown[] {
  const keys = [
    "service.name",
    "service.version",
    "deployment.environment",
    "host.name",
    "cloud.region",
  ];
  return keys.map((key, i) => ({
    key,
    value: { stringValue: `v-${metricIdx}-${i}` },
  }));
}

function buildPbjsNumberDataPoint(idx: number, asDouble: boolean) {
  const dp: Record<string, unknown> = {
    attributes: buildPbjsMetricAttributes(idx),
    startTimeUnixNano: "1700000000000000000",
    timeUnixNano: (1_700_000_000_000_001_000n + BigInt(idx) * 1000n).toString(),
  };
  if (asDouble) {
    dp.asDouble = 1.0 + idx * 0.125;
  } else {
    dp.asInt = BigInt(idx * 17).toString();
  }
  return dp;
}

function buildPbjsHistogramDataPoint(idx: number) {
  const buckets = [0, 1, 5, 10, 50, 100];
  return {
    attributes: buildPbjsMetricAttributes(idx),
    startTimeUnixNano: "1700000000000000000",
    timeUnixNano: (1_700_000_000_000_001_000n + BigInt(idx) * 1000n).toString(),
    count: BigInt(100 + idx).toString(),
    sum: 123.456 * idx,
    bucketCounts: buckets.map((b) => BigInt(b + idx).toString()),
    explicitBounds: [0.005, 0.01, 0.05, 0.1, 0.5, 1.0, 5.0],
    min: 0,
    max: 9999.0,
  };
}

function buildPbjsOtelMetrics(): Record<string, unknown> {
  const metrics: Record<string, unknown>[] = [];
  for (let i = 0; i < METRICS_SERIES_COUNT; i++) {
    const kind = i % 3;
    if (kind === 0) {
      metrics.push({
        name: `metric.gauge.${i}`,
        description: "gauge metric",
        unit: "1",
        gauge: {
          dataPoints: [
            buildPbjsNumberDataPoint(i, true),
            buildPbjsNumberDataPoint(i + 1, true),
          ],
        },
      });
    } else if (kind === 1) {
      metrics.push({
        name: `metric.sum.${i}`,
        description: "monotonic counter",
        unit: "By",
        sum: {
          aggregationTemporality: 2,
          isMonotonic: true,
          dataPoints: [
            buildPbjsNumberDataPoint(i, false),
            buildPbjsNumberDataPoint(i + 1, false),
          ],
        },
      });
    } else {
      metrics.push({
        name: `metric.histogram.${i}`,
        description: "request duration",
        unit: "s",
        histogram: {
          aggregationTemporality: 2,
          dataPoints: [buildPbjsHistogramDataPoint(i)],
        },
      });
    }
  }
  return {
    resourceMetrics: [
      {
        resource: { attributes: buildPbjsMetricAttributes(0) },
        scopeMetrics: [
          {
            scope: { name: "@example/metrics", version: "1.0.0" },
            metrics,
          },
        ],
      },
    ],
  };
}

// --- otel-logs.proto -------------------------------------------------------

function buildPbjsLogAttributes(recordIdx: number): unknown[] {
  const keys = ["code.namespace", "code.function", "thread.id", "log.source"];
  return keys.map((key, i) => ({
    key,
    value: { stringValue: `v-${recordIdx}-${i}` },
  }));
}

function buildPbjsOtelLogs(): Record<string, unknown> {
  const records: unknown[] = [];
  for (let i = 0; i < LOGS_RECORD_COUNT; i++) {
    records.push({
      timeUnixNano: (1_700_000_000_000_000_000n + BigInt(i) * 1000n).toString(),
      observedTimeUnixNano: (
        1_700_000_000_000_001_000n +
        BigInt(i) * 1000n
      ).toString(),
      severityNumber: 9 + (i % 4),
      severityText: ["INFO", "WARN", "ERROR", "DEBUG"][i % 4],
      body: {
        stringValue: `log message #${i}: operation completed in ${i % 100}ms`,
      },
      attributes: buildPbjsLogAttributes(i),
      droppedAttributesCount: 0,
      flags: i & 0xff,
      traceId: bytesFromSeed(i, 16),
      spanId: bytesFromSeed(i + 1, 8),
    });
  }
  return {
    resourceLogs: [
      {
        resource: { attributes: buildPbjsLogAttributes(0) },
        scopeLogs: [
          {
            scope: { name: "@example/logger", version: "1.0.0" },
            logRecords: records,
            schemaUrl: "",
          },
        ],
        schemaUrl: "",
      },
    ],
  };
}

// --- k8s-pod.proto ---------------------------------------------------------

function buildPbjsContainer(podIdx: number, containerIdx: number) {
  return {
    name: `container-${containerIdx}`,
    image: `ghcr.io/example/app:v1.${podIdx}.${containerIdx}`,
    command: ["/bin/app", "--config=/etc/app/config.yaml"],
    args: ["--log-level=info", `--instance=pod-${podIdx}`],
    env: [
      { name: "NODE_ENV", value: "production" },
      { name: "PORT", value: "8080" },
      { name: "POD_NAME", value: `example-pod-${podIdx}` },
      { name: "POD_NAMESPACE", value: "default" },
    ],
    ports: [
      { name: "http", containerPort: 8080, protocol: "TCP" },
      { name: "metrics", containerPort: 9090, protocol: "TCP" },
    ],
    resources: {
      limits: { cpu: "1000m", memory: "512Mi" },
      requests: { cpu: "100m", memory: "128Mi" },
    },
    imagePullPolicy: "IfNotPresent",
  };
}

function buildPbjsPod(i: number) {
  return {
    metadata: {
      name: `example-pod-${i}`,
      namespace: "default",
      uid: `uid-${i.toString().padStart(8, "0")}`,
      resourceVersion: `${100000 + i}`,
      generation: "1",
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
      creationTimestampUnixNano: (
        1_700_000_000_000_000_000n +
        BigInt(i) * 1000n
      ).toString(),
    },
    spec: {
      containers: [buildPbjsContainer(i, 0), buildPbjsContainer(i, 1)],
      restartPolicy: "Always",
      nodeName: `node-${i % 5}.cluster.local`,
      serviceAccountName: "default",
      terminationGracePeriodSeconds: "30",
    },
    status: {
      phase: "Running",
      podIp: `10.0.${(i >> 8) & 0xff}.${i & 0xff}`,
      hostIp: `10.1.0.${i % 255}`,
      startTimeUnixNano: (
        1_700_000_000_000_000_000n +
        BigInt(i) * 1000n
      ).toString(),
      containerStatuses: [
        {
          name: "container-0",
          ready: true,
          restartCount: 0,
          image: `ghcr.io/example/app:v1.${i}.0`,
          imageId: `sha256:${"a".repeat(64)}`,
          containerId: `containerd://${"b".repeat(64)}`,
          started: true,
        },
        {
          name: "container-1",
          ready: true,
          restartCount: 0,
          image: `ghcr.io/example/app:v1.${i}.1`,
          imageId: `sha256:${"c".repeat(64)}`,
          containerId: `containerd://${"d".repeat(64)}`,
          started: true,
        },
      ],
    },
  };
}

function buildPbjsK8sPodList(): Record<string, unknown> {
  const items: unknown[] = [];
  for (let i = 0; i < K8S_POD_COUNT; i++) {
    items.push(buildPbjsPod(i));
  }
  return { items };
}

// --- graphql.proto ---------------------------------------------------------

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

function buildPbjsGraphQLRequest(): Record<string, unknown> {
  const encoder = new TextEncoder();
  return {
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
  };
}

function buildPbjsGraphQLResponse(): Record<string, unknown> {
  const encoder = new TextEncoder();
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
  return {
    data,
    errors: [
      {
        message: "deprecated field 'lastSeenAt' will be removed in v2",
        locations: [{ line: 7, column: 7 }],
        path: ["user", "lastSeenAt"],
        extensions: { code: encoder.encode('"DEPRECATED_FIELD"') },
      },
    ],
    extensions: {
      traceId: encoder.encode('"00000000000000000000000000000000"'),
    },
  };
}

// --- rpc-simple.proto ------------------------------------------------------

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
    requestId: "81985529216486895", // 0x0123456789abcdef
    deadlineMs: "5000",
  };
}

function buildPbjsRpcResponse(): Record<string, unknown> {
  return {
    requestId: "81985529216486895",
    statusCode: 0,
    headers: {
      "content-type": "application/grpc",
      "grpc-status": "0",
      "x-response-time-ms": "12",
    },
    payload: new Uint8Array(512).fill(0xcd),
    errorMessage: "",
  };
}

// --- stress.proto ----------------------------------------------------------

function buildPbjsStress(): Record<string, unknown> {
  const ids: number[] = [];
  const tags: string[] = [];
  const attrs: unknown[] = [];
  for (let i = 0; i < STRESS_ARRAY_WIDTH; i++) {
    ids.push(i);
    tags.push(`tag-${i}`);
    attrs.push({ key: `k${i}`, value: `v${i}` });
  }
  const blob = "x".repeat(STRESS_BLOB_SIZE);
  const blobBytes = new Uint8Array(STRESS_BLOB_SIZE).fill(0x42);

  // Build from the leaf up. protobufjs accepts plain JS objects for nested
  // messages; no need to call .create() on intermediate levels.
  let current: Record<string, unknown> = {
    ids,
    tags,
    attrs,
    blob,
    blobBytes,
    i32: -1,
    i64: "-1",
    u32: 0xffffffff >>> 0,
    u64: "18446744073709551615",
    s32: -2,
    s64: "-2",
    b: true,
    f32: 3.14,
    f64: Math.E,
    str: "stress",
    fx32: 0xdeadbeef >>> 0,
    fx64: "14627333968688430831", // 0xcafebabedeadbeef
    sfx32: -3,
    sfx64: "-3",
  };
  for (let i = 1; i < STRESS_DEPTH; i++) {
    current = { child: current };
  }
  return current;
}

// ---------------------------------------------------------------------------
// Registry: one entry per fixture the report can render. Missing pbjs stubs
// (file not found, verify() failure) mean we silently skip that fixture's
// protobufjs bar — identical behavior to the original single-fixture pbjs
// path in report.ts. Keeping the guard at load time means the bench loop in
// report.ts never has to branch on pbjs availability per iteration.
// ---------------------------------------------------------------------------

interface FixtureDescriptor {
  /** Fixture name emitted by report.ts — must match exactly. */
  fixture: string;
  /** Path of the generated CommonJS module, relative to this file. */
  modulePath: string;
  /** Dotted path under `bench.v1.*` to the generated message constructor. */
  messagePath: string;
  /** Build the init object matching the fixture.ts shape. */
  buildInit: () => Record<string, unknown>;
}

/**
 * Fixture descriptor table. Adding a new fixture is a three-step change:
 * extend `generate:protobufjs` in package.json, add a `build*` above, and
 * append a row here. The `fixture` names are the load-bearing link to
 * `cases` in report.ts — tests for typos by spot-checking the emitted
 * results.
 */
const DESCRIPTORS: FixtureDescriptor[] = [
  {
    fixture: "SimpleMessage",
    modulePath: "./gen-protobufjs/small.cjs",
    messagePath: "SimpleMessage",
    buildInit: buildPbjsSmall,
  },
  {
    fixture: `ExportTraceRequest (${SPAN_COUNT} spans)`,
    modulePath: "./gen-protobufjs/nested.cjs",
    messagePath: "ExportTraceRequest",
    buildInit: buildPbjsOtelTrace,
  },
  {
    fixture: `ExportMetricsRequest (${METRICS_SERIES_COUNT} series)`,
    modulePath: "./gen-protobufjs/otel-metrics.cjs",
    messagePath: "ExportMetricsRequest",
    buildInit: buildPbjsOtelMetrics,
  },
  {
    fixture: `ExportLogsRequest (${LOGS_RECORD_COUNT} records)`,
    modulePath: "./gen-protobufjs/otel-logs.cjs",
    messagePath: "ExportLogsRequest",
    buildInit: buildPbjsOtelLogs,
  },
  {
    fixture: `K8sPodList (${K8S_POD_COUNT} pods)`,
    modulePath: "./gen-protobufjs/k8s-pod.cjs",
    messagePath: "K8sPodList",
    buildInit: buildPbjsK8sPodList,
  },
  {
    fixture: "GraphQLRequest",
    modulePath: "./gen-protobufjs/graphql.cjs",
    messagePath: "GraphQLRequest",
    buildInit: buildPbjsGraphQLRequest,
  },
  {
    fixture: "GraphQLResponse",
    modulePath: "./gen-protobufjs/graphql.cjs",
    messagePath: "GraphQLResponse",
    buildInit: buildPbjsGraphQLResponse,
  },
  {
    fixture: "RpcRequest",
    modulePath: "./gen-protobufjs/rpc-simple.cjs",
    messagePath: "RpcRequest",
    buildInit: buildPbjsRpcRequest,
  },
  {
    fixture: "RpcResponse",
    modulePath: "./gen-protobufjs/rpc-simple.cjs",
    messagePath: "RpcResponse",
    buildInit: buildPbjsRpcResponse,
  },
  {
    fixture: `StressMessage (depth=${STRESS_DEPTH}, width=${STRESS_ARRAY_WIDTH})`,
    modulePath: "./gen-protobufjs/stress.cjs",
    messagePath: "StressMessage",
    buildInit: buildPbjsStress,
  },
];

/**
 * Resolve a pbjs constructor under `bench.v1.<messagePath>`. We walk the
 * dotted path so future fixtures can add nested sub-messages (e.g.
 * `bench.v1.Foo.Bar`) without changing this resolver.
 */
function resolveCtor(mod: unknown, messagePath: string): PbjsCtor | null {
  // biome-ignore lint/suspicious/noExplicitAny: generated pbjs has dynamic shape
  let cursor: any = mod;
  for (const part of ["bench", "v1", ...messagePath.split(".")]) {
    if (cursor == null) return null;
    cursor = cursor[part];
  }
  return (cursor as PbjsCtor) ?? null;
}

/**
 * Load the full pbjs fixture set. Per-fixture failures are isolated: a
 * missing `gen-protobufjs/*.cjs` file or a `verify()` rejection of our init
 * object skips that fixture's bar on the chart without taking down the
 * rest of the report. This matches the original `loadPbjsExportTraceRequest`
 * behavior from before we expanded the matrix.
 */
export function loadPbjsFixtures(): PbjsFixtureEntry[] {
  const out: PbjsFixtureEntry[] = [];
  for (const d of DESCRIPTORS) {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: generated pbjs has dynamic shape
      const mod = require(d.modulePath) as any;
      const ctor = resolveCtor(mod, d.messagePath);
      if (!ctor) {
        console.warn(`pbjs: missing constructor for ${d.fixture}, skipping`);
        continue;
      }
      const init = d.buildInit();
      // Note: we do NOT call ctor.verify(init). --force-long makes verify()
      // reject string-valued int64/fixed64 fields even though encode()
      // accepts them via $util.Long.fromValue. We pass strings for large
      // 64-bit values to avoid precision loss; encode-time rejection is
      // what we care about, and the dry-run encode below catches that.
      const preBuilt = ctor.create(init);
      // Dry-run one encode to capture the byte count and catch runtime
      // errors (e.g. wrong oneof key, missing sibling ctor due to root
      // stomping) outside the hot loop. The captured `dryBytes.length` is
      // the size we compare against the protobuf-es encoded size.
      const dryBytes = ctor.encode(preBuilt).finish();
      out.push({
        fixture: d.fixture,
        encode: () => ctor.encode(preBuilt).finish(),
        bytes: dryBytes.length,
      });
    } catch (e) {
      // Missing codegen or a transient require error — treat as "pbjs not
      // available for this fixture", mirroring the original load behavior.
      console.warn(
        `pbjs: failed to load ${d.fixture} from ${d.modulePath}: ${
          (e as Error).message
        }`,
      );
    }
  }
  return out;
}
