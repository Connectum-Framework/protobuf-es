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

// Feature-coverage tests for the experimental `toBinaryFast` encoder.
// The load-bearing claim is byte-identical output against the reflective
// `toBinary` for the feature surfaces the fast path claims to handle —
// maps (every legal K, every legal V) and oneofs (scalar, message, enum).
// Semantic round-trip is also asserted as a defense-in-depth check.

import { suite, test } from "node:test";
import * as assert from "node:assert";
import {
  create,
  toBinary,
  toBinaryFast,
  fromBinary,
  protoInt64,
} from "@bufbuild/protobuf";
import { MapsMessageSchema, MapsEnum } from "./gen/ts/extra/msg-maps_pb.js";
import {
  OneofMessageSchema,
  OneofMessageFooSchema,
  OneofMessageBarSchema,
  OneofEnum,
} from "./gen/ts/extra/msg-oneof_pb.js";
import { ScalarValuesMessageSchema } from "./gen/ts/extra/msg-scalar_pb.js";

void suite("toBinaryFast", () => {
  void suite("map field parity", () => {
    test("map<string,*> with scalar/bytes values", () => {
      const msg = create(MapsMessageSchema, {
        strStrField: { a: "alpha", b: "beta", c: "gamma" },
        strInt32Field: { a: 1, b: -2, c: 0x7fff_ffff },
        strInt64Field: {
          a: protoInt64.parse(1),
          // Literal `<digits>n` requires ES2020; this package is compiled for ES2017.
          b: protoInt64.parse(BigInt("-9007199254740993")),
        },
        strBoolField: { true_key: true, false_key: false },
        strBytesField: {
          a: new Uint8Array([0, 1, 2, 3]),
          b: new Uint8Array([0xff, 0xfe]),
        },
      });
      const slow = toBinary(MapsMessageSchema, msg);
      const fast = toBinaryFast(MapsMessageSchema, msg);
      assert.deepStrictEqual(
        Array.from(fast),
        Array.from(slow),
        "byte-identical expected for string-keyed maps",
      );
      assert.deepStrictEqual(
        fromBinary(MapsMessageSchema, fast),
        fromBinary(MapsMessageSchema, slow),
      );
    });

    test("map<int32,*> and map<int64,*> keys parse and encode", () => {
      const msg = create(MapsMessageSchema, {
        int32StrField: { 1: "one", [-2]: "neg-two", 100: "hundred" },
        int64StrField: {
          "1": "one",
          "-2": "neg-two",
          "9007199254740993": "big",
        },
      });
      const slow = toBinary(MapsMessageSchema, msg);
      const fast = toBinaryFast(MapsMessageSchema, msg);
      // Byte-identical requires same field ordering and same map iteration
      // order. Both encoders iterate descriptor order + Object.keys order,
      // so parity should hold.
      assert.deepStrictEqual(Array.from(fast), Array.from(slow));
      assert.deepStrictEqual(
        fromBinary(MapsMessageSchema, fast),
        fromBinary(MapsMessageSchema, slow),
      );
    });

    test("map<bool, string>", () => {
      const msg = create(MapsMessageSchema, {
        boolStrField: { true: "yes", false: "no" },
      });
      const slow = toBinary(MapsMessageSchema, msg);
      const fast = toBinaryFast(MapsMessageSchema, msg);
      assert.deepStrictEqual(Array.from(fast), Array.from(slow));
    });

    test("map<*,message> encodes the value submessage", () => {
      const inner = create(MapsMessageSchema, {
        strStrField: { nested: "ok" },
      });
      const msg = create(MapsMessageSchema, {
        strMsgField: { first: inner, second: inner },
        int32MsgField: { 1: inner, 2: inner },
      });
      const slow = toBinary(MapsMessageSchema, msg);
      const fast = toBinaryFast(MapsMessageSchema, msg);
      assert.deepStrictEqual(Array.from(fast), Array.from(slow));
      assert.deepStrictEqual(
        fromBinary(MapsMessageSchema, fast),
        fromBinary(MapsMessageSchema, slow),
      );
    });

    test("map<*,enum>", () => {
      const msg = create(MapsMessageSchema, {
        strEnuField: { a: MapsEnum.YES, b: MapsEnum.NO },
        int32EnuField: { 1: MapsEnum.YES, 2: MapsEnum.NO },
      });
      const slow = toBinary(MapsMessageSchema, msg);
      const fast = toBinaryFast(MapsMessageSchema, msg);
      assert.deepStrictEqual(Array.from(fast), Array.from(slow));
    });

    test("empty maps do not emit anything", () => {
      const msg = create(MapsMessageSchema, {});
      const slow = toBinary(MapsMessageSchema, msg);
      const fast = toBinaryFast(MapsMessageSchema, msg);
      assert.strictEqual(fast.length, 0);
      assert.deepStrictEqual(Array.from(fast), Array.from(slow));
    });
  });

  void suite("oneof parity", () => {
    test("scalar oneof — int value case", () => {
      const msg = create(OneofMessageSchema, {
        scalar: { case: "value", value: 42 },
      });
      const slow = toBinary(OneofMessageSchema, msg);
      const fast = toBinaryFast(OneofMessageSchema, msg);
      assert.deepStrictEqual(Array.from(fast), Array.from(slow));
    });

    test("scalar oneof — zero value must still be emitted", () => {
      // Oneof presence is carried by the discriminator, so a `value: 0`
      // case is *still* considered set. This is the tricky corner that
      // the fast-path oneof dispatch has to get right (a non-oneof
      // IMPLICIT int with value 0 would be omitted).
      const msg = create(OneofMessageSchema, {
        scalar: { case: "value", value: 0 },
      });
      const slow = toBinary(OneofMessageSchema, msg);
      const fast = toBinaryFast(OneofMessageSchema, msg);
      assert.deepStrictEqual(Array.from(fast), Array.from(slow));
      assert.ok(fast.length > 0, "expected tag+value for zero-valued oneof");
    });

    test("scalar oneof — string case with empty string", () => {
      const msg = create(OneofMessageSchema, {
        scalar: { case: "error", value: "" },
      });
      const slow = toBinary(OneofMessageSchema, msg);
      const fast = toBinaryFast(OneofMessageSchema, msg);
      assert.deepStrictEqual(Array.from(fast), Array.from(slow));
    });

    test("scalar oneof — bytes case", () => {
      const msg = create(OneofMessageSchema, {
        scalar: { case: "bytes", value: new Uint8Array([1, 2, 3, 255]) },
      });
      const slow = toBinary(OneofMessageSchema, msg);
      const fast = toBinaryFast(OneofMessageSchema, msg);
      assert.deepStrictEqual(Array.from(fast), Array.from(slow));
    });

    test("message oneof — foo case", () => {
      const foo = create(OneofMessageFooSchema, {
        name: "hello",
        toggle: true,
      });
      const msg = create(OneofMessageSchema, {
        message: { case: "foo", value: foo },
      });
      const slow = toBinary(OneofMessageSchema, msg);
      const fast = toBinaryFast(OneofMessageSchema, msg);
      assert.deepStrictEqual(Array.from(fast), Array.from(slow));
    });

    test("message oneof — bar case", () => {
      const bar = create(OneofMessageBarSchema, { a: 3, b: 4 });
      const msg = create(OneofMessageSchema, {
        message: { case: "bar", value: bar },
      });
      const slow = toBinary(OneofMessageSchema, msg);
      const fast = toBinaryFast(OneofMessageSchema, msg);
      assert.deepStrictEqual(Array.from(fast), Array.from(slow));
    });

    test("enum oneof", () => {
      const msg = create(OneofMessageSchema, {
        enum: { case: "e", value: OneofEnum.A },
      });
      const slow = toBinary(OneofMessageSchema, msg);
      const fast = toBinaryFast(OneofMessageSchema, msg);
      assert.deepStrictEqual(Array.from(fast), Array.from(slow));
    });

    test("multiple oneof groups each contribute their selected case", () => {
      const foo = create(OneofMessageFooSchema, { name: "n", toggle: false });
      const msg = create(OneofMessageSchema, {
        scalar: { case: "value", value: 7 },
        message: { case: "foo", value: foo },
        enum: { case: "e", value: OneofEnum.B },
      });
      const slow = toBinary(OneofMessageSchema, msg);
      const fast = toBinaryFast(OneofMessageSchema, msg);
      assert.deepStrictEqual(Array.from(fast), Array.from(slow));
    });

    test("empty oneofs emit nothing", () => {
      const msg = create(OneofMessageSchema, {});
      const slow = toBinary(OneofMessageSchema, msg);
      const fast = toBinaryFast(OneofMessageSchema, msg);
      assert.strictEqual(fast.length, 0);
      assert.deepStrictEqual(Array.from(fast), Array.from(slow));
    });
  });

  void suite("regression — scalars still match", () => {
    test("ScalarValuesMessage parity", () => {
      const msg = create(ScalarValuesMessageSchema, {
        doubleField: 0.75,
        floatField: -0.75,
        int64Field: protoInt64.parse(-1),
        uint64Field: protoInt64.uParse(1),
        int32Field: -123,
        fixed64Field: protoInt64.uParse(1),
        fixed32Field: 123,
        boolField: true,
        stringField: "hello world",
        bytesField: new Uint8Array([1, 2, 3]),
        uint32Field: 42,
        sfixed32Field: -42,
        sfixed64Field: protoInt64.parse(-42),
        sint32Field: -42,
        sint64Field: protoInt64.parse(-42),
      });
      const slow = toBinary(ScalarValuesMessageSchema, msg);
      const fast = toBinaryFast(ScalarValuesMessageSchema, msg);
      assert.deepStrictEqual(Array.from(fast), Array.from(slow));
    });
  });
});
