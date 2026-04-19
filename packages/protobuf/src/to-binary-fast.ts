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

// Experimental opt-in fast-path encoder.
//
// Pattern adapted from open-telemetry/opentelemetry-js#6390 (the
// ProtobufLogsSerializer in @opentelemetry/otlp-transformer), ported to
// protobuf-es' reflective encode. The existing BinaryWriter relies on
// fork/join per length-delimited field — every nested message and every
// packed repeated field pushes its accumulator onto a stack, serializes
// into its own list of chunks, then re-emits the length prefix and
// concatenates. On OTel-shaped workloads (deeply nested ResourceSpans →
// ScopeSpans → Span → KeyValue) that produces a lot of small allocations
// and a double copy on `finish()`.
//
// `toBinaryFast` instead makes two passes:
//   1) estimate the exact encoded size of every field by walking the
//      message graph and accumulating bytes-needed;
//   2) allocate a single Uint8Array of that size and write bytes into it
//      at fixed offsets.
//
// Because the estimate is exact, the write pass never reallocates, never
// copies, and never needs to stack fork/join state. Length prefixes are
// computed during pass 1 and cached so that pass 2 can write the varint
// before it descends into the submessage. The entire hot path lives in a
// single tight loop with no intermediate `Uint8Array`/`number[]` objects
// per field.
//
// Hot-path specialization (H3A): rather than re-dispatching on
// `field.fieldKind` and `field.scalar` for every field of every message
// instance, we precompute an array of closures per `DescMessage` the
// first time we touch that schema. Each closure pre-captures
// (tagBytes, localName, scalar-specific writer) so the inner loop is a
// flat `for (const step of steps) off = step(msg, ...)` — no switch,
// no property lookups per field. Step arrays are cached in a WeakMap
// keyed by `DescMessage` and live for the lifetime of the schema.
// CSP-safe: no `eval`, no `new Function()`, no dynamic source generation.
//
// Scope:
//   - supported:   scalar fields (all 15 types), enums, nested messages,
//                  repeated scalar (packed + unpacked), repeated message,
//                  map<K,V> for all legal K and any scalar/enum/message V,
//                  oneof groups
//   - unsupported: extensions, delimited/group encoding, unknown fields
//
// For unsupported schemas `toBinaryFast` falls back to the existing
// reflective `toBinary`. The decision is computed once per `DescMessage`
// and cached in a `WeakMap`, so the fallback check does not dominate the
// hot path after the first call.
//
// Output is semantic-identical to `toBinary`: `fromBinary(schema,
// toBinaryFast(schema, msg))` and `fromBinary(schema, toBinary(schema,
// msg))` produce structurally-equal messages. Byte-identical output is
// not guaranteed (field ordering matches descriptor order, which matches
// `toBinary`'s non-unknown path, but future tweaks may diverge).

import type { MessageShape } from "./types.js";
import {
  ScalarType,
  type DescField,
  type DescMessage,
  type DescOneof,
} from "./descriptors.js";
import { protoInt64 } from "./proto-int64.js";
import { toBinary } from "./to-binary.js";
import { getTextEncoding } from "./wire/text-encoding.js";

// -----------------------------------------------------------------------------
// Support detection
// -----------------------------------------------------------------------------

const supportCache = new WeakMap<DescMessage, boolean>();

// `0n` requires target >= ES2020, but this package is compiled for ES2017.
// Materialize the bigint zero once at module load so closures can compare
// against it without the BigInt() call on the hot path.
const BIGINT_ZERO = BigInt(0);

/**
 * Walk the descriptor (including transitive message fields) and return
 * true iff every field in the subtree uses an MVP-supported shape. The
 * result is cached per `DescMessage` — most schemas have small, bounded
 * field trees and the walk is cheap but not free, so we amortize.
 */
function isSupported(
  desc: DescMessage,
  visiting: Set<DescMessage> = new Set(),
): boolean {
  const cached = supportCache.get(desc);
  if (cached !== undefined) return cached;
  // Guard against recursive message types (e.g. google.protobuf.Value).
  // While a cycle is in flight we optimistically assume support; if a
  // descendant turns out to be unsupported, we overwrite the cache
  // entry below.
  if (visiting.has(desc)) return true;
  visiting.add(desc);

  let ok = true;
  for (const field of desc.fields) {
    // Delimited (group) encoding is not handled — the legacy wire format
    // requires paired start/end tags which don't fit the single-pass
    // write model. Map fields and message-typed map values cannot use
    // delimited encoding (enforced by the descriptor), so we only need
    // to check singular messages and repeated messages.
    if (
      (field.fieldKind === "message" ||
        (field.fieldKind === "list" && field.listKind === "message")) &&
      (field as { delimitedEncoding?: boolean }).delimitedEncoding === true
    ) {
      ok = false;
      break;
    }
    // Recurse into message fields.
    if (field.fieldKind === "message" && field.message) {
      if (!isSupported(field.message, visiting)) {
        ok = false;
        break;
      }
    }
    if (
      field.fieldKind === "list" &&
      field.listKind === "message" &&
      field.message
    ) {
      if (!isSupported(field.message, visiting)) {
        ok = false;
        break;
      }
    }
    // Recurse into map value messages.
    if (
      field.fieldKind === "map" &&
      field.mapKind === "message" &&
      field.message
    ) {
      if (!isSupported(field.message, visiting)) {
        ok = false;
        break;
      }
    }
  }
  visiting.delete(desc);
  supportCache.set(desc, ok);
  return ok;
}

// -----------------------------------------------------------------------------
// Wire format helpers
// -----------------------------------------------------------------------------

const WIRE_VARINT = 0;
const WIRE_BIT64 = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_BIT32 = 5;

/** Size in bytes of an unsigned 32-bit varint. */
function varintSize32(v: number): number {
  if (v < 0x80) return 1;
  if (v < 0x4000) return 2;
  if (v < 0x200000) return 3;
  if (v < 0x10000000) return 4;
  return 5;
}

/** Size in bytes of an int32 varint (negatives use 10 bytes). */
function int32Size(v: number): number {
  if (v < 0) return 10;
  return varintSize32(v);
}

/** Size of a zigzag-encoded 32-bit signed integer. */
function sint32Size(v: number): number {
  return varintSize32(((v << 1) ^ (v >> 31)) >>> 0);
}

/**
 * Size of a 64-bit varint given its (lo, hi) two's-complement halves.
 * The varint writer emits while (hi > 0 || lo > 0x7f) and then one more
 * byte, so we count in 7-bit chunks across the 64 bits.
 */
function varintSize64(lo: number, hi: number): number {
  // Normalize to uint32.
  let l = lo >>> 0;
  let h = hi >>> 0;
  let bytes = 1;
  while (h > 0 || l > 0x7f) {
    bytes++;
    l = ((l >>> 7) | (h << 25)) >>> 0;
    h >>>= 7;
  }
  return bytes;
}

function tagSize(fieldNo: number, wireType: number): number {
  return varintSize32(((fieldNo << 3) | wireType) >>> 0);
}

/**
 * Encode a tag as a pre-built Uint8Array once per field. At write time
 * we `buf.set(tagBytes, pos)` to blit the bytes — this removes both the
 * varint loop and the repeated `(fieldNo << 3) | wireType` work from the
 * hot path. Tag size is 1 byte for fields 1-15, 2 bytes up to 2047, etc.
 */
function encodeTag(fieldNo: number, wireType: number): Uint8Array {
  let v = ((fieldNo << 3) | wireType) >>> 0;
  const size = varintSize32(v);
  const out = new Uint8Array(size);
  let i = 0;
  while (v > 0x7f) {
    out[i++] = (v & 0x7f) | 0x80;
    v = v >>> 7;
  }
  out[i] = v;
  return out;
}

/**
 * UTF-8 byte length of a JS string without encoding. Mirrors the helper
 * used in opentelemetry-js#6390 — correct for valid UTF-16 input (which
 * all JS strings are). Surrogate pairs contribute 4 bytes.
 */
function utf8ByteLength(str: string): number {
  const len = str.length;
  let byteLen = 0;
  for (let i = 0; i < len; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x80) {
      byteLen += 1;
    } else if (code < 0x800) {
      byteLen += 2;
    } else if (code < 0xd800 || code >= 0xe000) {
      byteLen += 3;
    } else {
      // Lead of a surrogate pair — skip the trail, account for 4 bytes.
      i++;
      byteLen += 4;
    }
  }
  return byteLen;
}

// -----------------------------------------------------------------------------
// Encoded-size cache
// -----------------------------------------------------------------------------
//
// We compute the size of each submessage exactly once (pass 1) and reuse
// that number in pass 2 to write the length prefix. A WeakMap keyed by
// the message object isolates this state to the current toBinaryFast call
// without leaking across calls (the map itself is scoped to one encode).

type SizeMap = Map<object, number>;

// -----------------------------------------------------------------------------
// Scalar size / write — shared helpers
// -----------------------------------------------------------------------------

function scalarSize(type: ScalarType, value: unknown): number {
  switch (type) {
    case ScalarType.STRING: {
      const byteLen = utf8ByteLength(value as string);
      return varintSize32(byteLen) + byteLen;
    }
    case ScalarType.BOOL:
      return 1;
    case ScalarType.DOUBLE:
      return 8;
    case ScalarType.FLOAT:
      return 4;
    case ScalarType.INT32:
      return int32Size(value as number);
    case ScalarType.UINT32:
      return varintSize32((value as number) >>> 0);
    case ScalarType.SINT32:
      return sint32Size(value as number);
    case ScalarType.FIXED32:
    case ScalarType.SFIXED32:
      return 4;
    case ScalarType.INT64:
    case ScalarType.UINT64: {
      const tc =
        type === ScalarType.UINT64
          ? protoInt64.uEnc(value as string | number | bigint)
          : protoInt64.enc(value as string | number | bigint);
      return varintSize64(tc.lo, tc.hi);
    }
    case ScalarType.SINT64: {
      const tc = protoInt64.enc(value as string | number | bigint);
      const sign = tc.hi >> 31;
      const lo = (tc.lo << 1) ^ sign;
      const hi = ((tc.hi << 1) | (tc.lo >>> 31)) ^ sign;
      return varintSize64(lo, hi);
    }
    case ScalarType.FIXED64:
    case ScalarType.SFIXED64:
      return 8;
    case ScalarType.BYTES: {
      const b = value as Uint8Array;
      return varintSize32(b.length) + b.length;
    }
  }
  // Unreachable for well-formed descriptors; fall back to 0 so that
  // misconfigured types don't silently corrupt the buffer — the size/
  // write mismatch assertion will catch it.
  return 0;
}

function scalarWireType(type: ScalarType): number {
  switch (type) {
    case ScalarType.BYTES:
    case ScalarType.STRING:
      return WIRE_LENGTH_DELIMITED;
    case ScalarType.DOUBLE:
    case ScalarType.FIXED64:
    case ScalarType.SFIXED64:
      return WIRE_BIT64;
    case ScalarType.FIXED32:
    case ScalarType.SFIXED32:
    case ScalarType.FLOAT:
      return WIRE_BIT32;
    default:
      return WIRE_VARINT;
  }
}

// -----------------------------------------------------------------------------
// Map key helpers
// -----------------------------------------------------------------------------
//
// protobuf-es stores map fields as plain JS objects keyed by the stringified
// map key (see reflectMap.mapKeyToLocal). On the fast path we iterate
// `Object.keys`, so every key we see is a string. For integer and boolean
// map keys we parse back to the typed value before computing the scalar
// size or writing the scalar bytes — matching what the reflective encoder
// does via ReflectMap's iterator.

type MapKeyScalar = Exclude<
  ScalarType,
  ScalarType.FLOAT | ScalarType.DOUBLE | ScalarType.BYTES
>;

function coerceMapKey(stringKey: string, keyType: MapKeyScalar): unknown {
  switch (keyType) {
    case ScalarType.STRING:
      return stringKey;
    case ScalarType.BOOL:
      // Object keys for boolean maps are always "true" / "false" strings.
      return stringKey === "true";
    case ScalarType.INT64:
    case ScalarType.SINT64:
    case ScalarType.SFIXED64:
      return protoInt64.parse(stringKey);
    case ScalarType.UINT64:
    case ScalarType.FIXED64:
      return protoInt64.uParse(stringKey);
    default:
      // INT32, SINT32, FIXED32, SFIXED32, UINT32 — parse back to number.
      return Number.parseInt(stringKey, 10);
  }
}

// -----------------------------------------------------------------------------
// Cursor — mutable writer state bundled for closure access
// -----------------------------------------------------------------------------

interface Cursor {
  buf: Uint8Array;
  view: DataView;
  pos: number;
  encodeUtf8: (s: string) => Uint8Array;
}

function writeVarint32(c: Cursor, v: number): void {
  // Callers pre-coerce to uint32 where needed.
  while (v > 0x7f) {
    c.buf[c.pos++] = (v & 0x7f) | 0x80;
    v = v >>> 7;
  }
  c.buf[c.pos++] = v;
}

function writeVarint64(c: Cursor, lo: number, hi: number): void {
  let l = lo >>> 0;
  let h = hi >>> 0;
  while (h > 0 || l > 0x7f) {
    c.buf[c.pos++] = (l & 0x7f) | 0x80;
    l = ((l >>> 7) | (h << 25)) >>> 0;
    h >>>= 7;
  }
  c.buf[c.pos++] = l & 0x7f;
}

function writeInt32(c: Cursor, v: number): void {
  // Negative int32 is sign-extended to 64 bits and written as 10-byte varint.
  if (v >= 0) {
    writeVarint32(c, v);
  } else {
    writeVarint64(c, v | 0, -1);
  }
}

function writeSInt32(c: Cursor, v: number): void {
  writeVarint32(c, ((v << 1) ^ (v >> 31)) >>> 0);
}

function writeScalar(c: Cursor, type: ScalarType, value: unknown): void {
  switch (type) {
    case ScalarType.STRING: {
      const s = value as string;
      // ASCII fast path: write char codes directly; otherwise materialize
      // via TextEncoder. Size was already accounted for.
      let isAscii = true;
      const len = s.length;
      for (let i = 0; i < len; i++) {
        if (s.charCodeAt(i) > 127) {
          isAscii = false;
          break;
        }
      }
      if (isAscii) {
        writeVarint32(c, len);
        for (let i = 0; i < len; i++) {
          c.buf[c.pos++] = s.charCodeAt(i);
        }
      } else {
        const bytes = c.encodeUtf8(s);
        writeVarint32(c, bytes.length);
        c.buf.set(bytes, c.pos);
        c.pos += bytes.length;
      }
      return;
    }
    case ScalarType.BOOL:
      c.buf[c.pos++] = (value as boolean) ? 1 : 0;
      return;
    case ScalarType.DOUBLE:
      c.view.setFloat64(c.pos, value as number, true);
      c.pos += 8;
      return;
    case ScalarType.FLOAT:
      c.view.setFloat32(c.pos, value as number, true);
      c.pos += 4;
      return;
    case ScalarType.INT32:
      writeInt32(c, value as number);
      return;
    case ScalarType.UINT32:
      writeVarint32(c, (value as number) >>> 0);
      return;
    case ScalarType.SINT32:
      writeSInt32(c, value as number);
      return;
    case ScalarType.FIXED32:
      c.view.setUint32(c.pos, (value as number) >>> 0, true);
      c.pos += 4;
      return;
    case ScalarType.SFIXED32:
      c.view.setInt32(c.pos, value as number, true);
      c.pos += 4;
      return;
    case ScalarType.INT64:
    case ScalarType.UINT64: {
      const tc =
        type === ScalarType.UINT64
          ? protoInt64.uEnc(value as string | number | bigint)
          : protoInt64.enc(value as string | number | bigint);
      writeVarint64(c, tc.lo, tc.hi);
      return;
    }
    case ScalarType.SINT64: {
      const tc = protoInt64.enc(value as string | number | bigint);
      const sign = tc.hi >> 31;
      const lo = (tc.lo << 1) ^ sign;
      const hi = ((tc.hi << 1) | (tc.lo >>> 31)) ^ sign;
      writeVarint64(c, lo, hi);
      return;
    }
    case ScalarType.FIXED64: {
      const tc = protoInt64.uEnc(value as string | number | bigint);
      c.view.setUint32(c.pos, tc.lo >>> 0, true);
      c.view.setUint32(c.pos + 4, tc.hi >>> 0, true);
      c.pos += 8;
      return;
    }
    case ScalarType.SFIXED64: {
      const tc = protoInt64.enc(value as string | number | bigint);
      c.view.setInt32(c.pos, tc.lo | 0, true);
      c.view.setInt32(c.pos + 4, tc.hi | 0, true);
      c.pos += 8;
      return;
    }
    case ScalarType.BYTES: {
      const b = value as Uint8Array;
      writeVarint32(c, b.length);
      c.buf.set(b, c.pos);
      c.pos += b.length;
      return;
    }
  }
}

/** Blit a pre-encoded tag into the buffer. Faster than re-running the
 *  varint loop for every field on every message. */
function writeTagBytes(c: Cursor, tagBytes: Uint8Array): void {
  // Hand-inline the common tag sizes (1 byte for fields 1-15, 2 bytes
  // up to 2047). The majority of OTel-shaped fields hit the 1-byte case.
  const len = tagBytes.length;
  if (len === 1) {
    c.buf[c.pos++] = tagBytes[0];
    return;
  }
  if (len === 2) {
    c.buf[c.pos++] = tagBytes[0];
    c.buf[c.pos++] = tagBytes[1];
    return;
  }
  c.buf.set(tagBytes, c.pos);
  c.pos += len;
}

// -----------------------------------------------------------------------------
// Per-schema step compilation (H3A template specialization)
// -----------------------------------------------------------------------------
//
// Each field of a message compiles to a pair of closures:
//   - SizeStep: given a message, returns the number of bytes this field
//     will contribute in pass 2 (or 0 if the field is unset).
//   - EncodeStep: given a cursor + message, writes the field bytes.
//
// Closures pre-capture (tagBytes, localName, scalar-specific helpers).
// The inner encode loop becomes `for (const step of steps) step(c, msg, sizes)`
// with no switch dispatch — the branch tables live in the step factory
// and run once per schema at compilation time.

type SizeStep = (msg: Record<string, unknown>, sizes: SizeMap) => number;
type EncodeStep = (
  c: Cursor,
  msg: Record<string, unknown>,
  sizes: SizeMap,
) => void;

const sizeStepsCache = new WeakMap<DescMessage, SizeStep[]>();
const encodeStepsCache = new WeakMap<DescMessage, EncodeStep[]>();

function getSizeSteps(desc: DescMessage): SizeStep[] {
  let cached = sizeStepsCache.get(desc);
  if (cached !== undefined) return cached;
  cached = buildSizeSteps(desc);
  sizeStepsCache.set(desc, cached);
  return cached;
}

function getEncodeSteps(desc: DescMessage): EncodeStep[] {
  let cached = encodeStepsCache.get(desc);
  if (cached !== undefined) return cached;
  cached = buildEncodeSteps(desc);
  encodeStepsCache.set(desc, cached);
  return cached;
}

function findOneofField(
  oneof: DescOneof,
  caseName: string,
): DescField | undefined {
  const fs = oneof.fields;
  for (let i = 0; i < fs.length; i++) {
    if (fs[i].localName === caseName) return fs[i];
  }
  return undefined;
}

// -----------------------------------------------------------------------------
// Size steps
// -----------------------------------------------------------------------------

function buildScalarSizeStep(
  field: DescField & { fieldKind: "scalar" },
): SizeStep {
  const localName = field.localName;
  const tagLen = tagSize(field.number, scalarWireType(field.scalar));
  const t = field.scalar;
  const explicit = field.presence !== 2; /* 2 = IMPLICIT */

  // Specialize on scalar type. Each branch returns a closure that
  // reads exactly one slot and computes its own implicit-zero guard
  // inline — keeping the hot path free of further switches.
  if (t === ScalarType.STRING) {
    if (explicit) {
      return (msg) => {
        const v = msg[localName] as string | undefined | null;
        if (v === undefined || v === null) return 0;
        const byteLen = utf8ByteLength(v);
        return tagLen + varintSize32(byteLen) + byteLen;
      };
    }
    return (msg) => {
      const v = msg[localName] as string | undefined | null;
      if (!v) return 0;
      const byteLen = utf8ByteLength(v);
      return tagLen + varintSize32(byteLen) + byteLen;
    };
  }
  if (t === ScalarType.BOOL) {
    if (explicit) {
      return (msg) => {
        const v = msg[localName];
        if (v === undefined || v === null) return 0;
        return tagLen + 1;
      };
    }
    return (msg) => {
      const v = msg[localName];
      if (v !== true) return 0;
      return tagLen + 1;
    };
  }
  if (t === ScalarType.INT32) {
    if (explicit) {
      return (msg) => {
        const v = msg[localName] as number | undefined | null;
        if (v === undefined || v === null) return 0;
        return tagLen + int32Size(v);
      };
    }
    return (msg) => {
      const v = msg[localName] as number | undefined | null;
      if (!v) return 0;
      return tagLen + int32Size(v);
    };
  }
  if (t === ScalarType.UINT32) {
    if (explicit) {
      return (msg) => {
        const v = msg[localName] as number | undefined | null;
        if (v === undefined || v === null) return 0;
        return tagLen + varintSize32(v >>> 0);
      };
    }
    return (msg) => {
      const v = msg[localName] as number | undefined | null;
      if (!v) return 0;
      return tagLen + varintSize32(v >>> 0);
    };
  }
  if (t === ScalarType.SINT32) {
    if (explicit) {
      return (msg) => {
        const v = msg[localName] as number | undefined | null;
        if (v === undefined || v === null) return 0;
        return tagLen + sint32Size(v);
      };
    }
    return (msg) => {
      const v = msg[localName] as number | undefined | null;
      if (!v) return 0;
      return tagLen + sint32Size(v);
    };
  }
  if (t === ScalarType.DOUBLE || t === ScalarType.FIXED64 || t === ScalarType.SFIXED64) {
    if (explicit) {
      return (msg) => {
        const v = msg[localName];
        if (v === undefined || v === null) return 0;
        return tagLen + 8;
      };
    }
    return (msg) => {
      const v = msg[localName];
      if (
        v === undefined ||
        v === null ||
        v === 0 ||
        v === BIGINT_ZERO ||
        v === "0"
      )
        return 0;
      return tagLen + 8;
    };
  }
  if (t === ScalarType.FLOAT || t === ScalarType.FIXED32 || t === ScalarType.SFIXED32) {
    if (explicit) {
      return (msg) => {
        const v = msg[localName];
        if (v === undefined || v === null) return 0;
        return tagLen + 4;
      };
    }
    return (msg) => {
      const v = msg[localName];
      if (v === undefined || v === null || v === 0) return 0;
      return tagLen + 4;
    };
  }
  if (t === ScalarType.BYTES) {
    if (explicit) {
      return (msg) => {
        const v = msg[localName] as Uint8Array | undefined | null;
        if (v === undefined || v === null) return 0;
        return tagLen + varintSize32(v.length) + v.length;
      };
    }
    return (msg) => {
      const v = msg[localName] as Uint8Array | undefined | null;
      if (!v || v.length === 0) return 0;
      return tagLen + varintSize32(v.length) + v.length;
    };
  }
  // 64-bit varint scalars: INT64, UINT64, SINT64.
  return (msg) => {
    const v = msg[localName];
    if (v === undefined || v === null) return 0;
    if (!explicit && (v === 0 || v === BIGINT_ZERO || v === "0")) return 0;
    return tagLen + scalarSize(t, v);
  };
}

function buildEnumSizeStep(
  field: DescField & { fieldKind: "enum" },
): SizeStep {
  const localName = field.localName;
  const tagLen = tagSize(field.number, WIRE_VARINT);
  const explicit = field.presence !== 2;
  if (explicit) {
    return (msg) => {
      const v = msg[localName] as number | undefined | null;
      if (v === undefined || v === null) return 0;
      return tagLen + int32Size(v);
    };
  }
  return (msg) => {
    const v = msg[localName] as number | undefined | null;
    if (!v) return 0;
    return tagLen + int32Size(v);
  };
}

function buildMessageSizeStep(
  field: DescField & { fieldKind: "message" },
): SizeStep {
  const localName = field.localName;
  const tagLen = tagSize(field.number, WIRE_LENGTH_DELIMITED);
  const subDesc = field.message;
  return (msg, sizes) => {
    const sub = msg[localName] as Record<string, unknown> | undefined | null;
    if (sub === undefined || sub === null) return 0;
    const subSize = computeMessageSize(subDesc, sub, sizes);
    sizes.set(sub, subSize);
    return tagLen + varintSize32(subSize) + subSize;
  };
}

function buildListSizeStep(
  field: DescField & { fieldKind: "list" },
): SizeStep {
  const localName = field.localName;
  if (field.listKind === "message") {
    const tagLen = tagSize(field.number, WIRE_LENGTH_DELIMITED);
    const subDesc = field.message;
    return (msg, sizes) => {
      const list = msg[localName] as unknown[] | undefined | null;
      if (!list || list.length === 0) return 0;
      let size = 0;
      for (let k = 0; k < list.length; k++) {
        const sub = list[k] as Record<string, unknown>;
        const subSize = computeMessageSize(subDesc, sub, sizes);
        sizes.set(sub, subSize);
        size += tagLen + varintSize32(subSize) + subSize;
      }
      return size;
    };
  }
  if (field.listKind === "enum") {
    if (field.packed) {
      const tagLen = tagSize(field.number, WIRE_LENGTH_DELIMITED);
      return (msg) => {
        const list = msg[localName] as number[] | undefined | null;
        if (!list || list.length === 0) return 0;
        let body = 0;
        for (let k = 0; k < list.length; k++) {
          body += int32Size(list[k]);
        }
        return tagLen + varintSize32(body) + body;
      };
    }
    const tagLen = tagSize(field.number, WIRE_VARINT);
    return (msg) => {
      const list = msg[localName] as number[] | undefined | null;
      if (!list || list.length === 0) return 0;
      let size = 0;
      for (let k = 0; k < list.length; k++) {
        size += tagLen + int32Size(list[k]);
      }
      return size;
    };
  }
  // listKind === "scalar"
  const t = field.scalar;
  const wt = scalarWireType(t);
  if (field.packed && wt !== WIRE_LENGTH_DELIMITED) {
    const tagLen = tagSize(field.number, WIRE_LENGTH_DELIMITED);
    return (msg) => {
      const list = msg[localName] as unknown[] | undefined | null;
      if (!list || list.length === 0) return 0;
      let body = 0;
      for (let k = 0; k < list.length; k++) {
        body += scalarSize(t, list[k]);
      }
      return tagLen + varintSize32(body) + body;
    };
  }
  const tagLen = tagSize(field.number, wt);
  return (msg) => {
    const list = msg[localName] as unknown[] | undefined | null;
    if (!list || list.length === 0) return 0;
    let size = 0;
    for (let k = 0; k < list.length; k++) {
      size += tagLen + scalarSize(t, list[k]);
    }
    return size;
  };
}

function buildMapSizeStep(
  field: DescField & { fieldKind: "map" },
): SizeStep {
  const localName = field.localName;
  const outerTagLen = tagSize(field.number, WIRE_LENGTH_DELIMITED);
  const keyType = field.mapKey;
  const keyTagLen = tagSize(1, scalarWireType(keyType));
  const mapKind = field.mapKind;

  if (mapKind === "scalar") {
    const valType = field.scalar;
    const valTagLen = tagSize(2, scalarWireType(valType));
    return (msg) => {
      const obj = msg[localName] as Record<string, unknown> | undefined | null;
      if (!obj) return 0;
      const keys = Object.keys(obj);
      if (keys.length === 0) return 0;
      let size = 0;
      for (let k = 0; k < keys.length; k++) {
        const strKey = keys[k];
        const keyTyped = coerceMapKey(strKey, keyType);
        const keyBytes = keyTagLen + scalarSize(keyType, keyTyped);
        const valBytes = valTagLen + scalarSize(valType, obj[strKey]);
        const body = keyBytes + valBytes;
        size += outerTagLen + varintSize32(body) + body;
      }
      return size;
    };
  }
  if (mapKind === "enum") {
    const valTagLen = tagSize(2, WIRE_VARINT);
    return (msg) => {
      const obj = msg[localName] as Record<string, number> | undefined | null;
      if (!obj) return 0;
      const keys = Object.keys(obj);
      if (keys.length === 0) return 0;
      let size = 0;
      for (let k = 0; k < keys.length; k++) {
        const strKey = keys[k];
        const keyTyped = coerceMapKey(strKey, keyType);
        const keyBytes = keyTagLen + scalarSize(keyType, keyTyped);
        const valBytes = valTagLen + int32Size(obj[strKey]);
        const body = keyBytes + valBytes;
        size += outerTagLen + varintSize32(body) + body;
      }
      return size;
    };
  }
  // mapKind === "message"
  const valDesc = field.message;
  const valTagLen = tagSize(2, WIRE_LENGTH_DELIMITED);
  return (msg, sizes) => {
    const obj = msg[localName] as Record<string, unknown> | undefined | null;
    if (!obj) return 0;
    const keys = Object.keys(obj);
    if (keys.length === 0) return 0;
    let size = 0;
    for (let k = 0; k < keys.length; k++) {
      const strKey = keys[k];
      const keyTyped = coerceMapKey(strKey, keyType);
      const keyBytes = keyTagLen + scalarSize(keyType, keyTyped);
      const sub = obj[strKey] as Record<string, unknown>;
      const subSize = computeMessageSize(valDesc, sub, sizes);
      sizes.set(sub, subSize);
      const valBytes = valTagLen + varintSize32(subSize) + subSize;
      const body = keyBytes + valBytes;
      size += outerTagLen + varintSize32(body) + body;
    }
    return size;
  };
}

/**
 * Build a size step for a single field (used both for regular fields
 * and as the per-case handler inside an oneof dispatch). The resulting
 * step reads `msg[localName]` directly; oneof callers must adapt by
 * routing through the oneof ADT's `value` slot (handled in the oneof
 * step builder by wrapping the per-case step).
 */
function buildFieldSizeStep(field: DescField): SizeStep {
  switch (field.fieldKind) {
    case "scalar":
      return buildScalarSizeStep(field);
    case "enum":
      return buildEnumSizeStep(field);
    case "message":
      return buildMessageSizeStep(field);
    case "list":
      return buildListSizeStep(field);
    case "map":
      return buildMapSizeStep(field);
  }
}

function buildOneofSizeStep(oneof: DescOneof): SizeStep {
  const oneofLocalName = oneof.localName;
  // Per-case handlers: indexed by `case` discriminator. Each handler
  // reads from an ADT-shaped object `{ case, value }`, so we build a
  // thin step that rewrites `localName` lookups to `"value"`.
  const perCase = new Map<string, SizeStep>();
  for (const field of oneof.fields) {
    // Build a size step as if the field's storage slot was `value`.
    // This is the trick: clone the field descriptor with localName set
    // to "value" by wrapping the underlying step. We avoid mutating the
    // descriptor — instead, we build a step closure that reads adt.value.
    const step = buildFieldSizeStepForOneof(field);
    perCase.set(field.localName, step);
  }
  return (msg, sizes) => {
    const adt = msg[oneofLocalName] as
      | { case: string | undefined; value?: unknown }
      | undefined
      | null;
    if (!adt || adt.case === undefined) return 0;
    const step = perCase.get(adt.case);
    if (!step) return 0;
    // Route the ADT through as if it were a plain message with `value`
    // as the single readable slot. The per-case step treats `.value`
    // as its own field slot.
    return step(adt as Record<string, unknown>, sizes);
  };
}

/**
 * Variant of buildFieldSizeStep for fields that live inside a oneof.
 * The field always reads `msg.value` (the ADT payload) and always emits
 * (oneof presence is carried by the discriminator, not by the value).
 */
function buildFieldSizeStepForOneof(field: DescField): SizeStep {
  // For oneofs we don't check implicit-zero: any set case must emit.
  switch (field.fieldKind) {
    case "scalar": {
      const tagLen = tagSize(field.number, scalarWireType(field.scalar));
      const t = field.scalar;
      if (t === ScalarType.STRING) {
        return (msg) => {
          const v = msg.value as string;
          const byteLen = utf8ByteLength(v);
          return tagLen + varintSize32(byteLen) + byteLen;
        };
      }
      if (t === ScalarType.BOOL) {
        return () => tagLen + 1;
      }
      if (t === ScalarType.INT32) {
        return (msg) => tagLen + int32Size(msg.value as number);
      }
      if (t === ScalarType.UINT32) {
        return (msg) => tagLen + varintSize32((msg.value as number) >>> 0);
      }
      if (t === ScalarType.SINT32) {
        return (msg) => tagLen + sint32Size(msg.value as number);
      }
      if (
        t === ScalarType.DOUBLE ||
        t === ScalarType.FIXED64 ||
        t === ScalarType.SFIXED64
      ) {
        return () => tagLen + 8;
      }
      if (
        t === ScalarType.FLOAT ||
        t === ScalarType.FIXED32 ||
        t === ScalarType.SFIXED32
      ) {
        return () => tagLen + 4;
      }
      if (t === ScalarType.BYTES) {
        return (msg) => {
          const v = msg.value as Uint8Array;
          return tagLen + varintSize32(v.length) + v.length;
        };
      }
      // 64-bit varints
      return (msg) => tagLen + scalarSize(t, msg.value);
    }
    case "enum": {
      const tagLen = tagSize(field.number, WIRE_VARINT);
      return (msg) => tagLen + int32Size(msg.value as number);
    }
    case "message": {
      const tagLen = tagSize(field.number, WIRE_LENGTH_DELIMITED);
      const subDesc = field.message;
      return (msg, sizes) => {
        const sub = msg.value as Record<string, unknown>;
        const subSize = computeMessageSize(subDesc, sub, sizes);
        sizes.set(sub, subSize);
        return tagLen + varintSize32(subSize) + subSize;
      };
    }
    // Lists and maps can't appear inside oneofs (protobuf spec).
    default:
      return () => 0;
  }
}

function buildSizeSteps(desc: DescMessage): SizeStep[] {
  const steps: SizeStep[] = [];
  const fields = desc.fields;
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.oneof !== undefined) continue;
    steps.push(buildFieldSizeStep(field));
  }
  const oneofs = desc.oneofs;
  for (let i = 0; i < oneofs.length; i++) {
    steps.push(buildOneofSizeStep(oneofs[i]));
  }
  return steps;
}

function computeMessageSize(
  desc: DescMessage,
  message: Record<string, unknown>,
  sizes: SizeMap,
): number {
  const steps = getSizeSteps(desc);
  let size = 0;
  for (let i = 0; i < steps.length; i++) {
    size += steps[i](message, sizes);
  }
  return size;
}

// -----------------------------------------------------------------------------
// Encode steps
// -----------------------------------------------------------------------------

function buildScalarEncodeStep(
  field: DescField & { fieldKind: "scalar" },
): EncodeStep {
  const localName = field.localName;
  const tagBytes = encodeTag(field.number, scalarWireType(field.scalar));
  const t = field.scalar;
  const explicit = field.presence !== 2;

  if (t === ScalarType.STRING) {
    if (explicit) {
      return (c, msg) => {
        const v = msg[localName] as string | undefined | null;
        if (v === undefined || v === null) return;
        writeTagBytes(c, tagBytes);
        writeScalar(c, ScalarType.STRING, v);
      };
    }
    return (c, msg) => {
      const v = msg[localName] as string | undefined | null;
      if (!v) return;
      writeTagBytes(c, tagBytes);
      writeScalar(c, ScalarType.STRING, v);
    };
  }
  if (t === ScalarType.BOOL) {
    if (explicit) {
      return (c, msg) => {
        const v = msg[localName];
        if (v === undefined || v === null) return;
        writeTagBytes(c, tagBytes);
        c.buf[c.pos++] = (v as boolean) ? 1 : 0;
      };
    }
    return (c, msg) => {
      const v = msg[localName];
      if (v !== true) return;
      writeTagBytes(c, tagBytes);
      c.buf[c.pos++] = 1;
    };
  }
  if (t === ScalarType.INT32) {
    if (explicit) {
      return (c, msg) => {
        const v = msg[localName] as number | undefined | null;
        if (v === undefined || v === null) return;
        writeTagBytes(c, tagBytes);
        writeInt32(c, v);
      };
    }
    return (c, msg) => {
      const v = msg[localName] as number | undefined | null;
      if (!v) return;
      writeTagBytes(c, tagBytes);
      writeInt32(c, v);
    };
  }
  if (t === ScalarType.UINT32) {
    if (explicit) {
      return (c, msg) => {
        const v = msg[localName] as number | undefined | null;
        if (v === undefined || v === null) return;
        writeTagBytes(c, tagBytes);
        writeVarint32(c, v >>> 0);
      };
    }
    return (c, msg) => {
      const v = msg[localName] as number | undefined | null;
      if (!v) return;
      writeTagBytes(c, tagBytes);
      writeVarint32(c, v >>> 0);
    };
  }
  if (t === ScalarType.SINT32) {
    if (explicit) {
      return (c, msg) => {
        const v = msg[localName] as number | undefined | null;
        if (v === undefined || v === null) return;
        writeTagBytes(c, tagBytes);
        writeSInt32(c, v);
      };
    }
    return (c, msg) => {
      const v = msg[localName] as number | undefined | null;
      if (!v) return;
      writeTagBytes(c, tagBytes);
      writeSInt32(c, v);
    };
  }
  if (t === ScalarType.DOUBLE) {
    if (explicit) {
      return (c, msg) => {
        const v = msg[localName];
        if (v === undefined || v === null) return;
        writeTagBytes(c, tagBytes);
        c.view.setFloat64(c.pos, v as number, true);
        c.pos += 8;
      };
    }
    return (c, msg) => {
      const v = msg[localName];
      if (v === undefined || v === null || v === 0) return;
      writeTagBytes(c, tagBytes);
      c.view.setFloat64(c.pos, v as number, true);
      c.pos += 8;
    };
  }
  if (t === ScalarType.FLOAT) {
    if (explicit) {
      return (c, msg) => {
        const v = msg[localName];
        if (v === undefined || v === null) return;
        writeTagBytes(c, tagBytes);
        c.view.setFloat32(c.pos, v as number, true);
        c.pos += 4;
      };
    }
    return (c, msg) => {
      const v = msg[localName];
      if (v === undefined || v === null || v === 0) return;
      writeTagBytes(c, tagBytes);
      c.view.setFloat32(c.pos, v as number, true);
      c.pos += 4;
    };
  }
  if (t === ScalarType.BYTES) {
    if (explicit) {
      return (c, msg) => {
        const v = msg[localName] as Uint8Array | undefined | null;
        if (v === undefined || v === null) return;
        writeTagBytes(c, tagBytes);
        writeVarint32(c, v.length);
        c.buf.set(v, c.pos);
        c.pos += v.length;
      };
    }
    return (c, msg) => {
      const v = msg[localName] as Uint8Array | undefined | null;
      if (!v || v.length === 0) return;
      writeTagBytes(c, tagBytes);
      writeVarint32(c, v.length);
      c.buf.set(v, c.pos);
      c.pos += v.length;
    };
  }
  // Fallback for remaining scalars (FIXED32/SFIXED32/FIXED64/SFIXED64/
  // INT64/UINT64/SINT64). The shared writeScalar helper handles all of
  // them; the per-step closure avoids dispatching the outer field kind
  // again, which is the main win.
  if (explicit) {
    return (c, msg) => {
      const v = msg[localName];
      if (v === undefined || v === null) return;
      writeTagBytes(c, tagBytes);
      writeScalar(c, t, v);
    };
  }
  return (c, msg) => {
    const v = msg[localName];
    if (
      v === undefined ||
      v === null ||
      v === 0 ||
      v === BIGINT_ZERO ||
      v === "0"
    )
      return;
    writeTagBytes(c, tagBytes);
    writeScalar(c, t, v);
  };
}

function buildEnumEncodeStep(
  field: DescField & { fieldKind: "enum" },
): EncodeStep {
  const localName = field.localName;
  const tagBytes = encodeTag(field.number, WIRE_VARINT);
  const explicit = field.presence !== 2;
  if (explicit) {
    return (c, msg) => {
      const v = msg[localName] as number | undefined | null;
      if (v === undefined || v === null) return;
      writeTagBytes(c, tagBytes);
      writeInt32(c, v);
    };
  }
  return (c, msg) => {
    const v = msg[localName] as number | undefined | null;
    if (!v) return;
    writeTagBytes(c, tagBytes);
    writeInt32(c, v);
  };
}

function buildMessageEncodeStep(
  field: DescField & { fieldKind: "message" },
): EncodeStep {
  const localName = field.localName;
  const tagBytes = encodeTag(field.number, WIRE_LENGTH_DELIMITED);
  const subDesc = field.message;
  return (c, msg, sizes) => {
    const sub = msg[localName] as Record<string, unknown> | undefined | null;
    if (sub === undefined || sub === null) return;
    const subSize = sizes.get(sub) ?? 0;
    writeTagBytes(c, tagBytes);
    writeVarint32(c, subSize);
    writeMessageInto(c, subDesc, sub, sizes);
  };
}

function buildListEncodeStep(
  field: DescField & { fieldKind: "list" },
): EncodeStep {
  const localName = field.localName;
  if (field.listKind === "message") {
    const tagBytes = encodeTag(field.number, WIRE_LENGTH_DELIMITED);
    const subDesc = field.message;
    return (c, msg, sizes) => {
      const list = msg[localName] as unknown[] | undefined | null;
      if (!list || list.length === 0) return;
      for (let k = 0; k < list.length; k++) {
        const sub = list[k] as Record<string, unknown>;
        const subSize = sizes.get(sub) ?? 0;
        writeTagBytes(c, tagBytes);
        writeVarint32(c, subSize);
        writeMessageInto(c, subDesc, sub, sizes);
      }
    };
  }
  if (field.listKind === "enum") {
    if (field.packed) {
      const tagBytes = encodeTag(field.number, WIRE_LENGTH_DELIMITED);
      return (c, msg) => {
        const list = msg[localName] as number[] | undefined | null;
        if (!list || list.length === 0) return;
        let body = 0;
        for (let k = 0; k < list.length; k++) {
          body += int32Size(list[k]);
        }
        writeTagBytes(c, tagBytes);
        writeVarint32(c, body);
        for (let k = 0; k < list.length; k++) {
          writeInt32(c, list[k]);
        }
      };
    }
    const tagBytes = encodeTag(field.number, WIRE_VARINT);
    return (c, msg) => {
      const list = msg[localName] as number[] | undefined | null;
      if (!list || list.length === 0) return;
      for (let k = 0; k < list.length; k++) {
        writeTagBytes(c, tagBytes);
        writeInt32(c, list[k]);
      }
    };
  }
  // listKind === "scalar"
  const t = field.scalar;
  const wt = scalarWireType(t);
  if (field.packed && wt !== WIRE_LENGTH_DELIMITED) {
    const tagBytes = encodeTag(field.number, WIRE_LENGTH_DELIMITED);
    return (c, msg) => {
      const list = msg[localName] as unknown[] | undefined | null;
      if (!list || list.length === 0) return;
      let body = 0;
      for (let k = 0; k < list.length; k++) {
        body += scalarSize(t, list[k]);
      }
      writeTagBytes(c, tagBytes);
      writeVarint32(c, body);
      for (let k = 0; k < list.length; k++) {
        writeScalar(c, t, list[k]);
      }
    };
  }
  const tagBytes = encodeTag(field.number, wt);
  return (c, msg) => {
    const list = msg[localName] as unknown[] | undefined | null;
    if (!list || list.length === 0) return;
    for (let k = 0; k < list.length; k++) {
      writeTagBytes(c, tagBytes);
      writeScalar(c, t, list[k]);
    }
  };
}

function buildMapEncodeStep(
  field: DescField & { fieldKind: "map" },
): EncodeStep {
  const localName = field.localName;
  const outerTagBytes = encodeTag(field.number, WIRE_LENGTH_DELIMITED);
  const keyType = field.mapKey;
  const keyWire = scalarWireType(keyType);
  const keyTagBytes = encodeTag(1, keyWire);
  const keyTagLen = keyTagBytes.length;
  const mapKind = field.mapKind;

  if (mapKind === "scalar") {
    const valType = field.scalar;
    const valWire = scalarWireType(valType);
    const valTagBytes = encodeTag(2, valWire);
    const valTagLen = valTagBytes.length;
    return (c, msg) => {
      const obj = msg[localName] as Record<string, unknown> | undefined | null;
      if (!obj) return;
      const keys = Object.keys(obj);
      if (keys.length === 0) return;
      for (let k = 0; k < keys.length; k++) {
        const strKey = keys[k];
        const keyTyped = coerceMapKey(strKey, keyType);
        const value = obj[strKey];
        const keyBytes = keyTagLen + scalarSize(keyType, keyTyped);
        const valBytes = valTagLen + scalarSize(valType, value);
        const body = keyBytes + valBytes;
        writeTagBytes(c, outerTagBytes);
        writeVarint32(c, body);
        writeTagBytes(c, keyTagBytes);
        writeScalar(c, keyType, keyTyped);
        writeTagBytes(c, valTagBytes);
        writeScalar(c, valType, value);
      }
    };
  }
  if (mapKind === "enum") {
    const valTagBytes = encodeTag(2, WIRE_VARINT);
    const valTagLen = valTagBytes.length;
    return (c, msg) => {
      const obj = msg[localName] as Record<string, number> | undefined | null;
      if (!obj) return;
      const keys = Object.keys(obj);
      if (keys.length === 0) return;
      for (let k = 0; k < keys.length; k++) {
        const strKey = keys[k];
        const keyTyped = coerceMapKey(strKey, keyType);
        const value = obj[strKey];
        const keyBytes = keyTagLen + scalarSize(keyType, keyTyped);
        const valBytes = valTagLen + int32Size(value);
        const body = keyBytes + valBytes;
        writeTagBytes(c, outerTagBytes);
        writeVarint32(c, body);
        writeTagBytes(c, keyTagBytes);
        writeScalar(c, keyType, keyTyped);
        writeTagBytes(c, valTagBytes);
        writeInt32(c, value);
      }
    };
  }
  // mapKind === "message"
  const valDesc = field.message;
  const valTagBytes = encodeTag(2, WIRE_LENGTH_DELIMITED);
  const valTagLen = valTagBytes.length;
  return (c, msg, sizes) => {
    const obj = msg[localName] as Record<string, unknown> | undefined | null;
    if (!obj) return;
    const keys = Object.keys(obj);
    if (keys.length === 0) return;
    for (let k = 0; k < keys.length; k++) {
      const strKey = keys[k];
      const keyTyped = coerceMapKey(strKey, keyType);
      const sub = obj[strKey] as Record<string, unknown>;
      const subSize = sizes.get(sub) ?? 0;
      const keyBytes = keyTagLen + scalarSize(keyType, keyTyped);
      const valBytes = valTagLen + varintSize32(subSize) + subSize;
      const body = keyBytes + valBytes;
      writeTagBytes(c, outerTagBytes);
      writeVarint32(c, body);
      writeTagBytes(c, keyTagBytes);
      writeScalar(c, keyType, keyTyped);
      writeTagBytes(c, valTagBytes);
      writeVarint32(c, subSize);
      writeMessageInto(c, valDesc, sub, sizes);
    }
  };
}

function buildFieldEncodeStep(field: DescField): EncodeStep {
  switch (field.fieldKind) {
    case "scalar":
      return buildScalarEncodeStep(field);
    case "enum":
      return buildEnumEncodeStep(field);
    case "message":
      return buildMessageEncodeStep(field);
    case "list":
      return buildListEncodeStep(field);
    case "map":
      return buildMapEncodeStep(field);
  }
}

function buildFieldEncodeStepForOneof(field: DescField): EncodeStep {
  switch (field.fieldKind) {
    case "scalar": {
      const tagBytes = encodeTag(field.number, scalarWireType(field.scalar));
      const t = field.scalar;
      if (t === ScalarType.STRING) {
        return (c, msg) => {
          writeTagBytes(c, tagBytes);
          writeScalar(c, ScalarType.STRING, msg.value as string);
        };
      }
      if (t === ScalarType.BOOL) {
        return (c, msg) => {
          writeTagBytes(c, tagBytes);
          c.buf[c.pos++] = (msg.value as boolean) ? 1 : 0;
        };
      }
      if (t === ScalarType.INT32) {
        return (c, msg) => {
          writeTagBytes(c, tagBytes);
          writeInt32(c, msg.value as number);
        };
      }
      if (t === ScalarType.UINT32) {
        return (c, msg) => {
          writeTagBytes(c, tagBytes);
          writeVarint32(c, (msg.value as number) >>> 0);
        };
      }
      if (t === ScalarType.SINT32) {
        return (c, msg) => {
          writeTagBytes(c, tagBytes);
          writeSInt32(c, msg.value as number);
        };
      }
      if (t === ScalarType.DOUBLE) {
        return (c, msg) => {
          writeTagBytes(c, tagBytes);
          c.view.setFloat64(c.pos, msg.value as number, true);
          c.pos += 8;
        };
      }
      if (t === ScalarType.FLOAT) {
        return (c, msg) => {
          writeTagBytes(c, tagBytes);
          c.view.setFloat32(c.pos, msg.value as number, true);
          c.pos += 4;
        };
      }
      if (t === ScalarType.BYTES) {
        return (c, msg) => {
          const v = msg.value as Uint8Array;
          writeTagBytes(c, tagBytes);
          writeVarint32(c, v.length);
          c.buf.set(v, c.pos);
          c.pos += v.length;
        };
      }
      return (c, msg) => {
        writeTagBytes(c, tagBytes);
        writeScalar(c, t, msg.value);
      };
    }
    case "enum": {
      const tagBytes = encodeTag(field.number, WIRE_VARINT);
      return (c, msg) => {
        writeTagBytes(c, tagBytes);
        writeInt32(c, msg.value as number);
      };
    }
    case "message": {
      const tagBytes = encodeTag(field.number, WIRE_LENGTH_DELIMITED);
      const subDesc = field.message;
      return (c, msg, sizes) => {
        const sub = msg.value as Record<string, unknown>;
        const subSize = sizes.get(sub) ?? 0;
        writeTagBytes(c, tagBytes);
        writeVarint32(c, subSize);
        writeMessageInto(c, subDesc, sub, sizes);
      };
    }
    default:
      return () => {};
  }
}

function buildOneofEncodeStep(oneof: DescOneof): EncodeStep {
  const oneofLocalName = oneof.localName;
  const perCase = new Map<string, EncodeStep>();
  for (const field of oneof.fields) {
    perCase.set(field.localName, buildFieldEncodeStepForOneof(field));
  }
  return (c, msg, sizes) => {
    const adt = msg[oneofLocalName] as
      | { case: string | undefined; value?: unknown }
      | undefined
      | null;
    if (!adt || adt.case === undefined) return;
    const step = perCase.get(adt.case);
    if (!step) return;
    step(c, adt as Record<string, unknown>, sizes);
  };
}

function buildEncodeSteps(desc: DescMessage): EncodeStep[] {
  const steps: EncodeStep[] = [];
  const fields = desc.fields;
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.oneof !== undefined) continue;
    steps.push(buildFieldEncodeStep(field));
  }
  const oneofs = desc.oneofs;
  for (let i = 0; i < oneofs.length; i++) {
    steps.push(buildOneofEncodeStep(oneofs[i]));
  }
  return steps;
}

function writeMessageInto(
  c: Cursor,
  desc: DescMessage,
  message: Record<string, unknown>,
  sizes: SizeMap,
): void {
  const steps = getEncodeSteps(desc);
  for (let i = 0; i < steps.length; i++) {
    steps[i](c, message, sizes);
  }
}

// findOneofField kept for potential future callers — currently unused on the
// hot path because oneof dispatch is table-driven via the per-case Map in
// buildOneofSizeStep / buildOneofEncodeStep.
void findOneofField;

// -----------------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------------

/**
 * Opt-in fast-path binary encoder. See the top-of-file comment for the
 * motivation and scope.
 *
 * Falls back to {@link toBinary} when the schema uses features not yet
 * supported by the fast path (extensions or delimited/group encoding).
 * Unknown fields on messages are always dropped by the fast path — if
 * you need to round-trip unknowns, use `toBinary` instead.
 *
 * @experimental This API is experimental and may change or be removed
 * without notice. The intent is to explore whether a two-pass encode
 * meaningfully improves OTel-shaped workloads; once stabilized, the
 * improvement may fold into the default `toBinary`.
 */
export function toBinaryFast<Desc extends DescMessage>(
  schema: Desc,
  message: MessageShape<Desc>,
): Uint8Array<ArrayBuffer> {
  if (!isSupported(schema)) {
    return toBinary(schema, message);
  }
  const sizes: SizeMap = new Map();
  const msg = message as unknown as Record<string, unknown>;
  const total = computeMessageSize(schema, msg, sizes);
  const buf = new Uint8Array(total);
  const cursor: Cursor = {
    buf,
    view: new DataView(buf.buffer, buf.byteOffset, buf.byteLength),
    pos: 0,
    encodeUtf8: getTextEncoding().encodeUtf8,
  };
  writeMessageInto(cursor, schema, msg, sizes);
  if (cursor.pos !== total) {
    throw new Error(
      `toBinaryFast: size/write mismatch (est=${total} wrote=${cursor.pos}) — please report this as a bug`,
    );
  }
  return buf;
}
