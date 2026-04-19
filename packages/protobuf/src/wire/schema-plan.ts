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
 * L1 schema plans + L2 specialized writer inlining.
 *
 * Implements the design spec `analysis/p1-t4-l1-l2-design-spec.md` (20 pinned
 * decisions P1-P20). A `SchemaPlan` is a flat `Int32Array` opcode stream
 * compiled once per `DescMessage` and cached in a `WeakMap`. The interpreter
 * `executeSchemaPlan` walks the opcodes with a single dense switch that inlines
 * every `BinaryWriter` call so V8 keeps monomorphic receivers on the hot path.
 *
 * L2 responsibilities live in two places, per P11-P19:
 *   - Inside L0 `BinaryWriter` (ASCII string fast path, int64 tri-dispatch,
 *     bytes direct-set). L1 inherits these transparently.
 *   - Inside this interpreter (pre-encoded tag bytes via `writer.raw`, packed
 *     repeated loops with `fork/join`, list/map iteration monomorphised).
 */

import {
  type DescField,
  type DescMessage,
  type DescOneof,
  ScalarType,
} from "../descriptors.js";
import { BinaryWriter, WireType } from "./binary-encoding.js";

// Presence values from google.protobuf.FeatureSet.FieldPresence.
// EXPLICIT=1 is handled by the generic else branch (any non-IMPLICIT presence
// that isn't LEGACY_REQUIRED just checks `v === undefined`).
// bootstrap-inject google.protobuf.FeatureSet.FieldPresence.IMPLICIT: const $name: number = $number;
const P_IMPLICIT = 2;
// bootstrap-inject google.protobuf.FeatureSet.FieldPresence.LEGACY_REQUIRED: const $name: number = $number;
const P_LEGACY_REQUIRED = 3;

// ── Opcodes (P1, P2) ────────────────────────────────────────────────────────

/**
 * Dense integer opcodes. Stride (number of Int32 slots consumed per op) is
 * defined in `STRIDE` below and is 2 for singular scalars, 3 for containers.
 */
export const Op = {
  END: 0,

  // Singular scalars — stride 2: [op, slot]
  SCALAR_INT32: 1,
  SCALAR_INT64: 2,
  SCALAR_UINT32: 3,
  SCALAR_UINT64: 4,
  SCALAR_SINT32: 5,
  SCALAR_SINT64: 6,
  SCALAR_FIXED32: 7,
  SCALAR_FIXED64: 8,
  SCALAR_SFIXED32: 9,
  SCALAR_SFIXED64: 10,
  SCALAR_FLOAT: 11,
  SCALAR_DOUBLE: 12,
  SCALAR_BOOL: 13,
  SCALAR_STRING: 14,
  SCALAR_BYTES: 15,
  SCALAR_ENUM: 16,

  // Singular message — stride 3: [op, slot, subPlanIndex]
  MESSAGE: 17,

  // Lists — stride 3: [op, slot, elementOpOrSubPlanIndex]
  LIST_SCALAR: 18,
  LIST_MESSAGE: 19,
  LIST_PACKED: 20,

  // Map — stride 3: [op, slot, mapEntryPlanIndex]
  MAP: 21,

  // Oneof — stride 3: [op, slot, oneofIndex]  (slot is unused for ONEOF)
  ONEOF: 22,
} as const;

export type Op = (typeof Op)[keyof typeof Op];

/**
 * Stride table: number of Int32 slots each opcode consumes. Indexed by opcode
 * value. All scalar ops are stride 2, all container ops stride 3.
 */
const STRIDE: Int32Array = (() => {
  const s = new Int32Array(23);
  s[Op.END] = 1;
  for (let op = 1; op <= 16; op++) s[op] = 2;
  s[Op.MESSAGE] = 3;
  s[Op.LIST_SCALAR] = 3;
  s[Op.LIST_MESSAGE] = 3;
  s[Op.LIST_PACKED] = 3;
  s[Op.MAP] = 3;
  s[Op.ONEOF] = 3;
  return s;
})();

// ── Plan types (P3) ─────────────────────────────────────────────────────────

/**
 * A compiled, read-only encoding plan for one `DescMessage`. Produced once per
 * schema per process (lazily, keyed in `planCache`). All state is monomorphic
 * after compile; the interpreter never mutates any field.
 */
export interface SchemaPlan {
  readonly opcodes: Int32Array;
  readonly fieldNames: readonly string[];
  readonly tagBytes: readonly Uint8Array[];
  readonly presence: Int32Array;
  readonly subPlans: readonly (SchemaPlan | null)[];
  readonly mapEntryPlans: readonly MapEntryPlan[];
  readonly oneofCases: readonly OneofCaseTable[];
  readonly schemaTypeName: string;
}

/**
 * Plan-level descriptor for one `map<K,V>` field. The interpreter iterates
 * message-valued entries without recursing through `compileSchemaPlan` again.
 */
interface MapEntryPlan {
  readonly mapTag: Uint8Array;
  readonly keyTag: Uint8Array;
  readonly keyOp: Op;
  readonly valTag: Uint8Array;
  readonly valOp: Op;
  readonly valSubPlan: SchemaPlan | null;
}

/**
 * Plan-level descriptor for one oneof group. Case name → (tag, op, sub-plan)
 * lookup is monomorphic for the small number of arms typical in practice.
 */
interface OneofCaseTable {
  readonly fieldName: string;
  readonly cases: Record<string, OneofCaseEntry>;
}

interface OneofCaseEntry {
  readonly tag: Uint8Array;
  readonly op: Op;
  readonly subPlan: SchemaPlan | null;
}

// ── Cache (P4) ──────────────────────────────────────────────────────────────

const planCache = new WeakMap<DescMessage, SchemaPlan | null>();

/**
 * Compile (or look up) a `SchemaPlan` for the given message descriptor.
 *
 * Returns `null` when the schema contains features outside the plan-driven
 * fast path (proto2 groups, delimited-encoded messages inside lists). The
 * caller is responsible for falling back to reflective `toBinary` in that
 * case (see `toBinaryFast`).
 */
export function compileSchemaPlan(desc: DescMessage): SchemaPlan | null {
  const cached = planCache.get(desc);
  if (cached !== undefined) return cached;

  if (!isSupported(desc)) {
    planCache.set(desc, null);
    return null;
  }

  // Phase 2: register a mutable shell before recursing — this is what makes
  // recursive / cyclic schemas terminate (P9).
  const shell = {
    opcodes: new Int32Array(0),
    fieldNames: [] as string[],
    tagBytes: [] as Uint8Array[],
    presence: new Int32Array(0),
    subPlans: [] as (SchemaPlan | null)[],
    mapEntryPlans: [] as MapEntryPlan[],
    oneofCases: [] as OneofCaseTable[],
    schemaTypeName: desc.typeName,
  };
  planCache.set(desc, shell as SchemaPlan);

  const b = new PlanBuilder();

  // Emit opcodes in field-number order (matches `ReflectMessage.sortedFields`
  // used by the reflective encoder — critical for byte-parity). Oneof groups
  // emit a single ONEOF opcode at the position of their first arm's field
  // number; subsequent arms in the same oneof are suppressed.
  const sortedFields = desc.fields.concat().sort((a, b) => a.number - b.number);
  const seenOneofs = new Set<DescOneof>();
  for (const f of sortedFields) {
    if (f.oneof !== undefined) {
      if (seenOneofs.has(f.oneof)) continue;
      seenOneofs.add(f.oneof);
      emitOneof(b, f.oneof);
      continue;
    }
    emitField(b, f);
  }

  shell.opcodes = new Int32Array(b.opcodes);
  shell.fieldNames = b.fieldNames;
  shell.tagBytes = b.tagBytes;
  shell.presence = new Int32Array(b.presence);
  shell.subPlans = b.subPlans;
  shell.mapEntryPlans = b.mapEntryPlans;
  shell.oneofCases = b.oneofCases;

  const plan = Object.freeze(shell) as SchemaPlan;
  planCache.set(desc, plan);
  return plan;
}

/**
 * Return true if `desc` and every transitively referenced schema are supported
 * by the plan-driven encoder. Unsupported schemas take the reflective fallback.
 */
function isSupported(desc: DescMessage): boolean {
  for (const f of desc.fields) {
    // Proto2 groups / DELIMITED message-encoding not supported by the fast path.
    if (f.fieldKind === "message" && f.delimitedEncoding) return false;
    if (
      f.fieldKind === "list" &&
      f.listKind === "message" &&
      f.delimitedEncoding
    ) {
      return false;
    }
  }
  return true;
}

// ── Plan builder ────────────────────────────────────────────────────────────

/**
 * Throw-away mutable builder that collects opcodes and side-table entries; the
 * typed-array + frozen plan is produced at the end of `compileSchemaPlan`.
 */
class PlanBuilder {
  readonly opcodes: number[] = [];
  readonly fieldNames: string[] = [];
  readonly tagBytes: Uint8Array[] = [];
  readonly presence: number[] = [];
  readonly subPlans: (SchemaPlan | null)[] = [];
  readonly mapEntryPlans: MapEntryPlan[] = [];
  readonly oneofCases: OneofCaseTable[] = [];

  /**
   * Allocate a slot index for a field. Slots index `fieldNames`, `tagBytes`,
   * and `presence` arrays in parallel.
   */
  reserveSlot(name: string, tag: Uint8Array, presenceValue: number): number {
    const slot = this.fieldNames.length;
    this.fieldNames.push(name);
    this.tagBytes.push(tag);
    this.presence.push(presenceValue);
    return slot;
  }

  emitOp2(op: number, slot: number): void {
    this.opcodes.push(op, slot);
  }

  emitOp3(op: number, slot: number, arg: number): void {
    this.opcodes.push(op, slot, arg);
  }

  pushSubPlan(p: SchemaPlan | null): number {
    const i = this.subPlans.length;
    this.subPlans.push(p);
    return i;
  }

  pushMapEntry(e: MapEntryPlan): number {
    const i = this.mapEntryPlans.length;
    this.mapEntryPlans.push(e);
    return i;
  }

  pushOneofTable(t: OneofCaseTable): number {
    const i = this.oneofCases.length;
    this.oneofCases.push(t);
    return i;
  }
}

// ── Field emission ──────────────────────────────────────────────────────────

function emitField(b: PlanBuilder, f: DescField): void {
  switch (f.fieldKind) {
    case "scalar": {
      const op = scalarOp(f.scalar);
      const slot = b.reserveSlot(
        f.localName,
        encodeTag(f.number, wireTypeOfScalar(f.scalar)),
        f.presence,
      );
      b.emitOp2(op, slot);
      return;
    }
    case "enum": {
      const slot = b.reserveSlot(
        f.localName,
        encodeTag(f.number, WireType.Varint),
        f.presence,
      );
      b.emitOp2(Op.SCALAR_ENUM, slot);
      return;
    }
    case "message": {
      const sub = compileSchemaPlan(f.message);
      const slot = b.reserveSlot(
        f.localName,
        encodeTag(f.number, WireType.LengthDelimited),
        f.presence,
      );
      b.emitOp3(Op.MESSAGE, slot, b.pushSubPlan(sub));
      return;
    }
    case "list": {
      if (f.listKind === "message") {
        const sub = compileSchemaPlan(f.message);
        const slot = b.reserveSlot(
          f.localName,
          encodeTag(f.number, WireType.LengthDelimited),
          f.presence,
        );
        b.emitOp3(Op.LIST_MESSAGE, slot, b.pushSubPlan(sub));
        return;
      }
      const elementType =
        f.listKind === "enum" ? ScalarType.INT32 : f.scalar;
      const elementOp =
        f.listKind === "enum" ? Op.SCALAR_ENUM : scalarOp(elementType);
      if (f.packed) {
        // Packed element tag is irrelevant (single outer tag + framed payload).
        const slot = b.reserveSlot(
          f.localName,
          encodeTag(f.number, WireType.LengthDelimited),
          f.presence,
        );
        b.emitOp3(Op.LIST_PACKED, slot, elementOp);
      } else {
        const slot = b.reserveSlot(
          f.localName,
          encodeTag(f.number, wireTypeOfScalar(elementType)),
          f.presence,
        );
        b.emitOp3(Op.LIST_SCALAR, slot, elementOp);
      }
      return;
    }
    case "map": {
      const entry = buildMapEntry(f);
      const slot = b.reserveSlot(
        f.localName,
        encodeTag(f.number, WireType.LengthDelimited),
        f.presence,
      );
      b.emitOp3(Op.MAP, slot, b.pushMapEntry(entry));
      return;
    }
  }
}

function emitOneof(b: PlanBuilder, oneof: DescOneof): void {
  const cases: Record<string, OneofCaseEntry> = Object.create(null);
  for (const f of oneof.fields) {
    let op: Op;
    let subPlan: SchemaPlan | null = null;
    let tag: Uint8Array;
    switch (f.fieldKind) {
      case "scalar":
        op = scalarOp(f.scalar);
        tag = encodeTag(f.number, wireTypeOfScalar(f.scalar));
        break;
      case "enum":
        op = Op.SCALAR_ENUM;
        tag = encodeTag(f.number, WireType.Varint);
        break;
      case "message":
        op = Op.MESSAGE;
        subPlan = compileSchemaPlan(f.message);
        tag = encodeTag(f.number, WireType.LengthDelimited);
        break;
      default:
        // Oneof fields are always singular scalar/enum/message.
        throw new Error(
          `unexpected oneof field kind on ${oneof.parent.typeName}.${oneof.name}`,
        );
    }
    cases[f.localName] = { tag, op, subPlan };
  }
  const table: OneofCaseTable = { fieldName: oneof.localName, cases };
  // Oneof is represented with a single opcode — slot is unused, so we stash a
  // zero there. No fieldName / tag side-table entry is reserved; the case
  // lookup carries everything the interpreter needs.
  const idx = b.pushOneofTable(table);
  b.opcodes.push(Op.ONEOF, 0, idx);
}

function buildMapEntry(
  f: DescField & { fieldKind: "map" },
): MapEntryPlan {
  const mapTag = encodeTag(f.number, WireType.LengthDelimited);
  const keyOp = scalarOp(f.mapKey);
  const keyTag = encodeTag(1, wireTypeOfScalar(f.mapKey));
  let valOp: Op;
  let valSubPlan: SchemaPlan | null = null;
  let valTag: Uint8Array;
  switch (f.mapKind) {
    case "scalar":
      valOp = scalarOp(f.scalar);
      valTag = encodeTag(2, wireTypeOfScalar(f.scalar));
      break;
    case "enum":
      valOp = Op.SCALAR_ENUM;
      valTag = encodeTag(2, WireType.Varint);
      break;
    case "message":
      valOp = Op.MESSAGE;
      valSubPlan = compileSchemaPlan(f.message);
      valTag = encodeTag(2, WireType.LengthDelimited);
      break;
  }
  return { mapTag, keyTag, keyOp, valTag, valOp, valSubPlan };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Map protobuf scalar type → interpreter opcode.
 */
function scalarOp(s: ScalarType): Op {
  switch (s) {
    case ScalarType.INT32:
      return Op.SCALAR_INT32;
    case ScalarType.INT64:
      return Op.SCALAR_INT64;
    case ScalarType.UINT32:
      return Op.SCALAR_UINT32;
    case ScalarType.UINT64:
      return Op.SCALAR_UINT64;
    case ScalarType.SINT32:
      return Op.SCALAR_SINT32;
    case ScalarType.SINT64:
      return Op.SCALAR_SINT64;
    case ScalarType.FIXED32:
      return Op.SCALAR_FIXED32;
    case ScalarType.FIXED64:
      return Op.SCALAR_FIXED64;
    case ScalarType.SFIXED32:
      return Op.SCALAR_SFIXED32;
    case ScalarType.SFIXED64:
      return Op.SCALAR_SFIXED64;
    case ScalarType.FLOAT:
      return Op.SCALAR_FLOAT;
    case ScalarType.DOUBLE:
      return Op.SCALAR_DOUBLE;
    case ScalarType.BOOL:
      return Op.SCALAR_BOOL;
    case ScalarType.STRING:
      return Op.SCALAR_STRING;
    case ScalarType.BYTES:
      return Op.SCALAR_BYTES;
  }
}

function wireTypeOfScalar(s: ScalarType): WireType {
  switch (s) {
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

/**
 * Encode `(fieldNo << 3 | wireType) >>> 0` as an unsigned 32-bit varint into
 * a fresh Uint8Array. Runs once per field per schema at compile time; the tiny
 * throw-away writer allocation is amortised across every encode.
 */
function encodeTag(fieldNo: number, wt: WireType): Uint8Array {
  const v = ((fieldNo << 3) | wt) >>> 0;
  const tmp = new BinaryWriter();
  tmp.uint32(v);
  // `.finish()` returns a subarray aliased to the writer's internal buffer;
  // copy into a detached Uint8Array so the plan's tag is stable and backed by
  // a fresh ArrayBuffer (no retention of the throw-away writer).
  const view = tmp.finish();
  const out = new Uint8Array(view.byteLength);
  out.set(view);
  return out;
}

// ── Interpreter (P6, P15) ───────────────────────────────────────────────────

/**
 * Execute a compiled plan against a message and serialize it to `writer`.
 *
 * Single dense switch. Every case inlines both the tag emission and the
 * scalar write so V8 sees one call site per `BinaryWriter` method in this
 * module and keeps the inline caches monomorphic.
 */
export function executeSchemaPlan(
  plan: SchemaPlan,
  // biome-ignore lint/suspicious/noExplicitAny: hot-path dynamic access
  msg: Record<string, any>,
  writer: BinaryWriter,
): void {
  const ops = plan.opcodes;
  const names = plan.fieldNames;
  const tags = plan.tagBytes;
  const pres = plan.presence;
  const n = ops.length;

  let ip = 0;
  while (ip < n) {
    const op = ops[ip];

    // Oneof has no slot-indexed fields/tags — handle it before the presence
    // gate so we don't read presence/names for a bogus slot.
    if (op === Op.ONEOF) {
      const table = plan.oneofCases[ops[ip + 2]];
      const group = msg[table.fieldName] as
        | { case?: string; value?: unknown }
        | undefined;
      const caseName = group?.case;
      if (caseName !== undefined) {
        const arm = table.cases[caseName];
        if (arm !== undefined) {
          writer.raw(arm.tag);
          if (arm.op === Op.MESSAGE) {
            writer.fork();
            const sub = arm.subPlan;
            if (sub !== null) {
              executeSchemaPlan(
                sub,
                group?.value as Record<string, unknown>,
                writer,
              );
            }
            writer.join();
          } else {
            writeScalarByOp(writer, arm.op, group?.value);
          }
        }
      }
      ip += 3;
      continue;
    }

    const slot = ops[ip + 1];
    const name = names[slot];
    const v = msg[name];
    const p = pres[slot];

    // Presence gate (P8).
    if (p === P_IMPLICIT) {
      // Implicit presence: zero/empty values are not emitted. For lists and
      // maps the corresponding op bodies still check lengths; for singular
      // scalars we filter here.
      if (op <= Op.SCALAR_ENUM) {
        if (v === undefined || v === null) {
          ip += 2;
          continue;
        }
        if (op === Op.SCALAR_STRING) {
          if ((v as string) === "") {
            ip += 2;
            continue;
          }
        } else if (op === Op.SCALAR_BOOL) {
          if (v === false) {
            ip += 2;
            continue;
          }
        } else if (op === Op.SCALAR_BYTES) {
          if ((v as Uint8Array).byteLength === 0) {
            ip += 2;
            continue;
          }
        } else {
          // Numeric scalars (including int64 as bigint/string). Loose compare
          // mirrors `isScalarZeroValue` for `== 0`.
          // biome-ignore lint/suspicious/noDoubleEquals: intentional 0 coercion
          if (v == 0) {
            ip += 2;
            continue;
          }
        }
      } else if (op === Op.MESSAGE) {
        if (v === undefined || v === null) {
          ip += 3;
          continue;
        }
      } else if (op === Op.LIST_SCALAR || op === Op.LIST_MESSAGE || op === Op.LIST_PACKED) {
        if (v === undefined || (v as unknown[]).length === 0) {
          ip += 3;
          continue;
        }
      } else if (op === Op.MAP) {
        if (v === undefined) {
          ip += 3;
          continue;
        }
      }
    } else {
      // Explicit or legacy-required: unset is `undefined` (own-property absent
      // via prototype fallback).
      if (v === undefined) {
        if (p === P_LEGACY_REQUIRED) {
          throw new Error(
            `cannot encode ${plan.schemaTypeName}.${name} to binary: required field not set`,
          );
        }
        ip += STRIDE[op];
        continue;
      }
    }

    switch (op) {
      case Op.SCALAR_INT32:
        writer.raw(tags[slot]);
        writer.int32(v as number);
        break;
      case Op.SCALAR_INT64:
        writer.raw(tags[slot]);
        writer.int64(v as number | bigint | string);
        break;
      case Op.SCALAR_UINT32:
        writer.raw(tags[slot]);
        writer.uint32(v as number);
        break;
      case Op.SCALAR_UINT64:
        writer.raw(tags[slot]);
        writer.uint64(v as number | bigint | string);
        break;
      case Op.SCALAR_SINT32:
        writer.raw(tags[slot]);
        writer.sint32(v as number);
        break;
      case Op.SCALAR_SINT64:
        writer.raw(tags[slot]);
        writer.sint64(v as number | bigint | string);
        break;
      case Op.SCALAR_FIXED32:
        writer.raw(tags[slot]);
        writer.fixed32(v as number);
        break;
      case Op.SCALAR_FIXED64:
        writer.raw(tags[slot]);
        writer.fixed64(v as number | bigint | string);
        break;
      case Op.SCALAR_SFIXED32:
        writer.raw(tags[slot]);
        writer.sfixed32(v as number);
        break;
      case Op.SCALAR_SFIXED64:
        writer.raw(tags[slot]);
        writer.sfixed64(v as number | bigint | string);
        break;
      case Op.SCALAR_FLOAT:
        writer.raw(tags[slot]);
        writer.float(v as number);
        break;
      case Op.SCALAR_DOUBLE:
        writer.raw(tags[slot]);
        writer.double(v as number);
        break;
      case Op.SCALAR_BOOL:
        writer.raw(tags[slot]);
        writer.bool(v as boolean);
        break;
      case Op.SCALAR_STRING:
        writer.raw(tags[slot]);
        writer.string(v as string);
        break;
      case Op.SCALAR_BYTES:
        writer.raw(tags[slot]);
        writer.bytes(v as Uint8Array);
        break;
      case Op.SCALAR_ENUM:
        writer.raw(tags[slot]);
        writer.int32(v as number);
        break;

      case Op.MESSAGE: {
        const sub = plan.subPlans[ops[ip + 2]];
        if (sub === null) {
          throw new Error(`sub-plan missing for ${name}`);
        }
        writer.raw(tags[slot]);
        writer.fork();
        executeSchemaPlan(
          sub,
          v as Record<string, unknown>,
          writer,
        );
        writer.join();
        break;
      }

      case Op.LIST_SCALAR: {
        const list = v as unknown[];
        const eop = ops[ip + 2] as Op;
        const tag = tags[slot];
        for (let i = 0, L = list.length; i < L; i++) {
          writer.raw(tag);
          writeScalarByOp(writer, eop, list[i]);
        }
        break;
      }

      case Op.LIST_PACKED: {
        const list = v as unknown[];
        const L = list.length;
        if (L > 0) {
          const eop = ops[ip + 2] as Op;
          writer.raw(tags[slot]);
          writer.fork();
          for (let i = 0; i < L; i++) {
            writeScalarByOp(writer, eop, list[i]);
          }
          writer.join();
        }
        break;
      }

      case Op.LIST_MESSAGE: {
        const list = v as unknown[];
        const sub = plan.subPlans[ops[ip + 2]];
        if (sub === null) {
          throw new Error(`sub-plan missing for ${name}`);
        }
        const tag = tags[slot];
        for (let i = 0, L = list.length; i < L; i++) {
          writer.raw(tag);
          writer.fork();
          executeSchemaPlan(
            sub,
            list[i] as Record<string, unknown>,
            writer,
          );
          writer.join();
        }
        break;
      }

      case Op.MAP: {
        const entry = plan.mapEntryPlans[ops[ip + 2]];
        const mapObj = v as Record<string | number, unknown>;
        // Maps are plain JS objects keyed by string or number (coerced to
        // string property names). Use `Object.keys` iteration for shape
        // stability — matches protobuf-es v2 map representation.
        const keys = Object.keys(mapObj);
        if (keys.length > 0) {
          for (let i = 0, L = keys.length; i < L; i++) {
            const k = keys[i];
            const mv = mapObj[k];
            writer.raw(entry.mapTag);
            writer.fork();
            writer.raw(entry.keyTag);
            // Integer-keyed maps expose keys as strings at iteration; coerce
            // back to number before handing to the scalar writer.
            writeScalarByOp(
              writer,
              entry.keyOp,
              isIntegerKeyOp(entry.keyOp) ? Number(k) : k,
            );
            writer.raw(entry.valTag);
            if (entry.valOp === Op.MESSAGE) {
              writer.fork();
              if (entry.valSubPlan !== null) {
                executeSchemaPlan(
                  entry.valSubPlan,
                  mv as Record<string, unknown>,
                  writer,
                );
              }
              writer.join();
            } else {
              writeScalarByOp(writer, entry.valOp, mv);
            }
            writer.join();
          }
        }
        break;
      }

      default:
        // Shouldn't happen — unknown opcode. Throw for safety.
        throw new Error(`unknown opcode ${op} at ip=${ip}`);
    }

    ip += STRIDE[op];
  }

  // Unknown-fields pass-through (write in compile-time order among fields is
  // not required; legacy behaviour appends them at the end after known fields).
  // We rely on the caller to decide whether to include them via `toBinaryFast`.
}

/**
 * Return true for opcodes whose key representation in a map is an integer.
 * All map-key scalars are numeric except STRING/BOOL (bool is still stored as
 * "true"/"false" property names). Keys for int32/int64/etc. come back as JS
 * strings from `Object.keys`, so we coerce before writing.
 */
function isIntegerKeyOp(op: Op): boolean {
  switch (op) {
    case Op.SCALAR_INT32:
    case Op.SCALAR_INT64:
    case Op.SCALAR_UINT32:
    case Op.SCALAR_UINT64:
    case Op.SCALAR_SINT32:
    case Op.SCALAR_SINT64:
    case Op.SCALAR_FIXED32:
    case Op.SCALAR_FIXED64:
    case Op.SCALAR_SFIXED32:
    case Op.SCALAR_SFIXED64:
      return true;
    default:
      return false;
  }
}

/**
 * Monomorphic element writer for list/map/oneof elements.
 *
 * Hot path but called from exactly three sites with a `BinaryWriter` receiver
 * — V8 keeps the inline cache stable.
 */
function writeScalarByOp(writer: BinaryWriter, op: Op, v: unknown): void {
  switch (op) {
    case Op.SCALAR_INT32:
      writer.int32(v as number);
      return;
    case Op.SCALAR_INT64:
      writer.int64(v as number | bigint | string);
      return;
    case Op.SCALAR_UINT32:
      writer.uint32(v as number);
      return;
    case Op.SCALAR_UINT64:
      writer.uint64(v as number | bigint | string);
      return;
    case Op.SCALAR_SINT32:
      writer.sint32(v as number);
      return;
    case Op.SCALAR_SINT64:
      writer.sint64(v as number | bigint | string);
      return;
    case Op.SCALAR_FIXED32:
      writer.fixed32(v as number);
      return;
    case Op.SCALAR_FIXED64:
      writer.fixed64(v as number | bigint | string);
      return;
    case Op.SCALAR_SFIXED32:
      writer.sfixed32(v as number);
      return;
    case Op.SCALAR_SFIXED64:
      writer.sfixed64(v as number | bigint | string);
      return;
    case Op.SCALAR_FLOAT:
      writer.float(v as number);
      return;
    case Op.SCALAR_DOUBLE:
      writer.double(v as number);
      return;
    case Op.SCALAR_BOOL:
      writer.bool(v as boolean);
      return;
    case Op.SCALAR_STRING:
      writer.string(v as string);
      return;
    case Op.SCALAR_BYTES:
      writer.bytes(v as Uint8Array);
      return;
    case Op.SCALAR_ENUM:
      writer.int32(v as number);
      return;
    default:
      throw new Error(`unexpected element opcode ${op}`);
  }
}
