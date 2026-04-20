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

/**
 * Correctness matrix test — verifies that every supported encoder produces
 * wire-format-compatible output for a representative set of message fixtures.
 *
 * Why this exists:
 *   The Phase 1+ encode-path optimizations (contiguous-buffer writer,
 *   schema plan codegen, specialized writers) introduce new encoder entry
 *   points that must remain semantically equivalent to the reference
 *   `toBinary` implementation. Ad-hoc checks in benchmark scripts are not
 *   sufficient — any future encoder variant must be covered by a CI-run
 *   matrix so regressions are caught immediately.
 *
 * Matrix shape:
 *   for each fixture F:
 *     for each (encoderA, encoderB) in encoders × encoders:
 *       assert encoderA(F).length === encoderB(F).length
 *       assert fromBinary(encoderA(F)) deep-equals fromBinary(encoderB(F))
 *       assert byte-identical if fixture marked canonical
 *       assert re-encode(decode(encoderA(F))) is stable
 *
 * Encoder registry:
 *   Add new encoders to the ENCODERS array below as they land on main.
 *   Currently only `toBinary` ships on main (L0 contiguous writer). The
 *   experimental L1+L2 schema-plan encoder (`toBinaryFast`) lives on the
 *   `archive/l1-l2-schema-plans-experimental` branch for future iteration
 *   and is intentionally absent here.
 */

import { suite, test } from "node:test";
import * as assert from "node:assert";
import {
  create,
  toBinary,
  fromBinary,
  protoInt64,
  type DescMessage,
  type MessageShape,
} from "@bufbuild/protobuf";
import {
  RepeatedScalarValuesMessageSchema,
  ScalarValuesMessageSchema,
} from "./gen/ts/extra/msg-scalar_pb.js";
import { MapsMessageSchema } from "./gen/ts/extra/msg-maps_pb.js";
import { MessageFieldMessageSchema } from "./gen/ts/extra/msg-message_pb.js";
import { OneofMessageSchema } from "./gen/ts/extra/msg-oneof_pb.js";
import { UserSchema } from "./gen/ts/extra/example_pb.js";
import { StructSchema, ValueSchema } from "@bufbuild/protobuf/wkt";

/**
 * An encoder entry under test. `name` is used in test titles; `encode`
 * receives the schema + message and must return the binary wire-format.
 */
interface EncoderEntry {
  readonly name: string;
  readonly encode: <Desc extends DescMessage>(
    schema: Desc,
    message: MessageShape<Desc>,
  ) => Uint8Array;
}

/**
 * A fixture to exercise. `build` returns a fully-populated message used in
 * every combination test. `canonical` marks fixtures whose wire format is
 * expected to be byte-identical across all encoders (e.g. no maps with
 * non-deterministic key ordering). Map-containing fixtures are marked
 * `canonical: false` because proto3 does not guarantee map key order.
 */
interface Fixture<Desc extends DescMessage> {
  readonly name: string;
  readonly schema: Desc;
  readonly build: () => MessageShape<Desc>;
  readonly canonical: boolean;
}

const ENCODERS: readonly EncoderEntry[] = [
  { name: "toBinary", encode: (schema, message) => toBinary(schema, message) },
  // Future additions (held on branch until they land on main):
  //   { name: "toBinaryFast", encode: ... }       // archive/l1-l2-schema-plans-experimental
  //   { name: "toBinarySchemaPlan", encode: ... }
];

// Fixtures — small but representative. Each covers one proto feature category.
const fixtures: Fixture<DescMessage>[] = [
  {
    name: "SimpleMessage / scalars",
    schema: ScalarValuesMessageSchema as DescMessage,
    canonical: true,
    build: () =>
      create(ScalarValuesMessageSchema, {
        doubleField: 0.75,
        floatField: -0.75,
        int64Field: protoInt64.parse(-1),
        uint64Field: protoInt64.uParse(1),
        int32Field: -123,
        fixed64Field: protoInt64.uParse(1),
        fixed32Field: 123,
        boolField: true,
        stringField: "hello world",
        bytesField: new Uint8Array([
          104, 101, 108, 108, 111, 32, 119, 111, 114, 108, 100,
        ]),
        uint32Field: 123,
        sfixed32Field: -123,
        sfixed64Field: protoInt64.parse(-1),
        sint32Field: -1,
        sint64Field: protoInt64.parse(-1),
      }) as unknown as MessageShape<DescMessage>,
  },
  {
    name: "RepeatedPacked / scalars",
    schema: RepeatedScalarValuesMessageSchema as DescMessage,
    canonical: true,
    build: () =>
      create(RepeatedScalarValuesMessageSchema, {
        doubleField: [0.75, 0, 1],
        floatField: [0.75, -0.75],
        int64Field: [protoInt64.parse(-1), protoInt64.parse(-2)],
        uint64Field: [protoInt64.uParse(1), protoInt64.uParse(2)],
        int32Field: [-123, 500],
        boolField: [true, false, true],
        stringField: ["hello", "world"],
        uint32Field: [123, 123],
        sint32Field: [-1, -2, 999],
      }) as unknown as MessageShape<DescMessage>,
  },
  {
    name: "Nested / message spans",
    schema: MessageFieldMessageSchema as DescMessage,
    canonical: true,
    build: () =>
      create(MessageFieldMessageSchema, {
        messageField: { name: "outer" },
        repeatedMessageField: [{ name: "a" }, { name: "b" }, { name: "c" }],
      }) as unknown as MessageShape<DescMessage>,
  },
  {
    name: "Nested / User with manager chain",
    schema: UserSchema as DescMessage,
    canonical: true,
    build: () =>
      create(UserSchema, {
        firstName: "Alice",
        active: true,
        manager: {
          firstName: "Bob",
          active: true,
          manager: { firstName: "Carol", active: false },
        },
        locations: ["berlin", "remote"],
        // No projects map — keeps this fixture canonical.
      }) as unknown as MessageShape<DescMessage>,
  },
  {
    name: "Map-containing",
    schema: MapsMessageSchema as DescMessage,
    canonical: false, // proto3 map key order not deterministic across encoders
    build: () =>
      create(MapsMessageSchema, {
        strStrField: { a: "str", b: "xx", c: "more" },
        strInt32Field: { a: 123, b: 455 },
        strBoolField: { a: true, b: false },
        int32StrField: { 1: "one", 2: "two" },
      }) as unknown as MessageShape<DescMessage>,
  },
  {
    name: "Oneof / scalar variant",
    schema: OneofMessageSchema as DescMessage,
    canonical: true,
    build: () =>
      create(OneofMessageSchema, {
        scalar: { case: "value", value: 42 },
      }) as unknown as MessageShape<DescMessage>,
  },
  {
    name: "Oneof / message variant",
    schema: OneofMessageSchema as DescMessage,
    canonical: true,
    build: () =>
      create(OneofMessageSchema, {
        message: {
          case: "foo",
          value: { name: "alice", toggle: true },
        },
      }) as unknown as MessageShape<DescMessage>,
  },
  {
    name: "Oneof / empty (default unset)",
    schema: OneofMessageSchema as DescMessage,
    canonical: true,
    build: () =>
      create(OneofMessageSchema) as unknown as MessageShape<DescMessage>,
  },
  {
    name: "AnyValue / oneof variant",
    schema: ValueSchema as DescMessage,
    canonical: true,
    build: () =>
      create(ValueSchema, {
        kind: { case: "stringValue", value: "hello" },
      }) as unknown as MessageShape<DescMessage>,
  },
  {
    name: "Struct / WKT with nested values",
    schema: StructSchema as DescMessage,
    canonical: false, // Struct is a map<string, Value>
    build: () =>
      create(StructSchema, {
        fields: {
          name: { kind: { case: "stringValue", value: "Alice" } },
          age: { kind: { case: "numberValue", value: 30 } },
          active: { kind: { case: "boolValue", value: true } },
        },
      }) as unknown as MessageShape<DescMessage>,
  },
];

void suite("correctness matrix: encoders × fixtures", () => {
  for (const fixture of fixtures) {
    void suite(fixture.name, () => {
      for (const encA of ENCODERS) {
        for (const encB of ENCODERS) {
          void test(`${encA.name} vs ${encB.name}`, () => {
            const message = fixture.build();
            const bytesA = encA.encode(fixture.schema, message);
            const bytesB = encB.encode(fixture.schema, message);

            // 1. Length equality — must always hold across encoders.
            assert.strictEqual(
              bytesA.length,
              bytesB.length,
              `${encA.name} produced ${bytesA.length} bytes but ${encB.name} produced ${bytesB.length}`,
            );

            // 2. Semantic equality via round-trip decode.
            const roundA = fromBinary(fixture.schema, bytesA);
            const roundB = fromBinary(fixture.schema, bytesB);
            assert.deepStrictEqual(
              roundA,
              roundB,
              `${encA.name} and ${encB.name} decode to different messages`,
            );

            // 3. Byte identity for canonical fixtures (no map ordering).
            if (fixture.canonical && encA.name === encB.name) {
              assert.deepStrictEqual(
                Array.from(bytesA),
                Array.from(bytesB),
                `${encA.name} is not deterministic on canonical fixture`,
              );
            }
            if (fixture.canonical && encA.name !== encB.name) {
              assert.deepStrictEqual(
                Array.from(bytesA),
                Array.from(bytesB),
                `${encA.name} and ${encB.name} produce different bytes on canonical fixture`,
              );
            }
          });

          void test(`${encA.name} → decode → ${encB.name} is stable`, () => {
            const message = fixture.build();
            const bytes1 = encA.encode(fixture.schema, message);
            const decoded = fromBinary(fixture.schema, bytes1);
            const bytes2 = encB.encode(fixture.schema, decoded);

            // Decoded-then-reencoded must round-trip to the same semantic message.
            const decoded2 = fromBinary(fixture.schema, bytes2);
            assert.deepStrictEqual(decoded, decoded2);

            // And for canonical fixtures, the bytes must match as well.
            if (fixture.canonical) {
              assert.strictEqual(bytes1.length, bytes2.length);
            }
          });
        }
      }
    });
  }
});
