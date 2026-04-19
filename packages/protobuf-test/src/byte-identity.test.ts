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
 * Byte-identity tests — strict assertions that encoders produce wire-format
 * bytes matching a pre-computed canonical reference.
 *
 * Why this matters:
 *   Semantic round-trip checks (see round-trip-property.test.ts) catch most
 *   regressions, but they cannot detect encoder divergence in areas where
 *   the proto spec allows flexibility (e.g. proto3 default omission,
 *   canonical varint encoding, packed-vs-unpacked repeated fields). This
 *   file pins down a small set of canonical cases where any deviation from
 *   the reference bytes is almost certainly a bug.
 *
 *   The reference bytes are captured from the stable `toBinary` output on
 *   main. When a new encoder is added to ENCODERS, it must match those
 *   bytes exactly.
 *
 *   If a legitimate wire-format change lands (rare, and would require an
 *   ADR), update the reference constants below.
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
import { OneofMessageSchema } from "./gen/ts/extra/msg-oneof_pb.js";
import { MapsMessageSchema } from "./gen/ts/extra/msg-maps_pb.js";

interface EncoderEntry {
  readonly name: string;
  readonly encode: <Desc extends DescMessage>(
    schema: Desc,
    message: MessageShape<Desc>,
  ) => Uint8Array;
}

const ENCODERS: readonly EncoderEntry[] = [
  { name: "toBinary", encode: (schema, message) => toBinary(schema, message) },
];

/**
 * Convert Uint8Array to hex string for readable diff output in failure
 * messages. We do not compare hex directly because we want each byte to
 * be individually assertable.
 */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
}

/**
 * Assert that every encoder produces the expected byte sequence.
 * Fails fast with a hex dump on mismatch.
 */
function assertBytes<Desc extends DescMessage>(
  schema: Desc,
  message: MessageShape<Desc>,
  expected: number[],
  context: string,
): void {
  for (const enc of ENCODERS) {
    const actual = enc.encode(schema, message);
    assert.deepStrictEqual(
      Array.from(actual),
      expected,
      `${context} / ${enc.name}: expected [${toHex(new Uint8Array(expected))}] got [${toHex(actual)}]`,
    );
    // Round-trip must also succeed.
    const decoded = fromBinary(schema, actual);
    assert.deepStrictEqual(
      decoded,
      message,
      `${context} / ${enc.name} round-trip`,
    );
  }
}

void suite("byte-identity: canonical wire format assertions", () => {
  void suite("proto3 default value omission", () => {
    void test("empty message → 0 bytes", () => {
      const msg = create(ScalarValuesMessageSchema);
      assertBytes(ScalarValuesMessageSchema, msg, [], "empty scalar message");
    });

    void test("explicit zero scalars are omitted", () => {
      const msg = create(ScalarValuesMessageSchema, {
        doubleField: 0,
        floatField: 0,
        int32Field: 0,
        uint32Field: 0,
        int64Field: protoInt64.parse(0),
        boolField: false,
        stringField: "",
        bytesField: new Uint8Array(),
      });
      // All defaults → no bytes emitted.
      assertBytes(ScalarValuesMessageSchema, msg, [], "zero scalars");
    });

    void test("non-default scalar is emitted with correct tag", () => {
      // int32 field = 5, field number 5 → tag = (5 << 3) | 0 = 0x28, value = 0x05
      const msg = create(ScalarValuesMessageSchema, { int32Field: 5 });
      assertBytes(
        ScalarValuesMessageSchema,
        msg,
        [0x28, 0x05],
        "single int32=5",
      );
    });
  });

  void suite("packed repeated scalar encoding (proto3 default)", () => {
    void test("repeated int32 uses packed encoding", () => {
      // int32 field = 5, packed → tag = (5 << 3) | 2 (LEN) = 0x2a
      // payload: varint 1, varint 2, varint 3 → length 3
      const msg = create(RepeatedScalarValuesMessageSchema, {
        int32Field: [1, 2, 3],
      });
      assertBytes(
        RepeatedScalarValuesMessageSchema,
        msg,
        [0x2a, 0x03, 0x01, 0x02, 0x03],
        "packed int32 [1,2,3]",
      );
    });

    void test("empty repeated is omitted entirely", () => {
      const msg = create(RepeatedScalarValuesMessageSchema, { int32Field: [] });
      assertBytes(
        RepeatedScalarValuesMessageSchema,
        msg,
        [],
        "empty repeated int32",
      );
    });

    void test("repeated bool packed", () => {
      // bool field = 8, tag = (8 << 3) | 2 = 0x42, payload 3 bytes [1,0,1]
      const msg = create(RepeatedScalarValuesMessageSchema, {
        boolField: [true, false, true],
      });
      assertBytes(
        RepeatedScalarValuesMessageSchema,
        msg,
        [0x42, 0x03, 0x01, 0x00, 0x01],
        "packed bool",
      );
    });

    void test("repeated string is NOT packed (LEN wire type per element)", () => {
      // string field = 9, each element gets its own tag.
      // tag = (9 << 3) | 2 = 0x4a
      // "a" → [0x4a, 0x01, 0x61], "b" → [0x4a, 0x01, 0x62]
      const msg = create(RepeatedScalarValuesMessageSchema, {
        stringField: ["a", "b"],
      });
      assertBytes(
        RepeatedScalarValuesMessageSchema,
        msg,
        [0x4a, 0x01, 0x61, 0x4a, 0x01, 0x62],
        "repeated string a,b",
      );
    });
  });

  void suite("oneof encoding", () => {
    void test("empty oneof produces no bytes", () => {
      const msg = create(OneofMessageSchema);
      assertBytes(OneofMessageSchema, msg, [], "empty oneof");
    });

    void test("oneof scalar=value with zero still emits", () => {
      // When a oneof case is set, the field IS emitted even if value is default.
      // scalar.value field = 1, tag = (1 << 3) | 0 = 0x08, value = 0
      const msg = create(OneofMessageSchema, {
        scalar: { case: "value", value: 0 },
      });
      assertBytes(
        OneofMessageSchema,
        msg,
        [0x08, 0x00],
        "oneof value=0 (explicit)",
      );
    });

    void test("oneof string empty still emits LEN=0", () => {
      // scalar.error field = 2, tag = (2 << 3) | 2 = 0x12, len=0
      const msg = create(OneofMessageSchema, {
        scalar: { case: "error", value: "" },
      });
      assertBytes(
        OneofMessageSchema,
        msg,
        [0x12, 0x00],
        "oneof empty string (explicit)",
      );
    });
  });

  void suite("UTF-8 encoding", () => {
    void test("ASCII string", () => {
      // string field = 9, tag = (9 << 3) | 2 = 0x4a
      const msg = create(ScalarValuesMessageSchema, { stringField: "abc" });
      assertBytes(
        ScalarValuesMessageSchema,
        msg,
        [0x4a, 0x03, 0x61, 0x62, 0x63],
        "ASCII abc",
      );
    });

    void test("multi-byte: Cyrillic (2 bytes each)", () => {
      // "мир" = 3 codepoints, 6 UTF-8 bytes
      const msg = create(ScalarValuesMessageSchema, { stringField: "мир" });
      assertBytes(
        ScalarValuesMessageSchema,
        msg,
        [0x4a, 0x06, 0xd0, 0xbc, 0xd0, 0xb8, 0xd1, 0x80],
        "Cyrillic мир",
      );
    });

    void test("4-byte codepoint: emoji", () => {
      // "🎉" = U+1F389, UTF-8 = F0 9F 8E 89 (4 bytes)
      const msg = create(ScalarValuesMessageSchema, { stringField: "🎉" });
      assertBytes(
        ScalarValuesMessageSchema,
        msg,
        [0x4a, 0x04, 0xf0, 0x9f, 0x8e, 0x89],
        "emoji 🎉",
      );
    });
  });

  void suite("varint encoding boundaries", () => {
    void test("single-byte varint (value < 128)", () => {
      // int32 field=5, value=127 → tag=0x28, varint=0x7f
      const msg = create(ScalarValuesMessageSchema, { int32Field: 127 });
      assertBytes(
        ScalarValuesMessageSchema,
        msg,
        [0x28, 0x7f],
        "int32=127 (1-byte varint)",
      );
    });

    void test("two-byte varint boundary (value = 128)", () => {
      // varint(128) = [0x80, 0x01]
      const msg = create(ScalarValuesMessageSchema, { int32Field: 128 });
      assertBytes(
        ScalarValuesMessageSchema,
        msg,
        [0x28, 0x80, 0x01],
        "int32=128 (2-byte varint)",
      );
    });

    void test("sint32 zigzag encoding (negative)", () => {
      // sint32 field=16, tag=(16<<3)|0=0x80,0x01 (2-byte tag)
      // zigzag(-1) = 1, varint(1) = 0x01
      const msg = create(ScalarValuesMessageSchema, { sint32Field: -1 });
      assertBytes(
        ScalarValuesMessageSchema,
        msg,
        [0x80, 0x01, 0x01],
        "sint32=-1 zigzag",
      );
    });
  });

  void suite("map field encoding (regression: ordering across runs)", () => {
    void test("single-entry map is deterministic", () => {
      // A single-entry map has no ordering ambiguity.
      // MapsMessage.str_str_field = 1, each entry is a LEN-delimited KV sub-message.
      const msg = create(MapsMessageSchema, {
        strStrField: { k: "v" },
      });
      // Same encoder must produce same bytes every call.
      const enc = ENCODERS[0];
      assert.ok(enc, "at least one encoder registered");
      const bytes1 = enc.encode(MapsMessageSchema, msg);
      const bytes2 = enc.encode(MapsMessageSchema, msg);
      assert.deepStrictEqual(
        Array.from(bytes1),
        Array.from(bytes2),
        "encoder must be deterministic for single-entry map",
      );
      // And round-trip must succeed.
      const decoded = fromBinary(MapsMessageSchema, bytes1);
      assert.deepStrictEqual(decoded.strStrField, { k: "v" });
    });
  });

  void suite("encoder determinism (same input → same bytes)", () => {
    void test("repeated encoding produces identical bytes", () => {
      const msg = create(ScalarValuesMessageSchema, {
        doubleField: 3.14,
        int32Field: 42,
        stringField: "hello",
        bytesField: new Uint8Array([1, 2, 3]),
      });
      for (const enc of ENCODERS) {
        const b1 = enc.encode(ScalarValuesMessageSchema, msg);
        const b2 = enc.encode(ScalarValuesMessageSchema, msg);
        const b3 = enc.encode(ScalarValuesMessageSchema, msg);
        assert.deepStrictEqual(
          Array.from(b1),
          Array.from(b2),
          `${enc.name}: run 1 vs 2`,
        );
        assert.deepStrictEqual(
          Array.from(b2),
          Array.from(b3),
          `${enc.name}: run 2 vs 3`,
        );
      }
    });
  });
});
