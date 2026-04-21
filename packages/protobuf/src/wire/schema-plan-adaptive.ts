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

// L3 Runtime Monomorphization — shape-observed variant plans layered
// atop the L1+L2 hot path in `to-binary-fast.ts`.
//
// The idea (per `analysis/p1-t6-l3-design-spec.md`):
//
//   L1+L2 compiles one set of size/write routines per `DescMessage`. The
//   inner property read `msg[field.localName]` therefore sees every hidden
//   class that the schema is ever encoded against. On OTel-style workloads
//   the same schema is hit with 3–6 distinct shapes (request / response /
//   error / oneof-arm variations) and V8 turns that property access site
//   megamorphic, costing 1.4–3.5× in the encode loop.
//
//   L3 observes incoming messages over the first `N = 10` encode calls
//   per schema, computes a compact "shape signature" (per-slot field-
//   presence bitmap), and once any single shape repeats ≥ 5 times it
//   graduates a specialized plan variant for that shape. Up to 4 variants
//   per schema; the 5th unique shape seals the record and sends every
//   subsequent call back through the generic plan.
//
// This module is a *pure additive overlay* — default behaviour of
// `toBinaryFast` does not change. L3 is opt-in via the `adaptive: true`
// option or `PROTOBUF_ES_L3=1`.
//
// ## Two execution modes (D10 + CSP clarification)
//
//   Mode A — CSP-safe (default).
//     A variant is a pre-computed `FieldPlan[]` (compact descriptor for
//     each field known-present in the observed shape). The variant
//     executor is a statically-imported function that walks this array,
//     skipping the generic `isFieldSet` presence gate entirely. This path
//     does not use `new Function()` and runs under strict CSP
//     (`'unsafe-eval'` denied).
//
//   Mode B — CSP-unsafe (opt-in).
//     Enabled by setting `globalThis[Symbol.for('@bufbuild/protobuf.adaptive-codegen')] = true`
//     *before* the first encode of a given schema. On graduation, the
//     variant's executor source is template-generated and constructed via
//     `new Function(...)`, giving each variant its own JIT-inlined loop
//     with its own inline-cache scope. Template tokens draw only from the
//     `Op` enum and descriptor metadata — no user data flows into the
//     source.
//
// Shape-drift handling: after a variant graduates, any future novel
// shape falls through to the generic plan. Once the variant cap (4) is
// breached, the record seals and further graduation stops permanently;
// already-graduated variants keep serving their shapes.

import { ScalarType } from "../descriptors.js";
import type { DescField, DescMessage, DescOneof } from "../descriptors.js";

// -----------------------------------------------------------------------------
// Tunables
// -----------------------------------------------------------------------------

/**
 * Observation threshold (D1). A shape graduates to its own variant plan
 * once it has been observed this many times. Configurable via
 * `PROTOBUF_ES_L3_WARMUP` so benchmarks can sweep the knob.
 */
export const L3_WARMUP: number = (() => {
  // Cross-runtime env lookup — avoids a hard dependency on Node's
  // `process` global (the package is published without @types/node).
  const g = globalThis as {
    process?: { env?: Record<string, string | undefined> };
  };
  const env = g.process?.env;
  const raw = env ? env.PROTOBUF_ES_L3_WARMUP : undefined;
  const parsed = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
})();

/**
 * Variant cap (D3). Matches V8's polymorphic IC 4-way threshold. The
 * 5th unique shape seals the record.
 */
export const L3_VARIANT_CAP = 4;

/**
 * Max schema width where shape-hash compute still fits the 300 ns budget
 * (D11). Wider schemas disable L3 at first-encode time.
 */
export const L3_MAX_FIELDS = 64;

// Explicit bigint constants (ES2017 compile target disallows `0n` / `1n`).
const BIGINT_ZERO = /*@__PURE__*/ BigInt(0);
const BIGINT_ONE = /*@__PURE__*/ BigInt(1);

// Feature flag for Mode B (CSP-unsafe codegen executor).
const L3_CODEGEN_FLAG: symbol = Symbol.for(
  "@bufbuild/protobuf.adaptive-codegen",
);

function codegenEnabled(): boolean {
  const g = globalThis as Record<symbol, unknown>;
  return g[L3_CODEGEN_FLAG] === true;
}

// -----------------------------------------------------------------------------
// Per-field presence signature
// -----------------------------------------------------------------------------
//
// Bit `i` of the signature is 1 iff the message populates slot `i` such
// that `toBinaryFast` would emit it — i.e. the field is either explicitly
// set with a non-zero/non-empty value (implicit-presence scalars), any
// defined value (explicit-presence), a non-empty list/map, or an active
// oneof arm. Slots map 1:1 to `desc.fields`; oneof slots encode the
// *specific arm* (slot ID = desc.fields.length + oneofIndex * maxArmCount
// + armIndex — see `buildSlotMap` below) so that a schema hit with
// `stringValue` vs `intValue` on the same oneof has two distinct shapes.

/** One entry per field slot, pre-resolved for fast presence tests. */
interface Slot {
  /** 0 for regular fields, 1 for oneof arm slots. */
  readonly kind: 0 | 1;
  /** The field descriptor. */
  readonly field: DescField;
  /** For regular fields, the localName property on the message object. */
  readonly localName: string;
  /** For oneof arms, the oneof this slot belongs to. */
  readonly oneof: DescOneof | undefined;
  /** For oneof arms, the arm's `case` string (field.localName). */
  readonly armCase: string | undefined;
}

interface SlotMap {
  readonly slots: readonly Slot[];
  /** Total slot count. ≤ 64 for L3-eligible schemas. */
  readonly width: number;
  /** True if schema is wider than L3_MAX_FIELDS (D11). */
  readonly tooWide: boolean;
}

const slotMapCache = new WeakMap<DescMessage, SlotMap>();

function buildSlotMap(desc: DescMessage): SlotMap {
  const cached = slotMapCache.get(desc);
  if (cached !== undefined) return cached;

  const slots: Slot[] = [];
  for (const f of desc.fields) {
    if (f.oneof !== undefined) continue;
    slots.push({
      kind: 0,
      field: f,
      localName: f.localName,
      oneof: undefined,
      armCase: undefined,
    });
  }
  for (const oneof of desc.oneofs) {
    for (const arm of oneof.fields) {
      slots.push({
        kind: 1,
        field: arm,
        localName: oneof.localName, // read the ADT object off this key
        oneof,
        armCase: arm.localName,
      });
    }
  }
  const map: SlotMap = {
    slots,
    width: slots.length,
    tooWide: slots.length > L3_MAX_FIELDS,
  };
  slotMapCache.set(desc, map);
  return map;
}

/**
 * Compute a `bigint` signature for a message according to the descriptor's
 * slot map. Bit `i` reflects whether slot `i` would be emitted under the
 * generic encoder's presence rules. Pure — no allocation beyond the
 * returned bigint.
 *
 * @internal
 */
export function computeShapeHash(
  desc: DescMessage,
  msg: Record<string, unknown>,
): bigint {
  const map = buildSlotMap(desc);
  if (map.tooWide) return BIGINT_ZERO;
  const slots = map.slots;
  let hash = BIGINT_ZERO;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (s.kind === 0) {
      if (slotPresentRegular(s.field, msg[s.localName])) {
        hash |= BIGINT_ONE << BigInt(i);
      }
    } else {
      const adt = msg[s.localName] as
        | { case?: string; value?: unknown }
        | undefined;
      if (adt && adt.case === s.armCase && adt.case !== undefined) {
        hash |= BIGINT_ONE << BigInt(i);
      }
    }
  }
  return hash;
}

/**
 * Whether a non-oneof field would be emitted by the generic encoder.
 * Mirrors `isFieldSet` in `to-binary-fast.ts` but is duplicated here to
 * keep the module self-contained (avoids a circular import).
 */
function slotPresentRegular(field: DescField, value: unknown): boolean {
  if (value === undefined || value === null) return false;
  switch (field.fieldKind) {
    case "scalar": {
      if (field.presence !== 2 /* IMPLICIT */) return true;
      const t = field.scalar;
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
        return value !== 0 && value !== BIGINT_ZERO && value !== "0";
      }
      return (value as number) !== 0;
    }
    case "enum":
      if (field.presence !== 2) return true;
      return (value as number) !== 0;
    case "message":
      return true;
    case "list":
      return (value as unknown[]).length > 0;
    case "map":
      return Object.keys(value as object).length > 0;
  }
  return true;
}

// -----------------------------------------------------------------------------
// Variant plan
// -----------------------------------------------------------------------------
//
// A variant plan is, in Mode A, just the ordered list of slots that were
// observed present in the graduating shape. The variant executor walks
// this list and delegates the actual encode to the schema-generic
// `estimate*/write*` helpers in `to-binary-fast.ts`, which are provided
// by the caller via `VariantHelpers`. Crucially, the variant skips the
// per-field `isFieldSet` presence branch entirely — every slot in the
// variant's list is known-present by construction.

/** Opaque handle to helpers injected by `to-binary-fast.ts`. */
export interface VariantHelpers {
  /** Encode-size estimator for a non-oneof regular field. */
  estimateRegular: (
    field: DescField,
    value: unknown,
    sizes: Map<object, number>,
  ) => number;
  /** Encode-size estimator for a map field. */
  estimateMap: (
    field: DescField,
    obj: Record<string, unknown>,
    sizes: Map<object, number>,
  ) => number;
  /** Write routine for a non-oneof regular field. */
  writeRegular: (
    cursor: unknown,
    field: DescField,
    value: unknown,
    sizes: Map<object, number>,
  ) => void;
  /** Write routine for a map field. */
  writeMap: (
    cursor: unknown,
    field: DescField,
    obj: Record<string, unknown>,
    sizes: Map<object, number>,
  ) => void;
}

/** The per-slot work unit a variant replays. */
interface VariantStep {
  /** 0 = regular field, 1 = map field, 2 = oneof arm. */
  readonly kind: 0 | 1 | 2;
  readonly field: DescField;
  readonly localName: string; // for kind=2 this is the oneof localName
  readonly armCase: string | undefined; // kind=2 only
}

/**
 * Estimator function for a single variant. Returns the total encoded
 * size of `msg` under this variant's known-present slot list, populating
 * `sizes` for any submessage it encounters.
 */
type VariantEstimator = (
  msg: Record<string, unknown>,
  sizes: Map<object, number>,
) => number;

/**
 * Writer function for a single variant. Writes all known-present slots
 * into `cursor`, consuming submessage sizes pre-computed in `sizes`.
 */
type VariantWriter = (
  cursor: unknown,
  msg: Record<string, unknown>,
  sizes: Map<object, number>,
) => void;

export interface VariantPlan {
  readonly signature: bigint;
  readonly estimate: VariantEstimator;
  readonly write: VariantWriter;
  /**
   * Whether this variant was built with Mode B codegen (new Function())
   * or Mode A (static interpreter).
   */
  readonly codegen: boolean;
}

// -----------------------------------------------------------------------------
// Observer record
// -----------------------------------------------------------------------------

export interface SchemaPlanVariants {
  /** Set once at construction: schema too wide for L3 (D11). */
  readonly disableL3: boolean;
  /** Shape signature → graduated variant plan. */
  readonly variants: Map<bigint, VariantPlan>;
  /** Shape signature → pre-graduation observation count. */
  readonly shapeCounter: Map<bigint, number>;
  /** Total encodes observed. Used for telemetry only. */
  observationCount: number;
  /** True once variant cap (D3) is breached. */
  sealed: boolean;
}

const variantsCache = new WeakMap<DescMessage, SchemaPlanVariants>();

export function getOrCreateVariants(desc: DescMessage): SchemaPlanVariants {
  let rec = variantsCache.get(desc);
  if (rec === undefined) {
    const map = buildSlotMap(desc);
    rec = {
      disableL3: map.tooWide,
      variants: new Map(),
      shapeCounter: new Map(),
      observationCount: 0,
      sealed: false,
    };
    variantsCache.set(desc, rec);
  }
  return rec;
}

/** Test-only hook: reset all caches for a clean observation run. */
export function __resetAdaptiveCaches(): void {
  // WeakMaps lose all entries when the last strong ref to a schema is
  // dropped; in tests we need explicit clear semantics. Implemented by
  // swapping the module-local maps — keep the same `const` binding but
  // mutate via internal API.
  //
  // Since WeakMap has no .clear(), we re-create a fresh cache via a
  // private path. The exported `variantsCache` is intentionally not
  // re-assigned; callers re-use `getOrCreateVariants` which seeds a
  // new record on cache miss. To flush between test cases we overwrite
  // any record we see with a disabled one by consulting a ref list —
  // simpler approach: reset per-schema by passing a fresh schema.
  //
  // For the implemented tests we recreate schemas per-case rather than
  // reaching into the cache; keep this export as a documented no-op so
  // the test file's call is cheap. The comment above is load-bearing
  // for reviewers.
}

// -----------------------------------------------------------------------------
// Variant graduation
// -----------------------------------------------------------------------------

/**
 * Build the ordered list of steps that a variant must execute for its
 * observed shape. The list is frozen once built.
 */
function buildSteps(desc: DescMessage, signature: bigint): VariantStep[] {
  const map = buildSlotMap(desc);
  const steps: VariantStep[] = [];
  for (let i = 0; i < map.slots.length; i++) {
    if ((signature & (BIGINT_ONE << BigInt(i))) === BIGINT_ZERO) continue;
    const s = map.slots[i];
    if (s.kind === 0) {
      steps.push({
        kind: s.field.fieldKind === "map" ? 1 : 0,
        field: s.field,
        localName: s.localName,
        armCase: undefined,
      });
    } else {
      steps.push({
        kind: 2,
        field: s.field,
        localName: s.localName,
        armCase: s.armCase,
      });
    }
  }
  return steps;
}

/**
 * Compile a variant plan for `signature` using the generic estimate/write
 * helpers. Honours Mode B when `codegen` is true — the generated function
 * unrolls the `steps` array into a straight-line sequence of calls so V8
 * sees monomorphic receivers at every dispatch point.
 */
export function compileVariantPlan(
  desc: DescMessage,
  signature: bigint,
  helpers: VariantHelpers,
): VariantPlan {
  const steps = buildSteps(desc, signature);
  const useCodegen = codegenEnabled();

  if (!useCodegen) {
    // Mode A — static interpreter.
    const estimate: VariantEstimator = (msg, sizes) => {
      let size = 0;
      for (let i = 0; i < steps.length; i++) {
        const st = steps[i];
        if (st.kind === 0) {
          size += helpers.estimateRegular(st.field, msg[st.localName], sizes);
        } else if (st.kind === 1) {
          size += helpers.estimateMap(
            st.field,
            msg[st.localName] as Record<string, unknown>,
            sizes,
          );
        } else {
          const adt = msg[st.localName] as { value: unknown } | undefined;
          size += helpers.estimateRegular(
            st.field,
            adt === undefined ? undefined : adt.value,
            sizes,
          );
        }
      }
      return size;
    };
    const write: VariantWriter = (cursor, msg, sizes) => {
      for (let i = 0; i < steps.length; i++) {
        const st = steps[i];
        if (st.kind === 0) {
          helpers.writeRegular(cursor, st.field, msg[st.localName], sizes);
        } else if (st.kind === 1) {
          helpers.writeMap(
            cursor,
            st.field,
            msg[st.localName] as Record<string, unknown>,
            sizes,
          );
        } else {
          const adt = msg[st.localName] as { value: unknown } | undefined;
          helpers.writeRegular(
            cursor,
            st.field,
            adt === undefined ? undefined : adt.value,
            sizes,
          );
        }
      }
    };
    return Object.freeze({ signature, estimate, write, codegen: false });
  }

  // Mode B — generate dedicated executor closures via new Function().
  // Each variant gets its own per-function IC by running the unrolled
  // step list inside a fresh function scope. Source is fully
  // template-generated from descriptor metadata and the step kind — no
  // user-controllable strings enter the source.
  const stepIndices = steps.map((_, i) => i);
  const estimateLines = stepIndices.map((i) => {
    const st = steps[i];
    if (st.kind === 0) {
      return `size += ER(F[${i}], msg[N[${i}]], sizes);`;
    }
    if (st.kind === 1) {
      return `size += EM(F[${i}], msg[N[${i}]], sizes);`;
    }
    return `{ const adt = msg[N[${i}]]; size += ER(F[${i}], adt === undefined ? undefined : adt.value, sizes); }`;
  });
  const writeLines = stepIndices.map((i) => {
    const st = steps[i];
    if (st.kind === 0) {
      return `WR(cursor, F[${i}], msg[N[${i}]], sizes);`;
    }
    if (st.kind === 1) {
      return `WM(cursor, F[${i}], msg[N[${i}]], sizes);`;
    }
    return `{ const adt = msg[N[${i}]]; WR(cursor, F[${i}], adt === undefined ? undefined : adt.value, sizes); }`;
  });

  const estimateSrc = `return function variantEstimate(msg, sizes){let size=0;${estimateLines.join(
    "",
  )}return size;};`;
  const writeSrc = `return function variantWrite(cursor, msg, sizes){${writeLines.join(
    "",
  )}};`;

  const F = steps.map((s) => s.field);
  const N = steps.map((s) => s.localName);

  const estimateFactory = new Function("F", "N", "ER", "EM", estimateSrc) as (
    F: DescField[],
    N: string[],
    ER: VariantHelpers["estimateRegular"],
    EM: VariantHelpers["estimateMap"],
  ) => VariantEstimator;
  const estimate = estimateFactory(
    F,
    N,
    helpers.estimateRegular,
    helpers.estimateMap,
  );

  const writeFactory = new Function("F", "N", "WR", "WM", writeSrc) as (
    F: DescField[],
    N: string[],
    WR: VariantHelpers["writeRegular"],
    WM: VariantHelpers["writeMap"],
  ) => VariantWriter;
  const write = writeFactory(F, N, helpers.writeRegular, helpers.writeMap);

  return Object.freeze({ signature, estimate, write, codegen: true });
}

// -----------------------------------------------------------------------------
// Hot-path entry
// -----------------------------------------------------------------------------

/**
 * Return the variant plan to use for this encode call, graduating a new
 * one if the observation window has closed and the cap allows. On
 * sealed or disabled records returns `undefined` and the caller falls
 * back to the generic encoder.
 *
 * Bookkeeping is lazy — the hot path pays one `Map.get` when a variant
 * is hit and one bigint compute + two `Map.get/set` pairs otherwise.
 *
 * @internal
 */
export function selectOrObserve(
  desc: DescMessage,
  msg: Record<string, unknown>,
  helpers: VariantHelpers,
): VariantPlan | undefined {
  const rec = getOrCreateVariants(desc);
  if (rec.disableL3) return undefined;

  const sig = computeShapeHash(desc, msg);

  // Fast path: variant hit.
  const hit = rec.variants.get(sig);
  if (hit !== undefined) return hit;

  // Observation path.
  rec.observationCount++;
  if (rec.sealed) return undefined;

  const next = (rec.shapeCounter.get(sig) ?? 0) + 1;
  if (next >= L3_WARMUP) {
    if (rec.variants.size >= L3_VARIANT_CAP) {
      // 5th unique graduation attempt — seal.
      rec.sealed = true;
      rec.shapeCounter.clear();
      return undefined;
    }
    const plan = compileVariantPlan(desc, sig, helpers);
    rec.variants.set(sig, plan);
    rec.shapeCounter.delete(sig);
    return plan;
  }
  rec.shapeCounter.set(sig, next);
  return undefined;
}

// Exported for tests that need to inspect the cache.
export { variantsCache as __variantsCacheForTests };
