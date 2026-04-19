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

import { varint32read, varint64read } from "./varint.js";
import { protoInt64 } from "../proto-int64.js";
import { getTextEncoding } from "./text-encoding.js";

/**
 * Protobuf binary format wire types.
 *
 * A wire type provides just enough information to find the length of the
 * following value.
 *
 * See https://developers.google.com/protocol-buffers/docs/encoding#structure
 */
export enum WireType {
  /**
   * Used for int32, int64, uint32, uint64, sint32, sint64, bool, enum
   */
  Varint = 0,

  /**
   * Used for fixed64, sfixed64, double.
   * Always 8 bytes with little-endian byte order.
   */
  Bit64 = 1,

  /**
   * Used for string, bytes, embedded messages, packed repeated fields
   *
   * Only repeated numeric types (types which use the varint, 32-bit,
   * or 64-bit wire types) can be packed. In proto3, such fields are
   * packed by default.
   */
  LengthDelimited = 2,

  /**
   * Start of a tag-delimited aggregate, such as a proto2 group, or a message
   * in editions with message_encoding = DELIMITED.
   */
  StartGroup = 3,

  /**
   * End of a tag-delimited aggregate.
   */
  EndGroup = 4,

  /**
   * Used for fixed32, sfixed32, float.
   * Always 4 bytes with little-endian byte order.
   */
  Bit32 = 5,
}

/**
 * Maximum value for a 32-bit floating point value (Protobuf FLOAT).
 */
export const FLOAT32_MAX = 3.4028234663852886e38;

/**
 * Minimum value for a 32-bit floating point value (Protobuf FLOAT).
 */
export const FLOAT32_MIN = -3.4028234663852886e38;

/**
 * Maximum value for an unsigned 32-bit integer (Protobuf UINT32, FIXED32).
 */
export const UINT32_MAX = 0xffffffff;

/**
 * Maximum value for a signed 32-bit integer (Protobuf INT32, SFIXED32, SINT32).
 */
export const INT32_MAX = 0x7fffffff;

/**
 * Minimum value for a signed 32-bit integer (Protobuf INT32, SFIXED32, SINT32).
 */
export const INT32_MIN = -0x80000000;

/**
 * L0 contiguous-buffer BinaryWriter.
 *
 * Replaces the legacy chunk-list + scratch-array state with a single growable
 * Uint8Array plus an integer-offset stack for `fork()`/`join()` framing.
 *
 * Public wire surface is identical to the legacy writer (same 20 methods,
 * same signatures, byte-identical output). Three additive helpers
 * (`ensureCapacity`, `currentOffset`, `patchVarint32At`) are exposed for
 * upcoming L1/L2 consumers.
 *
 * Implementation notes:
 *  - D1/D2/D3: single Uint8Array, initial capacity 1024, 2× growth.
 *  - D4/D5/D6: fork/join use a 1-byte varint placeholder + `copyWithin` shift.
 *    Fork stack stores integer offsets only — no per-fork object allocation.
 *  - D7: `string()` probes for ASCII and writes bytes inline, falling back to
 *    the injected UTF-8 encoder for non-ASCII input.
 *  - D8: `finish()` returns `buf.subarray(0, pos)` — no extra copy. The
 *    returned view shares the writer's backing buffer. The writer is
 *    single-shot; construct a fresh instance per encode (D9).
 *  - D10: removed the `protected buf: number[]` field from the legacy writer.
 *  - D11: `DataView` cached and rebuilt on grow.
 *  - D13: int64 family uses a `typeof` tri-dispatch (number/bigint/string).
 */
export class BinaryWriter {
  /** Contiguous growable buffer. Bytes in [0, pos) are valid output. */
  private buf: Uint8Array;

  /** Write cursor. */
  private pos = 0;

  /** Lazy DataView over `buf`. Rebuilt on grow. */
  private view: DataView;

  /** Stack of reserved length-placeholder offsets for active forks. */
  private stack: number[] = [];

  /** Initial capacity used when resetting after `finish()`. */
  private readonly initialCapacity: number;

  /**
   * Set to `true` by `finish()` to indicate the next write must allocate a
   * fresh backing buffer. Defers the reset allocation from `finish()` to the
   * first reuse write, keeping the single-shot path (one encode per writer)
   * allocation-free beyond the encoded bytes themselves.
   */
  private dirtyAfterFinish = false;

  constructor(
    private readonly encodeUtf8: (
      text: string,
    ) => Uint8Array = getTextEncoding().encodeUtf8,
    initialCapacity: number = 1024,
  ) {
    const cap = initialCapacity > 0 ? initialCapacity : 1024;
    this.initialCapacity = cap;
    this.buf = new Uint8Array(cap);
    this.view = new DataView(this.buf.buffer, this.buf.byteOffset);
  }

  // ── Additive L0 API ─────────────────────────────────────────────────────

  /**
   * Ensure at least `n` additional bytes are writable at `pos`.
   *
   * Grows the backing buffer by doubling (at minimum) until it can hold
   * `pos + n` bytes. Invalidates and rebuilds the cached `DataView`.
   */
  ensureCapacity(n: number): void {
    // If the previous encode finished, swap in a fresh buffer before writing
    // so the returned subarray view stays stable.
    if (this.dirtyAfterFinish) {
      this.buf = new Uint8Array(this.initialCapacity);
      this.view = new DataView(this.buf.buffer, this.buf.byteOffset);
      this.dirtyAfterFinish = false;
    }
    const need = this.pos + n;
    const cur = this.buf.length;
    if (need <= cur) return;
    let cap = cur * 2;
    if (cap === 0) cap = 1024;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(next.buffer, next.byteOffset);
  }

  /**
   * Return the current write offset.
   */
  currentOffset(): number {
    return this.pos;
  }

  /**
   * Back-patch an unsigned 32-bit varint at a previously reserved offset.
   *
   * Contract: the caller is responsible for having reserved at least
   * `computeVarint32Size(value)` bytes at `offset`. No bounds check — this is
   * a performance primitive for L1/L2 consumers.
   */
  patchVarint32At(offset: number, value: number): void {
    this.writeVarint32At(offset, value >>> 0);
  }

  // ── Preserved public API ────────────────────────────────────────────────

  /**
   * Return all bytes written and reset this writer for reuse.
   *
   * The returned Uint8Array is a subarray view over the writer's previous
   * internal buffer — no copy is made. The writer installs a fresh buffer for
   * subsequent writes so the returned slice is not clobbered by reuse. As in
   * the legacy writer, the `stack` is cleared and `pos` reset to 0.
   */
  finish(): Uint8Array<ArrayBuffer> {
    const out = this.buf.subarray(0, this.pos) as Uint8Array<ArrayBuffer>;
    // Lazily swap buffers on the next write rather than here — keeps
    // single-shot encoding allocation-free beyond `out` itself.
    this.pos = 0;
    this.stack.length = 0;
    this.dirtyAfterFinish = true;
    return out;
  }

  /**
   * Start a new fork for length-delimited data like a message or a packed
   * repeated field. Reserves a single-byte placeholder for the payload length
   * varint; the caller writes the payload and then calls `join()`.
   *
   * Must be joined later with `join()`.
   */
  fork(): this {
    this.ensureCapacity(1);
    this.stack.push(this.pos);
    this.pos += 1;
    return this;
  }

  /**
   * Join the last fork. Computes the payload length, shifts the payload right
   * if the length varint needs more than one byte, then patches the varint at
   * the reserved placeholder offset.
   */
  join(): this {
    const placeholder = this.stack.pop();
    if (placeholder === undefined)
      throw new Error("invalid state, fork stack empty");
    const contentStart = placeholder + 1;
    const contentLen = this.pos - contentStart;
    const varintSize = computeVarint32Size(contentLen);
    if (varintSize > 1) {
      const shift = varintSize - 1;
      this.ensureCapacity(shift);
      this.buf.copyWithin(contentStart + shift, contentStart, this.pos);
      this.pos += shift;
    }
    this.writeVarint32At(placeholder, contentLen);
    return this;
  }

  /**
   * Writes a tag (field number and wire type).
   *
   * Equivalent to `uint32( (fieldNo << 3 | type) >>> 0 )`.
   *
   * Generated code should compute the tag ahead of time and call `uint32()`.
   */
  tag(fieldNo: number, type: WireType): this {
    return this.uint32(((fieldNo << 3) | type) >>> 0);
  }

  /**
   * Write a chunk of raw bytes.
   */
  raw(chunk: Uint8Array): this {
    const len = chunk.byteLength;
    this.ensureCapacity(len);
    this.buf.set(chunk, this.pos);
    this.pos += len;
    return this;
  }

  /**
   * Write a `uint32` value, an unsigned 32 bit varint.
   */
  uint32(value: number): this {
    assertUInt32(value);
    this.ensureCapacity(5);
    const buf = this.buf;
    let p = this.pos;
    if (value < 0x80) {
      buf[p++] = value;
    } else if (value < 0x4000) {
      buf[p++] = (value & 0x7f) | 0x80;
      buf[p++] = value >>> 7;
    } else if (value < 0x200000) {
      buf[p++] = (value & 0x7f) | 0x80;
      buf[p++] = ((value >>> 7) & 0x7f) | 0x80;
      buf[p++] = value >>> 14;
    } else if (value < 0x10000000) {
      buf[p++] = (value & 0x7f) | 0x80;
      buf[p++] = ((value >>> 7) & 0x7f) | 0x80;
      buf[p++] = ((value >>> 14) & 0x7f) | 0x80;
      buf[p++] = value >>> 21;
    } else {
      buf[p++] = (value & 0x7f) | 0x80;
      buf[p++] = ((value >>> 7) & 0x7f) | 0x80;
      buf[p++] = ((value >>> 14) & 0x7f) | 0x80;
      buf[p++] = ((value >>> 21) & 0x7f) | 0x80;
      buf[p++] = value >>> 28;
    }
    this.pos = p;
    return this;
  }

  /**
   * Write a `int32` value, a signed 32 bit varint.
   */
  int32(value: number): this {
    assertInt32(value);
    if (value >= 0) {
      // Same as uint32 varint encoding for non-negative values.
      this.ensureCapacity(5);
      const buf = this.buf;
      let p = this.pos;
      if (value < 0x80) {
        buf[p++] = value;
      } else if (value < 0x4000) {
        buf[p++] = (value & 0x7f) | 0x80;
        buf[p++] = value >>> 7;
      } else if (value < 0x200000) {
        buf[p++] = (value & 0x7f) | 0x80;
        buf[p++] = ((value >>> 7) & 0x7f) | 0x80;
        buf[p++] = value >>> 14;
      } else if (value < 0x10000000) {
        buf[p++] = (value & 0x7f) | 0x80;
        buf[p++] = ((value >>> 7) & 0x7f) | 0x80;
        buf[p++] = ((value >>> 14) & 0x7f) | 0x80;
        buf[p++] = value >>> 21;
      } else {
        buf[p++] = (value & 0x7f) | 0x80;
        buf[p++] = ((value >>> 7) & 0x7f) | 0x80;
        buf[p++] = ((value >>> 14) & 0x7f) | 0x80;
        buf[p++] = ((value >>> 21) & 0x7f) | 0x80;
        buf[p++] = value >>> 28;
      }
      this.pos = p;
    } else {
      // Negative int32 is sign-extended to 10-byte varint (matching the
      // legacy `varint32write` negative path).
      this.ensureCapacity(10);
      const buf = this.buf;
      let p = this.pos;
      let v = value;
      for (let i = 0; i < 9; i++) {
        buf[p++] = (v & 0x7f) | 0x80;
        v = v >> 7;
      }
      buf[p++] = 1;
      this.pos = p;
    }
    return this;
  }

  /**
   * Write a `bool` value, a varint.
   */
  bool(value: boolean): this {
    this.ensureCapacity(1);
    this.buf[this.pos++] = value ? 1 : 0;
    return this;
  }

  /**
   * Write a `bytes` value, length-delimited arbitrary data.
   */
  bytes(value: Uint8Array): this {
    const len = value.byteLength;
    this.uint32(len);
    this.ensureCapacity(len);
    this.buf.set(value, this.pos);
    this.pos += len;
    return this;
  }

  /**
   * Write a `string` value, length-delimited data converted to UTF-8 text.
   *
   * Uses a single-pass ASCII fast path: if every code unit is ≤ 0x7f, bytes
   * are written inline without invoking `TextEncoder`. Otherwise falls back
   * to the injected UTF-8 encoder. Non-string inputs are routed through the
   * encoder (which coerces via `String()`), matching legacy behaviour.
   */
  string(value: string): this {
    if (typeof value === "string") {
      const len = value.length;
      // Single-pass ASCII probe.
      let isAscii = true;
      for (let i = 0; i < len; i++) {
        if (value.charCodeAt(i) > 0x7f) {
          isAscii = false;
          break;
        }
      }
      if (isAscii) {
        this.uint32(len);
        this.ensureCapacity(len);
        const buf = this.buf;
        let p = this.pos;
        for (let i = 0; i < len; i++) {
          buf[p++] = value.charCodeAt(i);
        }
        this.pos = p;
        return this;
      }
    }
    // Fallback: non-string or non-ASCII — let the injected encoder handle it.
    const bytes = this.encodeUtf8(value);
    const blen = bytes.byteLength;
    this.uint32(blen);
    this.ensureCapacity(blen);
    this.buf.set(bytes, this.pos);
    this.pos += blen;
    return this;
  }

  /**
   * Write a `float` value, 32-bit floating point number.
   */
  float(value: number): this {
    assertFloat32(value);
    this.ensureCapacity(4);
    this.view.setFloat32(this.pos, value, true);
    this.pos += 4;
    return this;
  }

  /**
   * Write a `double` value, a 64-bit floating point number.
   */
  double(value: number): this {
    this.ensureCapacity(8);
    this.view.setFloat64(this.pos, value, true);
    this.pos += 8;
    return this;
  }

  /**
   * Write a `fixed32` value, an unsigned, fixed-length 32-bit integer.
   */
  fixed32(value: number): this {
    assertUInt32(value);
    this.ensureCapacity(4);
    this.view.setUint32(this.pos, value, true);
    this.pos += 4;
    return this;
  }

  /**
   * Write a `sfixed32` value, a signed, fixed-length 32-bit integer.
   */
  sfixed32(value: number): this {
    assertInt32(value);
    this.ensureCapacity(4);
    this.view.setInt32(this.pos, value, true);
    this.pos += 4;
    return this;
  }

  /**
   * Write a `sint32` value, a signed, zigzag-encoded 32-bit varint.
   */
  sint32(value: number): this {
    assertInt32(value);
    // zigzag encode
    const zz = ((value << 1) ^ (value >> 31)) >>> 0;
    // zz is unsigned 32-bit — reuse uint32 encoding path.
    this.ensureCapacity(5);
    const buf = this.buf;
    let p = this.pos;
    if (zz < 0x80) {
      buf[p++] = zz;
    } else if (zz < 0x4000) {
      buf[p++] = (zz & 0x7f) | 0x80;
      buf[p++] = zz >>> 7;
    } else if (zz < 0x200000) {
      buf[p++] = (zz & 0x7f) | 0x80;
      buf[p++] = ((zz >>> 7) & 0x7f) | 0x80;
      buf[p++] = zz >>> 14;
    } else if (zz < 0x10000000) {
      buf[p++] = (zz & 0x7f) | 0x80;
      buf[p++] = ((zz >>> 7) & 0x7f) | 0x80;
      buf[p++] = ((zz >>> 14) & 0x7f) | 0x80;
      buf[p++] = zz >>> 21;
    } else {
      buf[p++] = (zz & 0x7f) | 0x80;
      buf[p++] = ((zz >>> 7) & 0x7f) | 0x80;
      buf[p++] = ((zz >>> 14) & 0x7f) | 0x80;
      buf[p++] = ((zz >>> 21) & 0x7f) | 0x80;
      buf[p++] = zz >>> 28;
    }
    this.pos = p;
    return this;
  }

  /**
   * Write a `sfixed64` value, a signed, fixed-length 64-bit integer.
   */
  sfixed64(value: string | number | bigint): this {
    const lh = signedInt64LoHi(value);
    this.writeFixed64LoHi(lh.lo, lh.hi);
    return this;
  }

  /**
   * Write a `fixed64` value, an unsigned, fixed-length 64 bit integer.
   */
  fixed64(value: string | number | bigint): this {
    const lh = unsignedInt64LoHi(value);
    this.writeFixed64LoHi(lh.lo, lh.hi);
    return this;
  }

  /**
   * Write a `int64` value, a signed 64-bit varint.
   */
  int64(value: string | number | bigint): this {
    const lh = signedInt64LoHi(value);
    this.writeVarint64(lh.lo, lh.hi);
    return this;
  }

  /**
   * Write a `sint64` value, a signed, zig-zag-encoded 64-bit varint.
   */
  sint64(value: string | number | bigint): this {
    const lh = signedInt64LoHi(value);
    // zigzag encode
    const sign = lh.hi >> 31;
    const zLo = ((lh.lo << 1) ^ sign) >>> 0;
    const zHi = (((lh.hi << 1) | (lh.lo >>> 31)) ^ sign) >>> 0;
    this.writeVarint64(zLo, zHi);
    return this;
  }

  /**
   * Write a `uint64` value, an unsigned 64-bit varint.
   */
  uint64(value: string | number | bigint): this {
    const lh = unsignedInt64LoHi(value);
    this.writeVarint64(lh.lo, lh.hi);
    return this;
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  /**
   * Write an unsigned 32-bit varint at a given offset.
   *
   * Caller is responsible for ensuring the buffer has enough room at that
   * offset (via `ensureCapacity` or prior reservation).
   */
  private writeVarint32At(offset: number, v: number): void {
    const buf = this.buf;
    if (v < 0x80) {
      buf[offset] = v;
    } else if (v < 0x4000) {
      buf[offset] = (v & 0x7f) | 0x80;
      buf[offset + 1] = v >>> 7;
    } else if (v < 0x200000) {
      buf[offset] = (v & 0x7f) | 0x80;
      buf[offset + 1] = ((v >>> 7) & 0x7f) | 0x80;
      buf[offset + 2] = v >>> 14;
    } else if (v < 0x10000000) {
      buf[offset] = (v & 0x7f) | 0x80;
      buf[offset + 1] = ((v >>> 7) & 0x7f) | 0x80;
      buf[offset + 2] = ((v >>> 14) & 0x7f) | 0x80;
      buf[offset + 3] = v >>> 21;
    } else {
      buf[offset] = (v & 0x7f) | 0x80;
      buf[offset + 1] = ((v >>> 7) & 0x7f) | 0x80;
      buf[offset + 2] = ((v >>> 14) & 0x7f) | 0x80;
      buf[offset + 3] = ((v >>> 21) & 0x7f) | 0x80;
      buf[offset + 4] = v >>> 28;
    }
  }

  /**
   * Write 8 little-endian bytes for `fixed64` / `sfixed64` from 32-bit halves.
   */
  private writeFixed64LoHi(lo: number, hi: number): void {
    this.ensureCapacity(8);
    const buf = this.buf;
    const p = this.pos;
    buf[p] = lo & 0xff;
    buf[p + 1] = (lo >>> 8) & 0xff;
    buf[p + 2] = (lo >>> 16) & 0xff;
    buf[p + 3] = (lo >>> 24) & 0xff;
    buf[p + 4] = hi & 0xff;
    buf[p + 5] = (hi >>> 8) & 0xff;
    buf[p + 6] = (hi >>> 16) & 0xff;
    buf[p + 7] = (hi >>> 24) & 0xff;
    this.pos = p + 8;
  }

  /**
   * Write a 64-bit varint given as two 32-bit halves.
   *
   * Mirrors `varint64write` byte-for-byte but writes into the contiguous
   * buffer instead of pushing into a `number[]`.
   */
  private writeVarint64(lo: number, hi: number): void {
    this.ensureCapacity(10);
    const buf = this.buf;
    let p = this.pos;
    // First 4 bytes from `lo` (7 bits × 4 = 28 bits).
    for (let i = 0; i < 28; i += 7) {
      const shift = lo >>> i;
      const hasNext = !(shift >>> 7 === 0 && hi === 0);
      buf[p++] = (hasNext ? shift | 0x80 : shift) & 0xff;
      if (!hasNext) {
        this.pos = p;
        return;
      }
    }
    // The 5th byte splits across lo/hi.
    const splitBits = ((lo >>> 28) & 0x0f) | ((hi & 0x07) << 4);
    const hasMoreBits = !(hi >> 3 === 0);
    buf[p++] = (hasMoreBits ? splitBits | 0x80 : splitBits) & 0xff;
    if (!hasMoreBits) {
      this.pos = p;
      return;
    }
    // Remaining bytes from `hi` (7 bits at a time, shift starts at 3).
    for (let i = 3; i < 31; i += 7) {
      const shift = hi >>> i;
      const hasNext = !(shift >>> 7 === 0);
      buf[p++] = (hasNext ? shift | 0x80 : shift) & 0xff;
      if (!hasNext) {
        this.pos = p;
        return;
      }
    }
    // Final byte: top bit of hi.
    buf[p++] = (hi >>> 31) & 0x01;
    this.pos = p;
  }
}

/**
 * Shift amount used for extracting the high 32 bits of a bigint 64-bit value.
 *
 * A module-level constant avoids bigint literals (`32n`), which require
 * targeting ES2020 — this file targets ES2017 per tsconfig.base.json.
 */
const BIGINT_32: bigint = /*@__PURE__*/ BigInt(32);

/** Inclusive lower bound of signed int64 expressed as bigint. */
const INT64_MIN_BI: bigint = /*@__PURE__*/ BigInt("-9223372036854775808");
/** Inclusive upper bound of signed int64 expressed as bigint. */
const INT64_MAX_BI: bigint = /*@__PURE__*/ BigInt("9223372036854775807");
/** Inclusive upper bound of unsigned uint64 expressed as bigint. */
const UINT64_MAX_BI: bigint = /*@__PURE__*/ BigInt("18446744073709551615");
/** Zero as bigint (avoids `0n` literal on ES2017). */
const ZERO_BI: bigint = /*@__PURE__*/ BigInt(0);

/**
 * Inclusive upper bound of the fast number path in signed/unsigned lo-hi
 * splitters. Equals `2^53`. Computed via `2 ** 53` to avoid a numeric
 * literal whose absolute value reaches 2^53 (TypeScript warning 80008):
 * such literals cannot be represented accurately as integers in source.
 */
const POW_2_53: number = /*@__PURE__*/ 2 ** 53;

/** Inclusive lower bound of the fast number path for signed values. */
const NEG_POW_2_53: number = /*@__PURE__*/ -(2 ** 53);

/**
 * Return the number of bytes required to encode `v` as an unsigned 32-bit
 * varint. Pure helper used by `join()` and `patchVarint32At` callers.
 */
function computeVarint32Size(v: number): number {
  if (v < 0x80) return 1;
  if (v < 0x4000) return 2;
  if (v < 0x200000) return 3;
  if (v < 0x10000000) return 4;
  return 5;
}

/**
 * Split a signed 64-bit value into (lo, hi) 32-bit halves with two's
 * complement representation for negatives. Handles `number` (safe integer
 * fast path), `bigint` (range-checked), or string (delegated to protoInt64).
 *
 * Invalid inputs are delegated to `protoInt64.enc()` so error messages match
 * the legacy writer byte-for-byte.
 */
function signedInt64LoHi(value: string | number | bigint): {
  lo: number;
  hi: number;
} {
  const t = typeof value;
  if (t === "number") {
    const n = value as number;
    // Safe-integer fast path — must be a finite integer within the 53-bit
    // safe range. Otherwise fall through to protoInt64 for error parity.
    if (Number.isInteger(n) && n >= NEG_POW_2_53 && n <= POW_2_53) {
      if (n >= 0) {
        const lo = n >>> 0;
        const hi = ((n - lo) / 0x100000000) >>> 0;
        return { lo, hi };
      }
      const abs = -n;
      const aLo = abs >>> 0;
      const aHi = ((abs - aLo) / 0x100000000) >>> 0;
      // two's complement: ~abs + 1
      const lo = (~aLo + 1) >>> 0;
      const hi = (~aHi + (lo === 0 ? 1 : 0)) >>> 0;
      return { lo, hi };
    }
  } else if (t === "bigint") {
    const b = value as bigint;
    if (b >= INT64_MIN_BI && b <= INT64_MAX_BI) {
      const lo = Number(BigInt.asUintN(32, b)) >>> 0;
      const hi = Number(BigInt.asUintN(32, b >> BIGINT_32)) >>> 0;
      return { lo, hi };
    }
  }
  // Fallback: let protoInt64 validate and either encode the value or throw
  // with the exact error message format expected by the legacy writer.
  const tc = protoInt64.enc(value);
  return { lo: tc.lo, hi: tc.hi };
}

/**
 * Split an unsigned 64-bit value into (lo, hi) 32-bit halves. Mirrors
 * `signedInt64LoHi` but validates against the unsigned range; invalid
 * inputs are delegated to `protoInt64.uEnc()` for error parity.
 */
function unsignedInt64LoHi(value: string | number | bigint): {
  lo: number;
  hi: number;
} {
  const t = typeof value;
  if (t === "number") {
    const n = value as number;
    if (Number.isInteger(n) && n >= 0 && n <= POW_2_53) {
      const lo = n >>> 0;
      const hi = ((n - lo) / 0x100000000) >>> 0;
      return { lo, hi };
    }
  } else if (t === "bigint") {
    const b = value as bigint;
    if (b >= ZERO_BI && b <= UINT64_MAX_BI) {
      const lo = Number(BigInt.asUintN(32, b)) >>> 0;
      const hi = Number(BigInt.asUintN(32, b >> BIGINT_32)) >>> 0;
      return { lo, hi };
    }
  }
  const tc = protoInt64.uEnc(value);
  return { lo: tc.lo, hi: tc.hi };
}

export class BinaryReader {
  /**
   * Current position.
   */
  pos: number;

  /**
   * Number of bytes available in this reader.
   */
  readonly len: number;

  protected readonly buf: Uint8Array;
  private readonly view: DataView;

  constructor(
    buf: Uint8Array,
    private readonly decodeUtf8: (
      bytes: Uint8Array,
    ) => string = getTextEncoding().decodeUtf8,
  ) {
    this.buf = buf;
    this.len = buf.length;
    this.pos = 0;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  /**
   * Reads a tag - field number and wire type.
   */
  tag(): [number, WireType] {
    let tag = this.uint32(),
      fieldNo = tag >>> 3,
      wireType = tag & 7;
    if (fieldNo <= 0 || wireType < 0 || wireType > 5)
      throw new Error(
        "illegal tag: field no " + fieldNo + " wire type " + wireType,
      );
    return [fieldNo, wireType];
  }

  /**
   * Skip one element and return the skipped data.
   *
   * When skipping StartGroup, provide the tags field number to check for
   * matching field number in the EndGroup tag.
   */
  skip(wireType: WireType, fieldNo?: number): Uint8Array {
    let start = this.pos;
    switch (wireType) {
      case WireType.Varint:
        while (this.buf[this.pos++] & 0x80) {
          // ignore
        }
        break;
      // @ts-ignore TS7029: Fallthrough case in switch -- ignore instead of expect-error for compiler settings without noFallthroughCasesInSwitch: true
      case WireType.Bit64:
        this.pos += 4;
      case WireType.Bit32:
        this.pos += 4;
        break;
      case WireType.LengthDelimited:
        let len = this.uint32();
        this.pos += len;
        break;
      case WireType.StartGroup:
        for (;;) {
          const [fn, wt] = this.tag();
          if (wt === WireType.EndGroup) {
            if (fieldNo !== undefined && fn !== fieldNo) {
              throw new Error("invalid end group tag");
            }
            break;
          }
          this.skip(wt, fn);
        }
        break;
      default:
        throw new Error("cant skip wire type " + wireType);
    }
    this.assertBounds();
    return this.buf.subarray(start, this.pos);
  }

  protected varint64 = varint64read as () => [number, number]; // dirty cast for `this`

  /**
   * Throws error if position in byte array is out of range.
   */
  protected assertBounds(): void {
    if (this.pos > this.len) throw new RangeError("premature EOF");
  }

  /**
   * Read a `uint32` field, an unsigned 32 bit varint.
   */
  uint32: () => number = varint32read;

  /**
   * Read a `int32` field, a signed 32 bit varint.
   */
  int32(): number {
    return this.uint32() | 0;
  }

  /**
   * Read a `sint32` field, a signed, zigzag-encoded 32-bit varint.
   */
  sint32(): number {
    let zze = this.uint32();
    // decode zigzag
    return (zze >>> 1) ^ -(zze & 1);
  }

  /**
   * Read a `int64` field, a signed 64-bit varint.
   */
  int64(): bigint | string {
    return protoInt64.dec(...this.varint64());
  }

  /**
   * Read a `uint64` field, an unsigned 64-bit varint.
   */
  uint64(): bigint | string {
    return protoInt64.uDec(...this.varint64());
  }

  /**
   * Read a `sint64` field, a signed, zig-zag-encoded 64-bit varint.
   */
  sint64(): bigint | string {
    let [lo, hi] = this.varint64();
    // decode zig zag
    let s = -(lo & 1);
    lo = ((lo >>> 1) | ((hi & 1) << 31)) ^ s;
    hi = (hi >>> 1) ^ s;
    return protoInt64.dec(lo, hi);
  }

  /**
   * Read a `bool` field, a variant.
   */
  bool(): boolean {
    let [lo, hi] = this.varint64();
    return lo !== 0 || hi !== 0;
  }

  /**
   * Read a `fixed32` field, an unsigned, fixed-length 32-bit integer.
   */
  fixed32(): number {
    // biome-ignore lint/suspicious/noAssignInExpressions: no
    return this.view.getUint32((this.pos += 4) - 4, true);
  }

  /**
   * Read a `sfixed32` field, a signed, fixed-length 32-bit integer.
   */
  sfixed32(): number {
    // biome-ignore lint/suspicious/noAssignInExpressions: no
    return this.view.getInt32((this.pos += 4) - 4, true);
  }

  /**
   * Read a `fixed64` field, an unsigned, fixed-length 64 bit integer.
   */
  fixed64(): bigint | string {
    return protoInt64.uDec(this.sfixed32(), this.sfixed32());
  }

  /**
   * Read a `fixed64` field, a signed, fixed-length 64-bit integer.
   */
  sfixed64(): bigint | string {
    return protoInt64.dec(this.sfixed32(), this.sfixed32());
  }

  /**
   * Read a `float` field, 32-bit floating point number.
   */
  float(): number {
    // biome-ignore lint/suspicious/noAssignInExpressions: no
    return this.view.getFloat32((this.pos += 4) - 4, true);
  }

  /**
   * Read a `double` field, a 64-bit floating point number.
   */
  double(): number {
    // biome-ignore lint/suspicious/noAssignInExpressions: no
    return this.view.getFloat64((this.pos += 8) - 8, true);
  }

  /**
   * Read a `bytes` field, length-delimited arbitrary data.
   */
  bytes(): Uint8Array {
    let len = this.uint32(),
      start = this.pos;
    this.pos += len;
    this.assertBounds();
    return this.buf.subarray(start, start + len);
  }

  /**
   * Read a `string` field, length-delimited data converted to UTF-8 text.
   */
  string(): string {
    return this.decodeUtf8(this.bytes());
  }
}

/**
 * Assert a valid signed protobuf 32-bit integer as a number or string.
 */
function assertInt32(arg: unknown): asserts arg is number {
  if (typeof arg == "string") {
    arg = Number(arg);
  } else if (typeof arg != "number") {
    throw new Error("invalid int32: " + typeof arg);
  }
  if (
    !Number.isInteger(arg) ||
    (arg as number) > INT32_MAX ||
    (arg as number) < INT32_MIN
  )
    throw new Error("invalid int32: " + arg);
}

/**
 * Assert a valid unsigned protobuf 32-bit integer as a number or string.
 */
function assertUInt32(arg: unknown): asserts arg is number {
  if (typeof arg == "string") {
    arg = Number(arg);
  } else if (typeof arg != "number") {
    throw new Error("invalid uint32: " + typeof arg);
  }
  if (
    !Number.isInteger(arg) ||
    (arg as number) > UINT32_MAX ||
    (arg as number) < 0
  )
    throw new Error("invalid uint32: " + arg);
}

/**
 * Assert a valid protobuf float value as a number or string.
 */
function assertFloat32(arg: unknown): asserts arg is number {
  if (typeof arg == "string") {
    const o = arg;
    arg = Number(arg);
    if (Number.isNaN(arg as number) && o !== "NaN") {
      throw new Error("invalid float32: " + o);
    }
  } else if (typeof arg != "number") {
    throw new Error("invalid float32: " + typeof arg);
  }
  if (
    Number.isFinite(arg) &&
    ((arg as number) > FLOAT32_MAX || (arg as number) < FLOAT32_MIN)
  )
    throw new Error("invalid float32: " + arg);
}
