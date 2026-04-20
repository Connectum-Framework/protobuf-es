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
import {
  selectOrObserve,
  type VariantHelpers,
} from "./wire/schema-plan-adaptive.js";

// -----------------------------------------------------------------------------
// Support detection
// -----------------------------------------------------------------------------

const supportCache = new WeakMap<DescMessage, boolean>();

// `0n` requires target >= ES2020, but this package is compiled for ES2017.
// Materialize the bigint zero once at module load so closures can compare
// against it without the BigInt() call on the hot path. Marked PURE so
// unused-path eliminators (esbuild, Rollup, Terser) can drop this module
// when toBinaryFast is never referenced.
const BIGINT_ZERO = /*@__PURE__*/ BigInt(0);

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
// Pass 1 — size estimation
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

/**
 * Should this non-oneof field be emitted for the given message?
 * Oneof members are dispatched separately and never flow through this
 * predicate.
 */
function isFieldSet(field: DescField, value: unknown): boolean {
  // Explicit presence (proto2 / proto3 optional): the generated setters
  // only assign when the property was set. Missing ⇒ undefined.
  if (value === undefined || value === null) return false;

  // Implicit presence (proto3 singular scalar/enum): zero value means
  // "not set" and must not be emitted. Lists/maps handled separately
  // (empty list/map means "not set" too).
  switch (field.fieldKind) {
    case "scalar": {
      const t = field.scalar;
      if (field.presence !== 2 /* IMPLICIT */) {
        // Explicit / legacy required: any defined value counts as set.
        return true;
      }
      if (t === ScalarType.STRING) return (value as string).length > 0;
      if (t === ScalarType.BYTES) return (value as Uint8Array).length > 0;
      if (t === ScalarType.BOOL) return value === true;
      if (
        t === ScalarType.INT64 ||
        t === ScalarType.UINT64 ||
        t === ScalarType.SINT64 ||
        t === ScalarType.FIXED64 ||
        t === ScalarType.SFIXED64
      ) {
        // bigint zero, numeric zero, "0" string all represent unset.
        // Compare via coercion so 0n / 0 / "0" all return false.
        // Literal `0n` requires ES2020; see BIGINT_ZERO above.
        return value !== 0 && value !== BIGINT_ZERO && value !== "0";
      }
      return (value as number) !== 0;
    }
    case "enum":
      if (field.presence !== 2 /* IMPLICIT */) return true;
      return (value as number) !== 0;
    case "message":
      return true; // already filtered by undefined check above
    case "list":
      return (value as unknown[]).length > 0;
    case "map":
      // Map fields carry their own "any entry" gate here — empty object
      // ⇒ not set ⇒ omit. Same semantics as reflect.unsafeIsSet.
      return Object.keys(value as object).length > 0;
  }
  // Exhaustive switch; unreachable. Return true so unexpected shapes
  // surface as a size/write mismatch error rather than silent data loss.
  return true;
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

/**
 * Body-size of a single map entry message `{ key, value }`, excluding
 * the outer field tag and length prefix. Returns both the body size and,
 * for message-typed values, the submessage body size (so the writer
 * doesn't recompute it).
 */
function estimateMapEntryBody(
  field: DescField & { fieldKind: "map" },
  keyTyped: unknown,
  value: unknown,
  sizes: SizeMap,
): { body: number; valueSubSize: number } {
  // Entry key is always field number 1.
  const keySize =
    tagSize(1, scalarWireType(field.mapKey)) +
    scalarSize(field.mapKey, keyTyped);
  let valSize: number;
  let valueSubSize = 0;
  switch (field.mapKind) {
    case "scalar":
      valSize =
        tagSize(2, scalarWireType(field.scalar)) +
        scalarSize(field.scalar, value);
      break;
    case "enum":
      valSize = tagSize(2, WIRE_VARINT) + int32Size(value as number);
      break;
    case "message": {
      const sub = value as Record<string, unknown>;
      valueSubSize = estimateMessageSize(field.message, sub, sizes);
      sizes.set(sub, valueSubSize);
      valSize =
        tagSize(2, WIRE_LENGTH_DELIMITED) +
        varintSize32(valueSubSize) +
        valueSubSize;
      break;
    }
  }
  return { body: keySize + valSize, valueSubSize };
}

/**
 * Size contribution of a map field: for every entry, an outer tag + length
 * prefix + entry body. Map entries are always length-delimited — map fields
 * cannot use delimited (group) encoding.
 */
function estimateMapFieldSize(
  field: DescField & { fieldKind: "map" },
  obj: Record<string, unknown>,
  sizes: SizeMap,
): number {
  const tagBytes = tagSize(field.number, WIRE_LENGTH_DELIMITED);
  let size = 0;
  for (const strKey of Object.keys(obj)) {
    const keyTyped = coerceMapKey(strKey, field.mapKey);
    const { body } = estimateMapEntryBody(field, keyTyped, obj[strKey], sizes);
    size += tagBytes + varintSize32(body) + body;
  }
  return size;
}

/**
 * Size contribution of a single non-oneof non-map "regular" field. Broken
 * out so that the oneof dispatch can reuse the same switch.
 */
function estimateRegularFieldSize(
  field: DescField,
  value: unknown,
  sizes: SizeMap,
): number {
  switch (field.fieldKind) {
    case "scalar":
      return (
        tagSize(field.number, scalarWireType(field.scalar)) +
        scalarSize(field.scalar, value)
      );
    case "enum":
      return tagSize(field.number, WIRE_VARINT) + int32Size(value as number);
    case "message": {
      const sub = value as Record<string, unknown>;
      const subSize = estimateMessageSize(field.message, sub, sizes);
      sizes.set(sub, subSize);
      return (
        tagSize(field.number, WIRE_LENGTH_DELIMITED) +
        varintSize32(subSize) +
        subSize
      );
    }
    case "list": {
      const list = value as unknown[];
      let size = 0;
      if (field.listKind === "message") {
        const tagBytes = tagSize(field.number, WIRE_LENGTH_DELIMITED);
        for (let k = 0; k < list.length; k++) {
          const sub = list[k] as Record<string, unknown>;
          const subSize = estimateMessageSize(field.message, sub, sizes);
          sizes.set(sub, subSize);
          size += tagBytes + varintSize32(subSize) + subSize;
        }
        return size;
      }
      if (field.listKind === "enum") {
        if (field.packed) {
          let body = 0;
          for (let k = 0; k < list.length; k++) {
            body += int32Size(list[k] as number);
          }
          return (
            tagSize(field.number, WIRE_LENGTH_DELIMITED) +
            varintSize32(body) +
            body
          );
        }
        const tagBytes = tagSize(field.number, WIRE_VARINT);
        for (let k = 0; k < list.length; k++) {
          size += tagBytes + int32Size(list[k] as number);
        }
        return size;
      }
      // listKind === "scalar"
      const t = field.scalar;
      const wt = scalarWireType(t);
      if (field.packed && wt !== WIRE_LENGTH_DELIMITED) {
        let body = 0;
        for (let k = 0; k < list.length; k++) {
          body += scalarSize(t, list[k]);
        }
        return (
          tagSize(field.number, WIRE_LENGTH_DELIMITED) +
          varintSize32(body) +
          body
        );
      }
      const tagBytes = tagSize(field.number, wt);
      for (let k = 0; k < list.length; k++) {
        size += tagBytes + scalarSize(t, list[k]);
      }
      return size;
    }
    case "map":
      // Map fields flow through estimateMapFieldSize; this branch is
      // defensive and never taken on the estimation hot path.
      return estimateMapFieldSize(
        field as DescField & { fieldKind: "map" },
        value as Record<string, unknown>,
        sizes,
      );
  }
  return 0;
}

function estimateMessageSize(
  desc: DescMessage,
  message: Record<string, unknown>,
  sizes: SizeMap,
): number {
  let size = 0;
  const fields = desc.fields;
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    // Oneof members are dispatched via the `desc.oneofs` loop below.
    if (field.oneof !== undefined) continue;

    if (field.fieldKind === "map") {
      const obj = message[field.localName] as
        | Record<string, unknown>
        | undefined;
      if (!obj || Object.keys(obj).length === 0) continue;
      size += estimateMapFieldSize(
        field as DescField & { fieldKind: "map" },
        obj,
        sizes,
      );
      continue;
    }

    const value = message[field.localName];
    if (!isFieldSet(field, value)) continue;
    size += estimateRegularFieldSize(field, value, sizes);
  }
  // Oneof dispatch: at most one field per oneof contributes, identified by
  // the `case` discriminator on the oneof ADT object. Zero values are
  // emitted when a oneof case is explicitly set — that's the whole point
  // of the oneof: presence is carried by the discriminator, not by value.
  const oneofs = desc.oneofs;
  for (let i = 0; i < oneofs.length; i++) {
    const oneof = oneofs[i];
    const adt = message[oneof.localName] as
      | { case: string | undefined; value?: unknown }
      | undefined;
    if (!adt || adt.case === undefined) continue;
    const selected = findOneofField(oneof, adt.case);
    if (!selected) continue;
    size += estimateRegularFieldSize(selected, adt.value, sizes);
  }
  return size;
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
// Pass 2 — write into pre-allocated buffer
// -----------------------------------------------------------------------------

/**
 * Writer state bundled into a plain object so that helper functions can
 * mutate `pos` without paying for method-call indirection on a class.
 */
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

function writeTag(c: Cursor, fieldNo: number, wireType: number): void {
  writeVarint32(c, ((fieldNo << 3) | wireType) >>> 0);
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

function writeMapEntry(
  c: Cursor,
  field: DescField & { fieldKind: "map" },
  keyTyped: unknown,
  value: unknown,
  sizes: SizeMap,
): void {
  // Entry key: field number 1.
  writeTag(c, 1, scalarWireType(field.mapKey));
  writeScalar(c, field.mapKey, keyTyped);
  // Entry value: field number 2.
  switch (field.mapKind) {
    case "scalar":
      writeTag(c, 2, scalarWireType(field.scalar));
      writeScalar(c, field.scalar, value);
      return;
    case "enum":
      writeTag(c, 2, WIRE_VARINT);
      writeInt32(c, value as number);
      return;
    case "message": {
      const sub = value as Record<string, unknown>;
      const subSize = sizes.get(sub) ?? 0;
      writeTag(c, 2, WIRE_LENGTH_DELIMITED);
      writeVarint32(c, subSize);
      writeMessageInto(c, field.message, sub, sizes);
      return;
    }
  }
}

function writeMapField(
  c: Cursor,
  field: DescField & { fieldKind: "map" },
  obj: Record<string, unknown>,
  sizes: SizeMap,
): void {
  for (const strKey of Object.keys(obj)) {
    const keyTyped = coerceMapKey(strKey, field.mapKey);
    const value = obj[strKey];
    // Body size is recomputed here rather than cached because caching it
    // per-entry would require either (1) a second identity-keyed cache
    // separate from `sizes` or (2) wrapping each entry in a synthetic
    // object. Recompute is cheap — scalar types only, except for the
    // `value` submessage which reads from `sizes` anyway.
    const { body } = estimateMapEntryBody(field, keyTyped, value, sizes);
    writeTag(c, field.number, WIRE_LENGTH_DELIMITED);
    writeVarint32(c, body);
    writeMapEntry(c, field, keyTyped, value, sizes);
  }
}

/**
 * Write one non-oneof non-map field. Matches estimateRegularFieldSize
 * exactly so that pass 1 and pass 2 stay in sync.
 */
function writeRegularField(
  c: Cursor,
  field: DescField,
  value: unknown,
  sizes: SizeMap,
): void {
  switch (field.fieldKind) {
    case "scalar":
      writeTag(c, field.number, scalarWireType(field.scalar));
      writeScalar(c, field.scalar, value);
      return;
    case "enum":
      writeTag(c, field.number, WIRE_VARINT);
      writeInt32(c, value as number);
      return;
    case "message": {
      const sub = value as Record<string, unknown>;
      const subSize = sizes.get(sub) ?? 0;
      writeTag(c, field.number, WIRE_LENGTH_DELIMITED);
      writeVarint32(c, subSize);
      writeMessageInto(c, field.message, sub, sizes);
      return;
    }
    case "list": {
      const list = value as unknown[];
      if (field.listKind === "message") {
        for (let k = 0; k < list.length; k++) {
          const sub = list[k] as Record<string, unknown>;
          const subSize = sizes.get(sub) ?? 0;
          writeTag(c, field.number, WIRE_LENGTH_DELIMITED);
          writeVarint32(c, subSize);
          writeMessageInto(c, field.message, sub, sizes);
        }
        return;
      }
      if (field.listKind === "enum") {
        if (field.packed) {
          let body = 0;
          for (let k = 0; k < list.length; k++) {
            body += int32Size(list[k] as number);
          }
          writeTag(c, field.number, WIRE_LENGTH_DELIMITED);
          writeVarint32(c, body);
          for (let k = 0; k < list.length; k++) {
            writeInt32(c, list[k] as number);
          }
          return;
        }
        for (let k = 0; k < list.length; k++) {
          writeTag(c, field.number, WIRE_VARINT);
          writeInt32(c, list[k] as number);
        }
        return;
      }
      // scalar list
      const t = field.scalar;
      const wt = scalarWireType(t);
      if (field.packed && wt !== WIRE_LENGTH_DELIMITED) {
        let body = 0;
        for (let k = 0; k < list.length; k++) {
          body += scalarSize(t, list[k]);
        }
        writeTag(c, field.number, WIRE_LENGTH_DELIMITED);
        writeVarint32(c, body);
        for (let k = 0; k < list.length; k++) {
          writeScalar(c, t, list[k]);
        }
        return;
      }
      for (let k = 0; k < list.length; k++) {
        writeTag(c, field.number, wt);
        writeScalar(c, t, list[k]);
      }
      return;
    }
    case "map":
      // Map fields are dispatched through writeMapField from the caller;
      // this branch is unreachable on the hot path but defensive.
      writeMapField(
        c,
        field as DescField & { fieldKind: "map" },
        value as Record<string, unknown>,
        sizes,
      );
      return;
  }
}

function writeMessageInto(
  c: Cursor,
  desc: DescMessage,
  message: Record<string, unknown>,
  sizes: SizeMap,
): void {
  const fields = desc.fields;
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    // Oneof members: dispatched via the oneof loop below.
    if (field.oneof !== undefined) continue;

    if (field.fieldKind === "map") {
      const obj = message[field.localName] as
        | Record<string, unknown>
        | undefined;
      if (!obj || Object.keys(obj).length === 0) continue;
      writeMapField(c, field as DescField & { fieldKind: "map" }, obj, sizes);
      continue;
    }

    const value = message[field.localName];
    if (!isFieldSet(field, value)) continue;
    writeRegularField(c, field, value, sizes);
  }
  const oneofs = desc.oneofs;
  for (let i = 0; i < oneofs.length; i++) {
    const oneof = oneofs[i];
    const adt = message[oneof.localName] as
      | { case: string | undefined; value?: unknown }
      | undefined;
    if (!adt || adt.case === undefined) continue;
    const selected = findOneofField(oneof, adt.case);
    if (!selected) continue;
    writeRegularField(c, selected, adt.value, sizes);
  }
}

// -----------------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Adaptive (L3) glue
// -----------------------------------------------------------------------------
//
// L3 is an opt-in overlay that observes message shapes per schema and
// graduates specialized per-shape plans after a warmup window. The generic
// L1+L2 estimate/write helpers above are exposed to L3 through
// `adaptiveHelpers` so that a variant plan's unrolled step list can call
// directly into them without re-entering the field-presence gate.
//
// Default: adaptive is off. Enable per-call via `{ adaptive: true }` or
// globally via `process.env.PROTOBUF_ES_L3 === "1"`. See
// `packages/protobuf/src/wire/schema-plan-adaptive.ts`.

const adaptiveHelpers: VariantHelpers = {
  estimateRegular: (field, value, sizes) =>
    estimateRegularFieldSize(field, value, sizes),
  estimateMap: (field, obj, sizes) =>
    estimateMapFieldSize(field as DescField & { fieldKind: "map" }, obj, sizes),
  writeRegular: (cursor, field, value, sizes) =>
    writeRegularField(cursor as Cursor, field, value, sizes),
  writeMap: (cursor, field, obj, sizes) =>
    writeMapField(
      cursor as Cursor,
      field as DescField & { fieldKind: "map" },
      obj,
      sizes,
    ),
};

function adaptiveDefault(): boolean {
  // Cross-runtime lookup avoids depending on @types/node in this package.
  const g = globalThis as {
    process?: { env?: Record<string, string | undefined> };
  };
  return g.process?.env?.PROTOBUF_ES_L3 === "1";
}

/**
 * Options accepted by {@link toBinaryFast}.
 *
 * `adaptive` turns on L3 runtime monomorphization: the encoder observes
 * message shapes per schema and graduates specialized plans for the
 * recurring ones (see `wire/schema-plan-adaptive.ts`). Default: false.
 */
export interface ToBinaryFastOptions {
  adaptive?: boolean;
}

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
  options?: ToBinaryFastOptions,
): Uint8Array<ArrayBuffer> {
  if (!isSupported(schema)) {
    return toBinary(schema, message);
  }
  const msg = message as unknown as Record<string, unknown>;
  const adaptive = options?.adaptive ?? adaptiveDefault();

  if (adaptive) {
    const variant = selectOrObserve(schema, msg, adaptiveHelpers);
    if (variant !== undefined) {
      const sizes: SizeMap = new Map();
      const total = variant.estimate(msg, sizes);
      const buf = new Uint8Array(total);
      const cursor: Cursor = {
        buf,
        view: new DataView(buf.buffer, buf.byteOffset, buf.byteLength),
        pos: 0,
        encodeUtf8: getTextEncoding().encodeUtf8,
      };
      variant.write(cursor, msg, sizes);
      if (cursor.pos !== total) {
        throw new Error(
          `toBinaryFast (L3): size/write mismatch (est=${total} wrote=${cursor.pos}) — please report this as a bug`,
        );
      }
      return buf;
    }
    // Observation miss — fall through to generic.
  }

  const sizes: SizeMap = new Map();
  const total = estimateMessageSize(schema, msg, sizes);
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
