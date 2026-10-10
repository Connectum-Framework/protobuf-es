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

import {
  type DescMessage,
  type MessageShape,
  fromBinary,
  fromJson,
  toBinary,
  toJson,
} from "@bufbuild/protobuf";
import type { Case } from "./corpus.js";
import {
  GraphQLRequestSchema,
  GraphQLResponseSchema,
} from "./gen/realistic/v1/graphql_pb.js";
import { K8sPodListSchema } from "./gen/realistic/v1/k8s-pod_pb.js";
import { ExportTraceRequestSchema } from "./gen/realistic/v1/nested_pb.js";
import { ExportLogsRequestSchema } from "./gen/realistic/v1/otel-logs_pb.js";
import { ExportMetricsRequestSchema } from "./gen/realistic/v1/otel-metrics_pb.js";
import {
  RpcRequestSchema,
  RpcResponseSchema,
} from "./gen/realistic/v1/rpc-simple_pb.js";
import { SimpleMessageSchema } from "./gen/realistic/v1/small_pb.js";
import { StressMessageSchema } from "./gen/realistic/v1/stress_pb.js";
import {
  buildExportLogsRequest,
  buildExportMetricsRequest,
  buildExportTraceRequest,
  buildGraphQLRequest,
  buildGraphQLResponse,
  buildK8sPodList,
  buildRpcRequest,
  buildRpcResponse,
  buildSmallMessage,
  buildStressMessage,
} from "./realistic-fixtures.js";

// The four serialization operations on a message that was already built.
// These payloads are assembled by hand-written builders (nested create()
// calls), so there is no single init object whose create() cost would be
// meaningful to measure.
function messageCasesFromMessage<Desc extends DescMessage>(
  name: string,
  schema: Desc,
  msg: MessageShape<Desc>,
): Record<string, Case> {
  const bytes = toBinary(schema, msg);
  const json = toJson(schema, msg);
  return {
    [`toBinary/${name}`]: { ops: 1, run: () => toBinary(schema, msg) },
    [`fromBinary/${name}`]: { ops: 1, run: () => fromBinary(schema, bytes) },
    [`toJson/${name}`]: { ops: 1, run: () => toJson(schema, msg) },
    [`fromJson/${name}`]: { ops: 1, run: () => fromJson(schema, json) },
  };
}

// Production-shaped payloads: telemetry export batches, map-heavy
// configuration, JSON-in-bytes envelopes and a deep synthetic message.
export function realisticCases(): Record<string, Case> {
  return {
    ...messageCasesFromMessage(
      "simple",
      SimpleMessageSchema,
      buildSmallMessage(),
    ),
    ...messageCasesFromMessage(
      "otel-traces",
      ExportTraceRequestSchema,
      buildExportTraceRequest(),
    ),
    ...messageCasesFromMessage(
      "otel-metrics",
      ExportMetricsRequestSchema,
      buildExportMetricsRequest(),
    ),
    ...messageCasesFromMessage(
      "otel-logs",
      ExportLogsRequestSchema,
      buildExportLogsRequest(),
    ),
    ...messageCasesFromMessage("k8s-pods", K8sPodListSchema, buildK8sPodList()),
    ...messageCasesFromMessage(
      "graphql-request",
      GraphQLRequestSchema,
      buildGraphQLRequest(),
    ),
    ...messageCasesFromMessage(
      "graphql-response",
      GraphQLResponseSchema,
      buildGraphQLResponse(),
    ),
    ...messageCasesFromMessage(
      "rpc-request",
      RpcRequestSchema,
      buildRpcRequest(),
    ),
    ...messageCasesFromMessage(
      "rpc-response",
      RpcResponseSchema,
      buildRpcResponse(),
    ),
    ...messageCasesFromMessage(
      "stress",
      StressMessageSchema,
      buildStressMessage(),
    ),
  };
}
