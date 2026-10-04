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
  type MessageInitShape,
  type MessageShape,
  create,
  fromBinary,
  fromJson,
  toBinary,
  toJson,
} from "@bufbuild/protobuf";
import { BinaryReader, BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import { makeInit } from "./fixtures.js";
import {
  GeneralSchema,
  MapMessageSchema,
  MapScalarSchema,
  RepeatedMessageSchema,
  RepeatedScalarSchema,
  ScalarSchema,
  UserSchema,
} from "./gen/bench/v1/bench_pb.js";
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

export interface Case {
  ops: number;
  run: () => unknown;
}

export const OPS_PER_RUN = 4096;

// Size for testing large collections.
const MESSAGE_COLLECTION_SIZE = 1000;

// The five whole-message operations on one fixture, given its init object.
function messageCasesFromInit<Desc extends DescMessage>(
  name: string,
  schema: Desc,
  init: MessageInitShape<Desc>,
): Record<string, Case> {
  const msg = create(schema, init);
  const bytes = toBinary(schema, msg);
  const json = toJson(schema, msg);
  return {
    [`create/${name}`]: { ops: 1, run: () => create(schema, init) },
    [`toBinary/${name}`]: { ops: 1, run: () => toBinary(schema, msg) },
    [`fromBinary/${name}`]: { ops: 1, run: () => fromBinary(schema, bytes) },
    [`toJson/${name}`]: { ops: 1, run: () => toJson(schema, msg) },
    [`fromJson/${name}`]: { ops: 1, run: () => fromJson(schema, json) },
  };
}

// The four serialization operations on a message that was already built.
// Realistic payloads are assembled by hand-written builders (nested create()
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

// The same, with the init generated from the descriptor by makeInit.
function messageCases<Desc extends DescMessage>(
  name: string,
  schema: Desc,
  messageCollectionSize?: number,
): Record<string, Case> {
  return messageCasesFromInit(
    name,
    schema,
    makeInit(schema, messageCollectionSize),
  );
}

// Hand-built User fixtures in two shapes: "tiny" is almost empty, "normal" is populated.
const USER_TINY: MessageInitShape<typeof UserSchema> = {
  active: false,
  manager: { active: true },
};
const USER_NORMAL: MessageInitShape<typeof UserSchema> = {
  firstName: "Jane",
  lastName: "Doe",
  active: true,
  manager: { firstName: "Jane", lastName: "Doe", active: false },
  locations: ["Seattle", "New York", "Tokyo"],
  projects: { foo: "project foo", bar: "project bar" },
};

export const cases: Record<string, Case> = {
  // Baseline: BinaryWriter construction, paid once per toBinary call.
  "BinaryWriter/alloc": {
    ops: OPS_PER_RUN,
    run: () => {
      let bytes: Uint8Array | undefined;
      for (let i = 0; i < OPS_PER_RUN; i++) bytes = new BinaryWriter().finish();
      return bytes;
    },
  },
  "BinaryWriter/int32": (() => {
    const w = new BinaryWriter();
    return {
      ops: OPS_PER_RUN,
      run: () => {
        for (let i = 0; i < OPS_PER_RUN; i++) w.int32(300);
        return w.finish();
      },
    };
  })(),
  "BinaryWriter/int64": (() => {
    const w = new BinaryWriter();
    const value = BigInt("-6917529027641081857");
    return {
      ops: OPS_PER_RUN,
      run: () => {
        for (let i = 0; i < OPS_PER_RUN; i++) w.int64(value);
        return w.finish();
      },
    };
  })(),
  "BinaryWriter/uint64": (() => {
    const w = new BinaryWriter();
    const value = BigInt("13835058055282163712");
    return {
      ops: OPS_PER_RUN,
      run: () => {
        for (let i = 0; i < OPS_PER_RUN; i++) w.uint64(value);
        return w.finish();
      },
    };
  })(),
  "BinaryWriter/sint32": (() => {
    const w = new BinaryWriter();
    return {
      ops: OPS_PER_RUN,
      run: () => {
        for (let i = 0; i < OPS_PER_RUN; i++) w.sint32(-123456);
        return w.finish();
      },
    };
  })(),
  "BinaryWriter/sint64": (() => {
    const w = new BinaryWriter();
    const value = BigInt("-6917529027641081857");
    return {
      ops: OPS_PER_RUN,
      run: () => {
        for (let i = 0; i < OPS_PER_RUN; i++) w.sint64(value);
        return w.finish();
      },
    };
  })(),
  "BinaryWriter/fixed32": (() => {
    const w = new BinaryWriter();
    return {
      ops: OPS_PER_RUN,
      run: () => {
        for (let i = 0; i < OPS_PER_RUN; i++) w.fixed32(0xdeadbeef);
        return w.finish();
      },
    };
  })(),
  "BinaryWriter/fixed64": (() => {
    const w = new BinaryWriter();
    const value = BigInt("13835058055282163712");
    return {
      ops: OPS_PER_RUN,
      run: () => {
        for (let i = 0; i < OPS_PER_RUN; i++) w.fixed64(value);
        return w.finish();
      },
    };
  })(),
  "BinaryWriter/float": (() => {
    const w = new BinaryWriter();
    return {
      ops: OPS_PER_RUN,
      run: () => {
        for (let i = 0; i < OPS_PER_RUN; i++) w.float(Math.PI);
        return w.finish();
      },
    };
  })(),
  "BinaryWriter/double": (() => {
    const w = new BinaryWriter();
    return {
      ops: OPS_PER_RUN,
      run: () => {
        for (let i = 0; i < OPS_PER_RUN; i++) w.double(Math.PI);
        return w.finish();
      },
    };
  })(),
  "BinaryWriter/bool": (() => {
    const w = new BinaryWriter();
    return {
      ops: OPS_PER_RUN,
      run: () => {
        for (let i = 0; i < OPS_PER_RUN; i++) w.bool(true);
        return w.finish();
      },
    };
  })(),
  "BinaryWriter/string-ascii": (() => {
    const w = new BinaryWriter();
    return {
      ops: OPS_PER_RUN,
      run: () => {
        for (let i = 0; i < OPS_PER_RUN; i++) w.string("hello world");
        return w.finish();
      },
    };
  })(),
  "BinaryWriter/string-utf8": (() => {
    const w = new BinaryWriter();
    return {
      ops: OPS_PER_RUN,
      run: () => {
        for (let i = 0; i < OPS_PER_RUN; i++)
          w.string("こんにちは世界、protobuf");
        return w.finish();
      },
    };
  })(),
  "BinaryWriter/bytes": (() => {
    const w = new BinaryWriter();
    const value = new Uint8Array(32).fill(0xab);
    return {
      ops: OPS_PER_RUN,
      run: () => {
        for (let i = 0; i < OPS_PER_RUN; i++) w.bytes(value);
        return w.finish();
      },
    };
  })(),
  "BinaryWriter/tag": (() => {
    const w = new BinaryWriter();
    return {
      ops: OPS_PER_RUN,
      run: () => {
        for (let i = 0; i < OPS_PER_RUN; i++) w.tag(1, WireType.Varint);
        return w.finish();
      },
    };
  })(),
  // The nested-message machinery: tag, fork, write a body, join. This is what
  // every length-delimited field (nested message, packed repeated) pays.
  "BinaryWriter/fork-join": (() => {
    const w = new BinaryWriter();
    return {
      ops: OPS_PER_RUN,
      run: () => {
        for (let i = 0; i < OPS_PER_RUN; i++) {
          w.tag(1, WireType.LengthDelimited).fork();
          w.tag(1, WireType.Varint).int32(300);
          w.join();
        }
        return w.finish();
      },
    };
  })(),
  // Baseline: BinaryReader construction, paid once per fromBinary call.
  "BinaryReader/alloc": (() => {
    const bytes = new BinaryWriter().int32(300).finish();
    return {
      ops: OPS_PER_RUN,
      run: () => {
        let r: BinaryReader | undefined;
        for (let i = 0; i < OPS_PER_RUN; i++) r = new BinaryReader(bytes);
        return r;
      },
    };
  })(),
  "BinaryReader/int32": (() => {
    const w = new BinaryWriter();
    for (let i = 0; i < OPS_PER_RUN; i++) w.int32(300);
    const r = new BinaryReader(w.finish());
    return {
      ops: OPS_PER_RUN,
      run: () => {
        r.pos = 0;
        let value: unknown;
        for (let i = 0; i < OPS_PER_RUN; i++) value = r.int32();
        return value;
      },
    };
  })(),
  "BinaryReader/int64": (() => {
    const w = new BinaryWriter();
    const value = BigInt("-6917529027641081857");
    for (let i = 0; i < OPS_PER_RUN; i++) w.int64(value);
    const r = new BinaryReader(w.finish());
    return {
      ops: OPS_PER_RUN,
      run: () => {
        r.pos = 0;
        let value: unknown;
        for (let i = 0; i < OPS_PER_RUN; i++) value = r.int64();
        return value;
      },
    };
  })(),
  "BinaryReader/sint64": (() => {
    const w = new BinaryWriter();
    const value = BigInt("-6917529027641081857");
    for (let i = 0; i < OPS_PER_RUN; i++) w.sint64(value);
    const r = new BinaryReader(w.finish());
    return {
      ops: OPS_PER_RUN,
      run: () => {
        r.pos = 0;
        let value: unknown;
        for (let i = 0; i < OPS_PER_RUN; i++) value = r.sint64();
        return value;
      },
    };
  })(),
  "BinaryReader/fixed64": (() => {
    const w = new BinaryWriter();
    const value = BigInt("13835058055282163712");
    for (let i = 0; i < OPS_PER_RUN; i++) w.fixed64(value);
    const r = new BinaryReader(w.finish());
    return {
      ops: OPS_PER_RUN,
      run: () => {
        r.pos = 0;
        let value: unknown;
        for (let i = 0; i < OPS_PER_RUN; i++) value = r.fixed64();
        return value;
      },
    };
  })(),
  "BinaryReader/double": (() => {
    const w = new BinaryWriter();
    for (let i = 0; i < OPS_PER_RUN; i++) w.double(Math.PI);
    const r = new BinaryReader(w.finish());
    return {
      ops: OPS_PER_RUN,
      run: () => {
        r.pos = 0;
        let value: unknown;
        for (let i = 0; i < OPS_PER_RUN; i++) value = r.double();
        return value;
      },
    };
  })(),
  "BinaryReader/bool": (() => {
    const w = new BinaryWriter();
    for (let i = 0; i < OPS_PER_RUN; i++) w.bool(true);
    const r = new BinaryReader(w.finish());
    return {
      ops: OPS_PER_RUN,
      run: () => {
        r.pos = 0;
        let value: unknown;
        for (let i = 0; i < OPS_PER_RUN; i++) value = r.bool();
        return value;
      },
    };
  })(),
  "BinaryReader/string-ascii": (() => {
    const w = new BinaryWriter();
    for (let i = 0; i < OPS_PER_RUN; i++) w.string("hello world");
    const r = new BinaryReader(w.finish());
    return {
      ops: OPS_PER_RUN,
      run: () => {
        r.pos = 0;
        let value: unknown;
        for (let i = 0; i < OPS_PER_RUN; i++) value = r.string();
        return value;
      },
    };
  })(),
  "BinaryReader/string-utf8": (() => {
    const w = new BinaryWriter();
    for (let i = 0; i < OPS_PER_RUN; i++) w.string("こんにちは世界、protobuf");
    const r = new BinaryReader(w.finish());
    return {
      ops: OPS_PER_RUN,
      run: () => {
        r.pos = 0;
        let value: unknown;
        for (let i = 0; i < OPS_PER_RUN; i++) value = r.string();
        return value;
      },
    };
  })(),
  "BinaryReader/bytes": (() => {
    const w = new BinaryWriter();
    const value = new Uint8Array(32).fill(0xab);
    for (let i = 0; i < OPS_PER_RUN; i++) w.bytes(value);
    const r = new BinaryReader(w.finish());
    return {
      ops: OPS_PER_RUN,
      run: () => {
        r.pos = 0;
        let value: unknown;
        for (let i = 0; i < OPS_PER_RUN; i++) value = r.bytes();
        return value;
      },
    };
  })(),

  ...messageCases("general", GeneralSchema),
  ...messageCases("scalar", ScalarSchema),

  // Small collections
  ...messageCases("repeated-scalar", RepeatedScalarSchema),
  ...messageCases("map-scalar", MapScalarSchema),

  // Large collections
  ...messageCases(
    "repeated-message",
    RepeatedMessageSchema,
    MESSAGE_COLLECTION_SIZE,
  ),
  ...messageCases("map-message", MapMessageSchema, MESSAGE_COLLECTION_SIZE),

  // Realistic examples
  ...messageCasesFromInit("user-tiny", UserSchema, USER_TINY),
  ...messageCasesFromInit("user-normal", UserSchema, USER_NORMAL),

  // Production-shaped payloads: telemetry export batches, map-heavy
  // configuration, JSON-in-bytes envelopes and a deep synthetic message.
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
  ...messageCasesFromMessage("rpc-request", RpcRequestSchema, buildRpcRequest()),
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

// List of case entries whose name matches any of the patterns.
export function select(patterns: string[]): [string, Case][] {
  const entries = Object.entries(cases);
  if (patterns.length === 0) {
    return entries;
  }
  const regexps = patterns.map((pattern) => new RegExp(pattern));
  return entries.filter(([name]) => regexps.some((re) => re.test(name)));
}
