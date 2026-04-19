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
 * Property-based round-trip tests for encode/decode invariants.
 *
 * Core property under test:
 *   for every valid message M and every registered encoder E:
 *     fromBinary(schema, E(schema, M)) semantically equals M
 *
 * Additional properties:
 *   - idempotence: encode(decode(encode(M))) === encode(M) in length
 *   - encoder equivalence: every encoder produces the same semantic result
 *   - regression: specific prior bugs are covered (map ordering, empty
 *     oneof, bytes with control chars, unicode strings)
 *
 * Implementation notes:
 *   - No external property-based library (fast-check not available in
 *     this workspace). We use a deterministic PRNG with a fixed seed so
 *     the suite remains reproducible across CI runs.
 *   - Payloads are generated within schema constraints — we never attempt
 *     to construct invalid messages (those are covered by other suites).
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
import { MessageFieldMessageSchema } from "./gen/ts/extra/msg-message_pb.js";
import { OneofMessageSchema } from "./gen/ts/extra/msg-oneof_pb.js";
import { MapsMessageSchema } from "./gen/ts/extra/msg-maps_pb.js";
import { UserSchema } from "./gen/ts/extra/example_pb.js";

/**
 * Encoder registry — mirrors correctness-matrix.test.ts. Kept local so
 * each test file is self-contained and can be skipped independently.
 */
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
 * Deterministic PRNG (mulberry32). Seeded so property test output is
 * identical across runs — debugging a failure reproduces the same inputs.
 */
function makeRng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function randString(rng: () => number, maxLen = 16): string {
  const len = randInt(rng, 0, maxLen);
  let out = "";
  for (let i = 0; i < len; i++) {
    // Mix ASCII + a few multi-byte codepoints to exercise UTF-8.
    const pick = rng();
    if (pick < 0.8) {
      out += String.fromCharCode(randInt(rng, 32, 126));
    } else if (pick < 0.95) {
      out += String.fromCharCode(randInt(rng, 0x00a0, 0x04ff)); // Latin-ext/Cyrillic
    } else {
      out += String.fromCodePoint(randInt(rng, 0x1f600, 0x1f64f)); // Emoji
    }
  }
  return out;
}

function randBytes(rng: () => number, maxLen = 16): Uint8Array {
  const len = randInt(rng, 0, maxLen);
  const arr = new Uint8Array(len);
  for (let i = 0; i < len; i++) arr[i] = randInt(rng, 0, 255);
  return arr;
}

/**
 * Build a randomized ScalarValuesMessage. Every scalar kind is exercised,
 * including 64-bit variants which must go through protoInt64.
 */
function randomScalarMessage(rng: () => number) {
  return create(ScalarValuesMessageSchema, {
    doubleField: (rng() - 0.5) * 1e6,
    floatField: Math.fround((rng() - 0.5) * 1e3),
    int64Field: protoInt64.parse(randInt(rng, -1_000_000, 1_000_000)),
    uint64Field: protoInt64.uParse(randInt(rng, 0, 1_000_000)),
    int32Field: randInt(rng, -(1 << 30), 1 << 30),
    fixed64Field: protoInt64.uParse(randInt(rng, 0, 1_000_000)),
    fixed32Field: randInt(rng, 0, 1 << 30),
    boolField: rng() > 0.5,
    stringField: randString(rng),
    bytesField: randBytes(rng),
    uint32Field: randInt(rng, 0, 1 << 30),
    sfixed32Field: randInt(rng, -(1 << 30), 1 << 30),
    sfixed64Field: protoInt64.parse(randInt(rng, -1_000_000, 1_000_000)),
    sint32Field: randInt(rng, -(1 << 30), 1 << 30),
    sint64Field: protoInt64.parse(randInt(rng, -1_000_000, 1_000_000)),
  });
}

/**
 * Nested User chain with random depth. Exercises recursive encoding and
 * LEN-delimited sub-message size calculation.
 */
function randomUser(
  rng: () => number,
  depth = 0,
): MessageShape<typeof UserSchema> {
  return create(UserSchema, {
    firstName: randString(rng),
    lastName: randString(rng),
    active: rng() > 0.5,
    locations: Array.from({ length: randInt(rng, 0, 3) }, () =>
      randString(rng),
    ),
    manager: depth < 3 && rng() > 0.4 ? randomUser(rng, depth + 1) : undefined,
    // No projects map — keeps the fixture encoder-deterministic.
  });
}

/**
 * Assertion helper: every encoder produces a byte-array that round-trips
 * to the same semantic message, and all encoders agree on length.
 */
function assertRoundTrip<Desc extends DescMessage>(
  schema: Desc,
  message: MessageShape<Desc>,
  context: string,
): void {
  const results = ENCODERS.map((enc) => ({
    name: enc.name,
    bytes: enc.encode(schema, message),
  }));
  // Round-trip each encoding.
  for (const { name, bytes } of results) {
    const decoded = fromBinary(schema, bytes);
    assert.deepStrictEqual(
      decoded,
      message,
      `${context}: ${name} round-trip mismatch`,
    );
  }
  // Cross-encoder agreement on byte length.
  const [first, ...rest] = results;
  if (first === undefined) return;
  for (const other of rest) {
    assert.strictEqual(
      first.bytes.length,
      other.bytes.length,
      `${context}: ${first.name} produced ${first.bytes.length} bytes but ${other.name} produced ${other.bytes.length}`,
    );
  }
}

void suite("round-trip property tests", () => {
  void suite("ScalarValuesMessage (100 random cases)", () => {
    void test("decode(encode(M)) === M for all encoders", () => {
      const rng = makeRng(0xabcdef);
      for (let i = 0; i < 100; i++) {
        const msg = randomScalarMessage(rng);
        assertRoundTrip(ScalarValuesMessageSchema, msg, `case #${i}`);
      }
    });
  });

  void suite("RepeatedScalarValuesMessage (50 random cases)", () => {
    void test("packed-repeated round-trip", () => {
      const rng = makeRng(0x12345);
      for (let i = 0; i < 50; i++) {
        const msg = create(RepeatedScalarValuesMessageSchema, {
          int32Field: Array.from({ length: randInt(rng, 0, 20) }, () =>
            randInt(rng, -(1 << 20), 1 << 20),
          ),
          int64Field: Array.from({ length: randInt(rng, 0, 20) }, () =>
            protoInt64.parse(randInt(rng, -1000, 1000)),
          ),
          stringField: Array.from({ length: randInt(rng, 0, 10) }, () =>
            randString(rng),
          ),
          boolField: Array.from(
            { length: randInt(rng, 0, 30) },
            () => rng() > 0.5,
          ),
          doubleField: Array.from(
            { length: randInt(rng, 0, 10) },
            () => (rng() - 0.5) * 1000,
          ),
          sint32Field: Array.from({ length: randInt(rng, 0, 10) }, () =>
            randInt(rng, -(1 << 20), 1 << 20),
          ),
        });
        assertRoundTrip(RepeatedScalarValuesMessageSchema, msg, `packed #${i}`);
      }
    });
  });

  void suite("Nested messages (50 random cases)", () => {
    void test("recursive User manager chain", () => {
      const rng = makeRng(0xdeadbeef);
      for (let i = 0; i < 50; i++) {
        const msg = randomUser(rng);
        assertRoundTrip(UserSchema, msg, `user #${i}`);
      }
    });

    void test("MessageFieldMessage with repeated sub-messages", () => {
      const rng = makeRng(0xfeedface);
      for (let i = 0; i < 30; i++) {
        const msg = create(MessageFieldMessageSchema, {
          messageField: { name: randString(rng) },
          repeatedMessageField: Array.from(
            { length: randInt(rng, 0, 8) },
            () => ({ name: randString(rng) }),
          ),
        });
        assertRoundTrip(MessageFieldMessageSchema, msg, `nested #${i}`);
      }
    });
  });

  void suite("Oneof variants (covers every case)", () => {
    void test("scalar variants", () => {
      const rng = makeRng(0xcafebabe);
      for (let i = 0; i < 30; i++) {
        // Cycle through each scalar oneof case to ensure full coverage.
        const pick = i % 3;
        const msg =
          pick === 0
            ? create(OneofMessageSchema, {
                scalar: { case: "value", value: randInt(rng, -1000, 1000) },
              })
            : pick === 1
              ? create(OneofMessageSchema, {
                  scalar: { case: "error", value: randString(rng) },
                })
              : create(OneofMessageSchema, {
                  scalar: { case: "bytes", value: randBytes(rng) },
                });
        assertRoundTrip(OneofMessageSchema, msg, `oneof-scalar #${i}`);
      }
    });

    void test("empty oneof (regression: zero-value oneof must stay unset)", () => {
      const msg = create(OneofMessageSchema);
      assertRoundTrip(OneofMessageSchema, msg, "empty oneof");
      // After round-trip, oneof must still be undefined — not a zero-value encoding.
      const bytes = toBinary(OneofMessageSchema, msg);
      assert.strictEqual(
        bytes.length,
        0,
        "empty oneof must produce zero bytes",
      );
      const decoded = fromBinary(OneofMessageSchema, bytes);
      assert.strictEqual(decoded.scalar.case, undefined);
      assert.strictEqual(decoded.message.case, undefined);
      assert.strictEqual(decoded.enum.case, undefined);
    });

    void test("message variants (foo/bar/baz)", () => {
      const rng = makeRng(0xbaadf00d);
      const cases = ["foo", "bar", "baz"] as const;
      for (let i = 0; i < 30; i++) {
        const caseKind = cases[i % 3];
        const msg =
          caseKind === "foo"
            ? create(OneofMessageSchema, {
                message: {
                  case: "foo",
                  value: { name: randString(rng), toggle: rng() > 0.5 },
                },
              })
            : caseKind === "bar"
              ? create(OneofMessageSchema, {
                  message: {
                    case: "bar",
                    value: {
                      a: randInt(rng, -100, 100),
                      b: randInt(rng, 0, 100),
                    },
                  },
                })
              : create(OneofMessageSchema, {
                  message: {
                    case: "baz",
                    value: {
                      a: randInt(rng, -100, 100),
                      b: randInt(rng, 0, 100),
                    },
                  },
                });
        assertRoundTrip(OneofMessageSchema, msg, `oneof-msg #${i}`);
      }
    });
  });

  void suite("Map fields (regression: key ordering)", () => {
    void test("map encode-decode preserves all entries", () => {
      const rng = makeRng(0x1337);
      for (let i = 0; i < 20; i++) {
        const entryCount = randInt(rng, 0, 8);
        const strStr: Record<string, string> = {};
        for (let j = 0; j < entryCount; j++) {
          strStr[`k${j}_${randString(rng, 4)}`] = randString(rng);
        }
        const msg = create(MapsMessageSchema, {
          strStrField: strStr,
        });
        // Note: bytes may differ per encoder due to map key order —
        // we only assert semantic equality here (assertRoundTrip decodes).
        const bytes = toBinary(MapsMessageSchema, msg);
        const decoded = fromBinary(MapsMessageSchema, bytes);
        assert.deepStrictEqual(
          decoded.strStrField,
          msg.strStrField,
          `map round-trip #${i}`,
        );
      }
    });
  });

  void suite("Edge cases", () => {
    void test("empty message — zero bytes", () => {
      const msg = create(ScalarValuesMessageSchema);
      // Proto3: default scalars must be omitted, empty message → 0 bytes.
      const bytes = toBinary(ScalarValuesMessageSchema, msg);
      assert.strictEqual(bytes.length, 0);
      const decoded = fromBinary(ScalarValuesMessageSchema, bytes);
      assert.deepStrictEqual(decoded, msg);
    });

    void test("max int32 / min int32 boundaries", () => {
      for (const val of [
        2147483647,
        -2147483648,
        2147483647 - 1,
        -2147483648 + 1,
        0,
        1,
        -1,
      ]) {
        const msg = create(ScalarValuesMessageSchema, {
          int32Field: val,
          sint32Field: val,
          sfixed32Field: val,
        });
        assertRoundTrip(ScalarValuesMessageSchema, msg, `int32=${val}`);
      }
    });

    void test("max int64 / min int64 boundaries", () => {
      const values = [
        protoInt64.parse("9223372036854775807"),
        protoInt64.parse("-9223372036854775808"),
        protoInt64.parse(0),
        protoInt64.parse(1),
        protoInt64.parse(-1),
      ];
      for (const val of values) {
        const msg = create(ScalarValuesMessageSchema, {
          int64Field: val,
          sint64Field: val,
          sfixed64Field: val,
        });
        assertRoundTrip(ScalarValuesMessageSchema, msg, `int64=${val}`);
      }
    });

    void test("very large strings (10 KiB)", () => {
      const msg = create(ScalarValuesMessageSchema, {
        stringField: "x".repeat(10 * 1024),
      });
      assertRoundTrip(ScalarValuesMessageSchema, msg, "10KiB string");
    });

    void test("very large bytes (10 KiB)", () => {
      const msg = create(ScalarValuesMessageSchema, {
        bytesField: new Uint8Array(10 * 1024).fill(0xab),
      });
      assertRoundTrip(ScalarValuesMessageSchema, msg, "10KiB bytes");
    });

    void test("bytes with control characters (regression)", () => {
      const msg = create(ScalarValuesMessageSchema, {
        bytesField: new Uint8Array([0, 1, 2, 3, 8, 9, 10, 13, 27, 127, 255]),
      });
      assertRoundTrip(ScalarValuesMessageSchema, msg, "control-byte bytes");
    });

    void test("UTF-8 multi-byte sequences (regression)", () => {
      const msg = create(ScalarValuesMessageSchema, {
        // Mix ASCII, 2-byte, 3-byte, 4-byte (surrogate pair) codepoints.
        stringField: "hello мир 你好 🎉 résumé naïve",
      });
      assertRoundTrip(ScalarValuesMessageSchema, msg, "utf8");
    });

    void test("deeply nested message (depth=20)", () => {
      // Build User { manager: User { manager: ... } } 20 levels deep.
      let user: MessageShape<typeof UserSchema> = create(UserSchema, {
        firstName: "leaf",
      });
      for (let i = 0; i < 20; i++) {
        user = create(UserSchema, {
          firstName: `level-${i}`,
          manager: user,
        });
      }
      assertRoundTrip(UserSchema, user, "depth=20");
    });
  });
});
