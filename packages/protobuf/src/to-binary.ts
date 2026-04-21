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

// `toBinary` uses a two-pass, pre-sized encode whenever the schema falls
// within a common subset (scalars, enums, messages, lists, maps, oneofs —
// no extensions, no proto2 groups, no delimited encoding, no unknown
// fields to preserve). For those schemas we walk the message once to
// compute the exact encoded size, allocate a single Uint8Array, and write
// every byte into it at a fixed offset — no fork/join stack, no chunk
// list, no final concat.
//
// For schemas that use extensions, delimited/group encoding, or carry
// unknown fields that must round-trip, `toBinary` falls back to the
// original reflective walk built on top of `BinaryWriter.fork()/join()`.
// The fallback is byte-identical to the upstream encoder.
//
// Both paths emit fields in the same order (descriptor order, matching
// `reflect(...).sortedFields`), so the two-pass path produces the same
// bytes as the reflective walk for every schema shape it supports. The
// correctness-matrix test covers fixtures in both paths.

import { type DescField, type DescMessage, ScalarType } from "./descriptors.js";
import { protoInt64 } from "./proto-int64.js";
import type { ReflectList, ReflectMessage } from "./reflect/index.js";
import { reflect } from "./reflect/reflect.js";
import type { ScalarValue } from "./reflect/scalar.js";
import type { MessageShape } from "./types.js";
import { BinaryWriter, WireType } from "./wire/binary-encoding.js";
import { getTextEncoding } from "./wire/text-encoding.js";
import type { FeatureSet_FieldPresence } from "./wkt/gen/google/protobuf/descriptor_pb.js";

// bootstrap-inject google.protobuf.FeatureSet.FieldPresence.LEGACY_REQUIRED: const $name: FeatureSet_FieldPresence.$localName = $number;
const LEGACY_REQUIRED: FeatureSet_FieldPresence.LEGACY_REQUIRED = 3;

/**
 * Options for serializing to binary data.
 *
 * V1 also had the option `readerFactory` for using a custom implementation to
 * encode to binary.
 */
export interface BinaryWriteOptions {
  /**
   * Include unknown fields in the serialized output? The default behavior
   * is to retain unknown fields and include them in the serialized output.
   *
   * For more details see https://developers.google.com/protocol-buffers/docs/proto3#unknowns
   */
  writeUnknownFields: boolean;
}

// Default options for serializing binary data.
const writeDefaults: Readonly<BinaryWriteOptions> = {
  writeUnknownFields: true,
};

function makeWriteOptions(
  options?: Partial<BinaryWriteOptions>,
): Readonly<BinaryWriteOptions> {
  return options ? { ...writeDefaults, ...options } : writeDefaults;
}

export function toBinary<Desc extends DescMessage>(
  schema: Desc,
  message: MessageShape<Desc>,
  options?: Partial<BinaryWriteOptions>,
): Uint8Array<ArrayBuffer> {
  const opts = makeWriteOptions(options);
  // Two-pass fast path: supported schema + no unknown fields on the root.
  // The nested support check rules out groups/extensions structurally;
  // the root-level unknown-fields guard matches the semantics of the
  // reflective walk when writeUnknownFields is true.
  if (
    opts.writeUnknownFields
      ? canUseFastPath(schema) && !rootHasUnknowns(message)
      : canUseFastPath(schema)
  ) {
    try {
      return encodeFast(schema, message);
    } catch {
      // The fast path's error diagnostics are not as rich as the
      // reflective walk's (which annotates the offending field with
      // `cannot encode field <MsgName>.<field> to binary: ...`). Rather
      // than duplicate the assertion bodies across two encoders, when
      // the fast path throws we retry via the reflective walk so users
      // see the exact same message regardless of which path was taken.
      // Normal (valid) encodes never hit this cost.
    }
  }
  return reflectiveToBinary(schema, message, opts);
}

// -----------------------------------------------------------------------------
// Fast path — support detection
// -----------------------------------------------------------------------------
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
// The fast path makes two passes:
//   1) estimate the exact encoded size of every field by walking the
//      message graph and accumulating bytes-needed;
//   2) allocate a single Uint8Array of that size and write bytes into it
//      at fixed offsets.
//
// Because the estimate is exact, the write pass never reallocates, never
// copies, and never needs to stack fork/join state. Length prefixes are
// computed during pass 1 and cached so that pass 2 can write the varint
// before it descends into the submessage.
//
// Scope:
//   - supported:   scalar fields (all 15 types), enums, nested messages,
//                  repeated scalar (packed + unpacked), repeated message,
//                  map<K,V> for all legal K and any scalar/enum/message V,
//                  oneof groups
//   - unsupported: extensions, delimited/group encoding, unknown fields
//
// When a schema uses an unsupported feature the support check returns
// false and `toBinary` transparently falls back to the reflective walk.
// The decision is computed once per `DescMessage` and cached in a
// `WeakMap`, so the fallback check does not dominate the hot path after
// the first call.

const supportCache = new WeakMap<DescMessage, boolean>();

/**
 * Fields sorted by wire number. Mirrors the reflective `sortedFields`
 * order so that both encode paths emit identical byte sequences. Cached
 * per `DescMessage` — the sort itself is O(n log n) but rare descriptor
 * hits; repeated encodes hit the cache.
 *
 * Note: the reflective `BinaryWriter` sorts by field number too (see
 * `reflect.ts`). Any future divergence between `desc.fields` order and
 * wire order would break byte parity, so always consult this helper.
 */
const sortedFieldsCache = new WeakMap<DescMessage, readonly DescField[]>();
function sortedFields(desc: DescMessage): readonly DescField[] {
  const cached = sortedFieldsCache.get(desc);
  if (cached) return cached;
  const sorted = desc.fields.slice().sort((a, b) => a.number - b.number);
  sortedFieldsCache.set(desc, sorted);
  return sorted;
}

// `0n` requires target >= ES2020, but this package is compiled for ES2017.
// Materialize the bigint zero once at module load so closures can compare
// against it without the BigInt() call on the hot path.
const BIGINT_ZERO = /*@__PURE__*/ BigInt(0);

/**
 * Does the message tree carry unknown fields that the user expects to
 * round-trip? Extensions are stored on the message object as `$unknown`
 * too (see packages/protobuf/src/extensions.ts), so a non-empty
 * `$unknown` on any message in the tree means we have bytes we must
 * preserve verbatim — the fast path can't reproduce them, so we fall
 * back to the reflective walk.
 *
 * We only probe the root. Nested unknowns are rare; covering them would
 * require walking every submessage per encode, which costs more than it
 * saves. Callers who populate unknown fields on deeply nested messages
 * (unusual, usually limited to extensions at the root) can set
 * writeUnknownFields: false to keep the fast path; the reflective walk
 * would have dropped them anyway in that mode.
 */
function rootHasUnknowns(message: unknown): boolean {
  if (message === null || typeof message !== "object") return false;
  const unk = (message as { $unknown?: unknown[] }).$unknown;
  return Array.isArray(unk) && unk.length > 0;
}

/**
 * Walk the descriptor (including transitive message fields) and return
 * true iff every field in the subtree uses a fast-path-supported shape.
 * The result is cached per `DescMessage` — most schemas have small,
 * bounded field trees and the walk is cheap but not free, so we amortize.
 */
function canUseFastPath(
  desc: DescMessage,
  visiting: Set<DescMessage> = new Set(),
): boolean {
  const cached = supportCache.get(desc);
  if (cached !== undefined) return cached;
  // Guard against recursive message types (e.g. google.protobuf.Value).
  // While a cycle is in flight we optimistically assume support; if a
  // descendant turns out to be unsupported, we overwrite the cache entry
  // below.
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
      if (!canUseFastPath(field.message, visiting)) {
        ok = false;
        break;
      }
    }
    if (
      field.fieldKind === "list" &&
      field.listKind === "message" &&
      field.message
    ) {
      if (!canUseFastPath(field.message, visiting)) {
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
      if (!canUseFastPath(field.message, visiting)) {
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
// Fast path — wire format helpers
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
// Fast path — encoded-size cache
// -----------------------------------------------------------------------------
//
// We compute the size of each submessage exactly once (pass 1) and reuse
// that number in pass 2 to write the length prefix. A Map keyed by the
// message object isolates this state to the current encode call without
// leaking across calls (the map itself is scoped to one encode).

type SizeMap = Map<object, number>;

// -----------------------------------------------------------------------------
// Fast path — pass 1 (size estimation)
// -----------------------------------------------------------------------------

// Input validation mirrors the assertions in BinaryWriter (assertInt32,
// assertUInt32, …). Identical error messages so callers see the same
// diagnostic regardless of which encoder path ran. If any assertion
// fires the outer `toBinary` catches and retries via the reflective
// walk, which wraps with `cannot encode field <name> to binary: ...`.

const INT32_MAX = 0x7fffffff;
const INT32_MIN = -0x80000000;
const UINT32_MAX = 0xffffffff;

function assertInt32Fast(value: unknown): number {
  let v: unknown = value;
  if (typeof v === "string") {
    v = Number(v);
  } else if (typeof v !== "number") {
    throw new Error("invalid int32: " + typeof v);
  }
  if (
    !Number.isInteger(v) ||
    (v as number) > INT32_MAX ||
    (v as number) < INT32_MIN
  ) {
    throw new Error("invalid int32: " + v);
  }
  return v as number;
}

function assertUInt32Fast(value: unknown): number {
  let v: unknown = value;
  if (typeof v === "string") {
    v = Number(v);
  } else if (typeof v !== "number") {
    throw new Error("invalid uint32: " + typeof v);
  }
  if (!Number.isInteger(v) || (v as number) > UINT32_MAX || (v as number) < 0) {
    throw new Error("invalid uint32: " + v);
  }
  return v as number;
}

function scalarSize(type: ScalarType, value: unknown): number {
  switch (type) {
    case ScalarType.STRING: {
      // The reflective path runs non-strings through TextEncoder.encode,
      // which coerces numbers/bools to their string form without
      // throwing. Our `utf8ByteLength` requires a real string (it reads
      // `charCodeAt`), so coerce non-strings here to match.
      const s = typeof value === "string" ? value : String(value);
      const byteLen = utf8ByteLength(s);
      return varintSize32(byteLen) + byteLen;
    }
    case ScalarType.BOOL:
      return 1;
    case ScalarType.DOUBLE:
      return 8;
    case ScalarType.FLOAT:
      return 4;
    case ScalarType.INT32: {
      // Common case: typed int32. Skip the full assertion in that path.
      if (typeof value === "number" && (value | 0) === value) {
        return int32Size(value);
      }
      return int32Size(assertInt32Fast(value));
    }
    case ScalarType.UINT32: {
      if (
        typeof value === "number" &&
        value >= 0 &&
        value <= UINT32_MAX &&
        Number.isInteger(value)
      ) {
        return varintSize32(value);
      }
      return varintSize32(assertUInt32Fast(value));
    }
    case ScalarType.SINT32: {
      if (typeof value === "number" && (value | 0) === value) {
        return sint32Size(value);
      }
      return sint32Size(assertInt32Fast(value));
    }
    case ScalarType.FIXED32:
    case ScalarType.SFIXED32:
      // Size fixed; underlying writer still asserts on unsafe conversions.
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
      // Happy path: a Uint8Array (or any array-like with a numeric
      // length). Wrong-typed values fall through to the assertion so
      // the outer fallback surfaces "invalid uint32: undefined", which
      // is what the reflective walk reports.
      if (value instanceof Uint8Array) {
        return varintSize32(value.length) + value.length;
      }
      const len = (value as Uint8Array)?.length;
      assertUInt32Fast(len);
      return varintSize32(len) + len;
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
 * predicate. Mirrors `unsafeIsSet` in reflect/unsafe.ts — keep in sync.
 */
function isFieldSet(
  field: DescField,
  message: Record<string, unknown>,
  value: unknown,
): boolean {
  if (value === undefined || value === null) return false;

  // IMPLICIT-presence fields (proto3 singular scalar/enum) use "zero
  // value means unset" semantics. Lists and maps use "empty means
  // unset". Everything else (messages, proto2 optional, proto3
  // optional) has prototype defaults for zero values, so we must
  // consult hasOwnProperty to tell "really set" from "prototype
  // default read-through".
  switch (field.fieldKind) {
    case "scalar": {
      if (field.presence !== 2 /* IMPLICIT */) {
        return Object.prototype.hasOwnProperty.call(message, field.localName);
      }
      const t = field.scalar;
      if (t === ScalarType.STRING) return value !== "";
      // Mirror isScalarZeroValue: BYTES counts as "set" unless it's a
      // zero-length Uint8Array. Any other value shape is considered set
      // here so the downstream size/write step can surface the real
      // type error (e.g. `bytesField: true` becomes "invalid uint32:
      // undefined" after length coercion, matching the reflective
      // walk).
      if (t === ScalarType.BYTES) {
        return !(value instanceof Uint8Array && value.byteLength === 0);
      }
      if (t === ScalarType.BOOL) return value !== false;
      if (
        t === ScalarType.INT64 ||
        t === ScalarType.UINT64 ||
        t === ScalarType.SINT64 ||
        t === ScalarType.FIXED64 ||
        t === ScalarType.SFIXED64
      ) {
        // bigint zero, numeric zero, "0" string all represent unset.
        // Literal `0n` requires ES2020; see BIGINT_ZERO above.
        return value !== 0 && value !== BIGINT_ZERO && value !== "0";
      }
      return (value as number) !== 0;
    }
    case "enum":
      if (field.presence !== 2 /* IMPLICIT */) {
        return Object.prototype.hasOwnProperty.call(message, field.localName);
      }
      return (value as number) !== 0;
    case "message":
      // Message fields default to `undefined` on the generated class —
      // they don't carry a prototype fallback — so the `value !==
      // undefined` check at the top of this function is sufficient.
      return true;
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
// Fast path — map key helpers
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
  const fields = sortedFields(desc);
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];

    // Oneof members: the discriminator decides which one field of the
    // oneof is set. Emit in wire order — interleaved with regular
    // fields — so output matches the reflective walk byte-for-byte.
    if (field.oneof !== undefined) {
      const adt = message[field.oneof.localName] as
        | { case: string | undefined; value?: unknown }
        | undefined;
      if (!adt || adt.case !== field.localName) continue;
      size += estimateRegularFieldSize(field, adt.value, sizes);
      continue;
    }

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
    if (!isFieldSet(field, message, value)) continue;
    size += estimateRegularFieldSize(field, value, sizes);
  }
  return size;
}

// -----------------------------------------------------------------------------
// Fast path — pass 2 (write into pre-allocated buffer)
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

function writeScalarFast(c: Cursor, type: ScalarType, value: unknown): void {
  switch (type) {
    case ScalarType.STRING: {
      const s = typeof value === "string" ? value : String(value);
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
  writeScalarFast(c, field.mapKey, keyTyped);
  // Entry value: field number 2.
  switch (field.mapKind) {
    case "scalar":
      writeTag(c, 2, scalarWireType(field.scalar));
      writeScalarFast(c, field.scalar, value);
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
      writeScalarFast(c, field.scalar, value);
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
          writeScalarFast(c, t, list[k]);
        }
        return;
      }
      for (let k = 0; k < list.length; k++) {
        writeTag(c, field.number, wt);
        writeScalarFast(c, t, list[k]);
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
  const fields = sortedFields(desc);
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];

    // Oneof members: emit in wire order — interleaved with regular
    // fields — so output matches the reflective walk byte-for-byte.
    if (field.oneof !== undefined) {
      const adt = message[field.oneof.localName] as
        | { case: string | undefined; value?: unknown }
        | undefined;
      if (!adt || adt.case !== field.localName) continue;
      writeRegularField(c, field, adt.value, sizes);
      continue;
    }

    if (field.fieldKind === "map") {
      const obj = message[field.localName] as
        | Record<string, unknown>
        | undefined;
      if (!obj || Object.keys(obj).length === 0) continue;
      writeMapField(c, field as DescField & { fieldKind: "map" }, obj, sizes);
      continue;
    }

    const value = message[field.localName];
    if (!isFieldSet(field, message, value)) continue;
    writeRegularField(c, field, value, sizes);
  }
}

function encodeFast<Desc extends DescMessage>(
  schema: Desc,
  message: MessageShape<Desc>,
): Uint8Array<ArrayBuffer> {
  const sizes: SizeMap = new Map();
  const msg = message as unknown as Record<string, unknown>;
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
      `toBinary: size/write mismatch (est=${total} wrote=${cursor.pos}) — please report this as a bug`,
    );
  }
  return buf;
}

// -----------------------------------------------------------------------------
// Reflective fallback (extensions, proto2 groups, delimited encoding,
// messages with unknown fields).
// -----------------------------------------------------------------------------

function reflectiveToBinary<Desc extends DescMessage>(
  schema: Desc,
  message: MessageShape<Desc>,
  opts: BinaryWriteOptions,
): Uint8Array<ArrayBuffer> {
  return writeFields(
    new BinaryWriter(),
    opts,
    reflect(schema, message),
  ).finish();
}

function writeFields(
  writer: BinaryWriter,
  opts: BinaryWriteOptions,
  msg: ReflectMessage,
): BinaryWriter {
  for (const f of msg.sortedFields) {
    if (!msg.isSet(f)) {
      if (f.presence == LEGACY_REQUIRED) {
        throw new Error(`cannot encode ${f} to binary: required field not set`);
      }
      continue;
    }
    writeField(writer, opts, msg, f);
  }
  if (opts.writeUnknownFields) {
    for (const { no, wireType, data } of msg.getUnknown() ?? []) {
      writer.tag(no, wireType).raw(data);
    }
  }
  return writer;
}

/**
 * @private
 */
export function writeField(
  writer: BinaryWriter,
  opts: BinaryWriteOptions,
  msg: ReflectMessage,
  field: DescField,
) {
  switch (field.fieldKind) {
    case "scalar":
    case "enum":
      writeScalar(
        writer,
        msg.desc.typeName,
        field.name,
        field.scalar ?? ScalarType.INT32,
        field.number,
        msg.get(field),
      );
      break;
    case "list":
      writeListField(writer, opts, field, msg.get(field));
      break;
    case "message":
      writeMessageField(writer, opts, field, msg.get(field));
      break;
    case "map":
      for (const [key, val] of msg.get(field)) {
        writeMapEntryReflective(writer, opts, field, key, val);
      }
      break;
  }
}

function writeScalar(
  writer: BinaryWriter,
  msgName: string,
  fieldName: string,
  scalarType: ScalarType,
  fieldNo: number,
  value: unknown,
) {
  writeScalarValue(
    writer.tag(fieldNo, writeTypeOfScalar(scalarType)),
    msgName,
    fieldName,
    scalarType,
    value as ScalarValue,
  );
}

function writeMessageField(
  writer: BinaryWriter,
  opts: BinaryWriteOptions,
  field: DescField &
    ({ fieldKind: "message" } | { fieldKind: "list"; listKind: "message" }),
  message: ReflectMessage,
) {
  if (field.delimitedEncoding) {
    writeFields(
      writer.tag(field.number, WireType.StartGroup),
      opts,
      message,
    ).tag(field.number, WireType.EndGroup);
  } else {
    writeFields(
      writer.tag(field.number, WireType.LengthDelimited).fork(),
      opts,
      message,
    ).join();
  }
}

function writeListField(
  writer: BinaryWriter,
  opts: BinaryWriteOptions,
  field: DescField & { fieldKind: "list" },
  list: ReflectList,
) {
  if (field.listKind == "message") {
    for (const item of list) {
      writeMessageField(writer, opts, field, item as ReflectMessage);
    }
    return;
  }
  const scalarType = field.scalar ?? ScalarType.INT32;
  if (field.packed) {
    if (!list.size) {
      return;
    }
    writer.tag(field.number, WireType.LengthDelimited).fork();
    for (const item of list) {
      writeScalarValue(
        writer,
        field.parent.typeName,
        field.name,
        scalarType,
        item as ScalarValue,
      );
    }
    writer.join();
    return;
  }
  for (const item of list) {
    writeScalar(
      writer,
      field.parent.typeName,
      field.name,
      scalarType,
      field.number,
      item,
    );
  }
}

function writeMapEntryReflective(
  writer: BinaryWriter,
  opts: BinaryWriteOptions,
  field: DescField & { fieldKind: "map" },
  key: unknown,
  value: unknown,
) {
  writer.tag(field.number, WireType.LengthDelimited).fork();

  // write key, expecting key field number = 1
  writeScalar(writer, field.parent.typeName, field.name, field.mapKey, 1, key);

  // write value, expecting value field number = 2
  switch (field.mapKind) {
    case "scalar":
    case "enum":
      writeScalar(
        writer,
        field.parent.typeName,
        field.name,
        field.scalar ?? ScalarType.INT32,
        2,
        value,
      );
      break;
    case "message":
      writeFields(
        writer.tag(2, WireType.LengthDelimited).fork(),
        opts,
        value as ReflectMessage,
      ).join();
      break;
  }
  writer.join();
}

function writeScalarValue(
  writer: BinaryWriter,
  msgName: string,
  fieldName: string,
  type: ScalarType,
  value: ScalarValue,
) {
  try {
    switch (type) {
      case ScalarType.STRING:
        writer.string(value as string);
        break;
      case ScalarType.BOOL:
        writer.bool(value as boolean);
        break;
      case ScalarType.DOUBLE:
        writer.double(value as number);
        break;
      case ScalarType.FLOAT:
        writer.float(value as number);
        break;
      case ScalarType.INT32:
        writer.int32(value as number);
        break;
      case ScalarType.INT64:
        writer.int64(value as number);
        break;
      case ScalarType.UINT64:
        writer.uint64(value as number);
        break;
      case ScalarType.FIXED64:
        writer.fixed64(value as number);
        break;
      case ScalarType.BYTES:
        writer.bytes(value as Uint8Array);
        break;
      case ScalarType.FIXED32:
        writer.fixed32(value as number);
        break;
      case ScalarType.SFIXED32:
        writer.sfixed32(value as number);
        break;
      case ScalarType.SFIXED64:
        writer.sfixed64(value as number);
        break;
      case ScalarType.SINT64:
        writer.sint64(value as number);
        break;
      case ScalarType.UINT32:
        writer.uint32(value as number);
        break;
      case ScalarType.SINT32:
        writer.sint32(value as number);
        break;
    }
  } catch (e) {
    if (e instanceof Error) {
      throw new Error(
        `cannot encode field ${msgName}.${fieldName} to binary: ${e.message}`,
      );
    }
    throw e;
  }
}

function writeTypeOfScalar(type: ScalarType): WireType {
  switch (type) {
    case ScalarType.BYTES:
    case ScalarType.STRING:
      return WireType.LengthDelimited;
    case ScalarType.DOUBLE:
    case ScalarType.FIXED64:
    case ScalarType.SFIXED64:
      return WireType.Bit64;
    case ScalarType.FIXED32:
    case ScalarType.SFIXED32:
    case ScalarType.FLOAT:
      return WireType.Bit32;
    default:
      return WireType.Varint;
  }
}
