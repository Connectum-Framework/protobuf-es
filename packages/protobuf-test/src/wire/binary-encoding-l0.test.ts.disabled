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
import { BinaryReader, BinaryWriter, WireType } from "@bufbuild/protobuf/wire";

/**
 * L0 contiguous-buffer BinaryWriter — targeted tests covering behaviours
 * introduced by the rewrite (spec §8.2): buffer growth, placeholder-and-shift
 * fork/join, ASCII fast-path, int64 tri-dispatch, and the additive API.
 */
void suite("BinaryWriter (L0 contiguous-buffer)", () => {
  void suite("ensureCapacity growth", () => {
    void test("grows past the initial 1,024-byte capacity", () => {
      const writer = new BinaryWriter();
      // Writing a large `raw` chunk forces at least one grow.
      const payload = new Uint8Array(4096);
      for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
      writer.raw(payload);
      const bytes = writer.finish();
      assert.strictEqual(bytes.byteLength, 4096);
      assert.deepStrictEqual(bytes, payload);
    });

    void test("single grow satisfies a request larger than 2× current", () => {
      const writer = new BinaryWriter();
      // 100 KB in one shot — growth loop must keep doubling.
      const big = new Uint8Array(100_000);
      big[0] = 0x42;
      big[big.length - 1] = 0x77;
      writer.raw(big);
      const bytes = writer.finish();
      assert.strictEqual(bytes.byteLength, 100_000);
      assert.strictEqual(bytes[0], 0x42);
      assert.strictEqual(bytes[bytes.length - 1], 0x77);
    });

    void test("repeated small grows do not lose previously written bytes", () => {
      // Tiny initial capacity exercises the growth path every few writes.
      const writer = new BinaryWriter(undefined, 4);
      const expected: number[] = [];
      for (let i = 0; i < 500; i++) {
        writer.uint32(i);
        // mirror the encoding we expect to see back
        let v = i;
        while (v > 0x7f) {
          expected.push((v & 0x7f) | 0x80);
          v = v >>> 7;
        }
        expected.push(v);
      }
      assert.deepStrictEqual(Array.from(writer.finish()), expected);
    });
  });

  void suite("fork/join placeholder shift", () => {
    // Every boundary where the length varint size changes.
    for (const len of [0, 1, 127, 128, 16_383, 16_384, 2_097_151, 2_097_152]) {
      void test(`length ${len} produces byte-identical framing`, () => {
        const payload = new Uint8Array(len);
        for (let i = 0; i < len; i++) payload[i] = i & 0xff;
        // Build via fork/join
        const forked = new BinaryWriter()
          .tag(1, WireType.LengthDelimited)
          .fork()
          .raw(payload)
          .join()
          .finish();
        // Build via explicit length-prefix
        const explicit = new BinaryWriter()
          .tag(1, WireType.LengthDelimited)
          .uint32(len)
          .raw(payload)
          .finish();
        assert.deepStrictEqual(forked, explicit);
      });
    }
  });

  void test("nested fork/join at depth 10 round-trips", () => {
    const writer = new BinaryWriter();
    const depth = 10;
    for (let i = 0; i < depth; i++) {
      writer.tag(1, WireType.LengthDelimited).fork();
    }
    writer.tag(2, WireType.Varint).uint32(42);
    for (let i = 0; i < depth; i++) {
      writer.join();
    }
    const bytes = writer.finish();
    // Decode back down the same chain
    let reader: BinaryReader = new BinaryReader(bytes);
    for (let i = 0; i < depth; i++) {
      const [fieldNo, wire] = reader.tag();
      assert.strictEqual(fieldNo, 1);
      assert.strictEqual(wire, WireType.LengthDelimited);
      reader = new BinaryReader(reader.bytes());
    }
    const [leafFieldNo, leafWire] = reader.tag();
    assert.strictEqual(leafFieldNo, 2);
    assert.strictEqual(leafWire, WireType.Varint);
    assert.strictEqual(reader.uint32(), 42);
  });

  void test("join() without matching fork() throws", () => {
    assert.throws(() => new BinaryWriter().join(), {
      message: /invalid state, fork stack empty/,
    });
  });

  void suite("string ASCII fast-path / UTF-8 fallback", () => {
    for (const s of [
      "",
      "GET",
      "trace_id",
      "0123456789abcdef",
      "a".repeat(2048), // forces multiple grows on a small-cap writer
      "\u00e9", // é — non-ASCII, 2-byte UTF-8
      "hello \ud83d\ude00!", // smiley emoji, 4-byte UTF-8
      "mixed ASCII and café", // mixed
    ]) {
      void test(`round-trips "${s.length > 20 ? s.slice(0, 20) + "…" : s}"`, () => {
        const bytes = new BinaryWriter()
          .tag(1, WireType.LengthDelimited)
          .string(s)
          .finish();
        const reader = new BinaryReader(bytes);
        const [fieldNo, wire] = reader.tag();
        assert.strictEqual(fieldNo, 1);
        assert.strictEqual(wire, WireType.LengthDelimited);
        assert.strictEqual(reader.string(), s);
      });
    }
  });

  void suite("int64 family — tri-dispatch parity", () => {
    const cases: { name: string; val: number | bigint | string }[] = [
      { name: "number 0", val: 0 },
      { name: "number small", val: 123 },
      { name: "number 2^31", val: 0x80000000 },
      { name: "number 2^52", val: 0x10000000000000 },
      { name: "bigint 0n", val: BigInt(0) },
      { name: "bigint 1n", val: BigInt(1) },
      { name: "bigint max positive", val: BigInt("9223372036854775807") },
      { name: "string 0", val: "0" },
      {
        name: "string max positive",
        val: "9223372036854775807",
      },
    ];
    for (const kase of cases) {
      void test(`uint64 ${kase.name}`, () => {
        const n = new BinaryWriter().uint64(kase.val).finish();
        // Re-encode the same value as a string (canonical path) and compare
        const s = new BinaryWriter().uint64(String(kase.val)).finish();
        assert.deepStrictEqual(n, s);
      });
      void test(`fixed64 ${kase.name}`, () => {
        const n = new BinaryWriter().fixed64(kase.val).finish();
        const s = new BinaryWriter().fixed64(String(kase.val)).finish();
        assert.deepStrictEqual(n, s);
      });
    }
    const signedCases: { name: string; val: number | bigint | string }[] = [
      { name: "bigint -1n", val: BigInt(-1) },
      { name: "bigint min negative", val: BigInt("-9223372036854775808") },
      { name: "number -1", val: -1 },
      { name: "string -1", val: "-1" },
    ];
    for (const kase of signedCases) {
      void test(`int64 ${kase.name}`, () => {
        const n = new BinaryWriter().int64(kase.val).finish();
        const s = new BinaryWriter().int64(String(kase.val)).finish();
        assert.deepStrictEqual(n, s);
      });
      void test(`sfixed64 ${kase.name}`, () => {
        const n = new BinaryWriter().sfixed64(kase.val).finish();
        const s = new BinaryWriter().sfixed64(String(kase.val)).finish();
        assert.deepStrictEqual(n, s);
      });
    }
  });

  void suite("additive API", () => {
    void test("currentOffset reports write position", () => {
      const writer = new BinaryWriter();
      assert.strictEqual(writer.currentOffset(), 0);
      writer.tag(1, WireType.Varint);
      assert.strictEqual(writer.currentOffset(), 1);
      writer.uint32(200);
      assert.strictEqual(writer.currentOffset(), 3);
    });

    void test("ensureCapacity makes the writer idempotent for re-use", () => {
      const writer = new BinaryWriter();
      writer.ensureCapacity(1_000_000);
      writer.uint32(7);
      assert.deepStrictEqual(Array.from(writer.finish()), [7]);
    });

    void test("patchVarint32At writes identical bytes to uint32()", () => {
      // Reserve 1 byte (enough for small values), patch, compare to a direct
      // `uint32` encoding.
      const writer = new BinaryWriter();
      const offset = writer.currentOffset();
      writer.ensureCapacity(1);
      writer.raw(new Uint8Array(1)); // reserve
      writer.patchVarint32At(offset, 42);
      const patched = writer.finish();
      const direct = new BinaryWriter().uint32(42).finish();
      assert.deepStrictEqual(patched, direct);
    });

    void test("patchVarint32At handles multi-byte varints when fully reserved", () => {
      const writer = new BinaryWriter();
      // 300 encodes as 2 bytes (`0xac 0x02`); reserve 2.
      const offset = writer.currentOffset();
      writer.ensureCapacity(2);
      writer.raw(new Uint8Array(2));
      writer.patchVarint32At(offset, 300);
      const patched = writer.finish();
      const direct = new BinaryWriter().uint32(300).finish();
      assert.deepStrictEqual(patched, direct);
    });
  });

  void test("finish returns a stable view even after writer re-use", () => {
    const writer = new BinaryWriter();
    writer.tag(1, WireType.Varint).uint32(42);
    const first = writer.finish();
    // Re-use writer: the legacy test expects identical output.
    writer.tag(1, WireType.Varint).uint32(42);
    const second = writer.finish();
    assert.deepStrictEqual(first, second);
    // The first slice should remain untouched after additional writes on the
    // new backing buffer.
    writer.tag(1, WireType.Varint).uint32(99);
    writer.finish();
    assert.deepStrictEqual(Array.from(first), Array.from(second));
  });
});
