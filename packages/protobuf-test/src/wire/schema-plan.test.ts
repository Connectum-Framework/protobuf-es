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

import { suite, test } from "node:test";
import * as assert from "node:assert";
import {
  create,
  toBinary,
  toBinaryFast,
  fromBinary,
  protoInt64,
  type DescMessage,
  type MessageInitShape,
  type MessageShape,
} from "@bufbuild/protobuf";
import {
  RepeatedScalarValuesMessageSchema,
  ScalarValuesMessageSchema,
} from "../gen/ts/extra/msg-scalar_pb.js";
import { MapsMessageSchema } from "../gen/ts/extra/msg-maps_pb.js";
import { MessageFieldMessageSchema } from "../gen/ts/extra/msg-message_pb.js";
import { OneofMessageSchema } from "../gen/ts/extra/msg-oneof_pb.js";

/**
 * Assert that `toBinaryFast` produces byte-identical output to the reflective
 * `toBinary` for a given message. Also verifies round-trip fidelity.
 */
function assertParity<Desc extends DescMessage>(
  schema: Desc,
  init: MessageInitShape<Desc>,
  label: string,
): void {
  const msg = create(schema, init);
  const reflective = toBinary(schema, msg);
  const fast = toBinaryFast(schema, msg);
  assert.deepStrictEqual(
    Array.from(fast),
    Array.from(reflective),
    `${label}: byte mismatch between toBinaryFast and toBinary`,
  );
  // Round-trip: bytes must parse back to an equal message.
  const parsed = fromBinary(schema, fast) as MessageShape<Desc>;
  const parsedBytes = toBinary(schema, parsed);
  assert.deepStrictEqual(
    Array.from(fast),
    Array.from(parsedBytes),
    `${label}: round-trip drift`,
  );
}

void suite("wire/schema-plan — toBinaryFast parity", () => {
  test("scalar-only message (zero values)", () => {
    assertParity(
      ScalarValuesMessageSchema,
      {},
      "all defaults",
    );
  });

  test("scalar-only message (every scalar set)", () => {
    assertParity(
      ScalarValuesMessageSchema,
      {
        doubleField: 0.75,
        floatField: -0.75,
        int64Field: protoInt64.parse(-1),
        uint64Field: protoInt64.uParse(1),
        int32Field: -123,
        fixed64Field: protoInt64.uParse(1),
        fixed32Field: 123,
        boolField: true,
        stringField: "hello world",
        bytesField: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
        uint32Field: 456,
        sfixed32Field: -456,
        sfixed64Field: protoInt64.parse(-2),
        sint32Field: -789,
        sint64Field: protoInt64.parse(-3),
      },
      "every scalar",
    );
  });

  test("ASCII-only string field", () => {
    assertParity(
      ScalarValuesMessageSchema,
      { stringField: "the quick brown fox jumps over the lazy dog" },
      "ascii string",
    );
  });

  test("non-ASCII string field (UTF-8 fallback)", () => {
    assertParity(
      ScalarValuesMessageSchema,
      { stringField: "привет мир — HELLO" },
      "utf8 string",
    );
  });

  test("repeated packed scalars", () => {
    assertParity(
      RepeatedScalarValuesMessageSchema,
      {
        int32Field: [1, 2, 3, 4, 5, 127, 128, 16383, 16384],
        int64Field: [protoInt64.parse(1), protoInt64.parse(2)],
        boolField: [true, false, true],
        doubleField: [0.5, -0.5, 1e308],
      },
      "packed",
    );
  });

  test("repeated message field", () => {
    assertParity(
      MessageFieldMessageSchema,
      {
        repeatedMessageField: [{ name: "a" }, { name: "b" }, { name: "c" }],
      },
      "repeated message",
    );
  });

  test("nested single message", () => {
    assertParity(
      MessageFieldMessageSchema,
      { messageField: { name: "nested" } },
      "nested message",
    );
  });

  test("map<string, int32>", () => {
    assertParity(
      MapsMessageSchema,
      {
        strInt32Field: { one: 1, two: 2, three: 3 },
      },
      "map str->int32",
    );
  });

  test("map<int32, string>", () => {
    assertParity(
      MapsMessageSchema,
      { int32StrField: { 1: "one", 2: "two" } },
      "map int32->str",
    );
  });

  test("oneof — scalar (int32) arm", () => {
    assertParity(
      OneofMessageSchema,
      { scalar: { case: "value", value: 42 } },
      "oneof scalar int32",
    );
  });

  test("oneof — scalar (string) arm", () => {
    assertParity(
      OneofMessageSchema,
      { scalar: { case: "error", value: "oops" } },
      "oneof scalar string",
    );
  });

  test("oneof — message arm", () => {
    assertParity(
      OneofMessageSchema,
      { message: { case: "foo", value: { name: "oneof-msg" } } },
      "oneof message",
    );
  });

  test("oneof — unset", () => {
    assertParity(OneofMessageSchema, {}, "oneof unset");
  });

  test("unknown-fields fallback — message without unknowns", () => {
    // Sanity: no unknown fields present means fast path handles encoding.
    assertParity(ScalarValuesMessageSchema, { int32Field: 42 }, "no unknowns");
  });
});
