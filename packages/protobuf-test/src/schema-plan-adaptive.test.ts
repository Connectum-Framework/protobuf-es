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

// L3 runtime monomorphization tests. The load-bearing claims:
//
//   1) The shape observer graduates a variant after `L3_WARMUP` repeats of
//      the same shape and that variant produces byte-identical output to
//      both `toBinaryFast` (generic L1+L2) and `toBinary` (reflective).
//   2) The variant cap (`L3_VARIANT_CAP = 4`) seals the record when a 5th
//      distinct shape asks for graduation; subsequent novel shapes never
//      re-trigger graduation.
//   3) Shape drift after seal routes back through the generic plan and
//      remains byte-parity correct.
//   4) Mode B (`new Function()` executor) is gated behind the opt-in flag
//      and produces output byte-identical to Mode A for the same shape.

import { suite, test } from "node:test";
import * as assert from "node:assert";
import { create, toBinary, toBinaryFast, protoInt64 } from "@bufbuild/protobuf";
import {
  getOrCreateVariants,
  computeShapeHash,
  L3_WARMUP,
  L3_VARIANT_CAP,
} from "@bufbuild/protobuf/wire/schema-plan-adaptive";

import { ScalarValuesMessageSchema } from "./gen/ts/extra/msg-scalar_pb.js";
import {
  OneofMessageSchema,
  OneofMessageFooSchema,
} from "./gen/ts/extra/msg-oneof_pb.js";

// Re-use `ScalarValuesMessageSchema` which carries a wide mix of scalar
// types and explicit/implicit presence. Each test must construct a fresh
// schema reference to get a clean observer record — we rely on WeakMap
// keying by schema identity and this file always keys off the imported
// schema object. To reset state between tests we call `getOrCreateVariants`
// and clear the observer in-place via its public mutable fields.
function resetObserver(desc: Parameters<typeof getOrCreateVariants>[0]): void {
  const rec = getOrCreateVariants(desc);
  (rec as { sealed: boolean }).sealed = false;
  (rec as { observationCount: number }).observationCount = 0;
  rec.shapeCounter.clear();
  rec.variants.clear();
}

void suite("L3 schema-plan-adaptive", () => {
  void suite("shape hashing", () => {
    test("distinct presence patterns produce distinct bigint signatures", () => {
      const a = create(ScalarValuesMessageSchema, { doubleField: 1 });
      const b = create(ScalarValuesMessageSchema, { stringField: "hi" });
      const hA = computeShapeHash(
        ScalarValuesMessageSchema,
        a as unknown as Record<string, unknown>,
      );
      const hB = computeShapeHash(
        ScalarValuesMessageSchema,
        b as unknown as Record<string, unknown>,
      );
      assert.notStrictEqual(hA, hB);
      assert.ok(typeof hA === "bigint");
      assert.ok(typeof hB === "bigint");
    });

    test("same presence pattern yields same signature regardless of values", () => {
      const a = create(ScalarValuesMessageSchema, { int32Field: 1 });
      const b = create(ScalarValuesMessageSchema, { int32Field: 999 });
      assert.strictEqual(
        computeShapeHash(
          ScalarValuesMessageSchema,
          a as unknown as Record<string, unknown>,
        ),
        computeShapeHash(
          ScalarValuesMessageSchema,
          b as unknown as Record<string, unknown>,
        ),
      );
    });

    test("oneof arms are distinct signatures", () => {
      const strArm = create(OneofMessageSchema, {
        scalar: { case: "error", value: "oops" },
      });
      const intArm = create(OneofMessageSchema, {
        scalar: { case: "value", value: 7 },
      });
      const hStr = computeShapeHash(
        OneofMessageSchema,
        strArm as unknown as Record<string, unknown>,
      );
      const hInt = computeShapeHash(
        OneofMessageSchema,
        intArm as unknown as Record<string, unknown>,
      );
      assert.notStrictEqual(hStr, hInt);
    });
  });

  void suite("graduation", () => {
    test("same shape graduates after L3_WARMUP encodes", () => {
      resetObserver(ScalarValuesMessageSchema);
      const msg = create(ScalarValuesMessageSchema, {
        doubleField: 1.5,
        int32Field: 42,
      });
      // Before graduation: observationCount accrues, no variants.
      for (let i = 0; i < L3_WARMUP - 1; i++) {
        toBinaryFast(ScalarValuesMessageSchema, msg, { adaptive: true });
      }
      let rec = getOrCreateVariants(ScalarValuesMessageSchema);
      assert.strictEqual(rec.variants.size, 0);
      assert.strictEqual(
        rec.observationCount,
        L3_WARMUP - 1,
        "pre-graduation observation count",
      );

      // N-th call crosses the threshold and graduates.
      toBinaryFast(ScalarValuesMessageSchema, msg, { adaptive: true });
      rec = getOrCreateVariants(ScalarValuesMessageSchema);
      assert.strictEqual(rec.variants.size, 1);
      assert.strictEqual(rec.shapeCounter.size, 0);
    });

    test("variant encodes byte-identical to generic plan", () => {
      resetObserver(ScalarValuesMessageSchema);
      const msg = create(ScalarValuesMessageSchema, {
        doubleField: 3.14,
        stringField: "hello",
        int64Field: protoInt64.parse("9000000000"),
      });
      // Warmup past graduation.
      for (let i = 0; i < L3_WARMUP; i++) {
        toBinaryFast(ScalarValuesMessageSchema, msg, { adaptive: true });
      }
      // This call lands on the variant plan.
      const viaVariant = toBinaryFast(ScalarValuesMessageSchema, msg, {
        adaptive: true,
      });
      const viaGeneric = toBinaryFast(ScalarValuesMessageSchema, msg);
      const viaReflective = toBinary(ScalarValuesMessageSchema, msg);
      assert.deepStrictEqual(Array.from(viaVariant), Array.from(viaGeneric));
      assert.deepStrictEqual(Array.from(viaVariant), Array.from(viaReflective));
    });
  });

  void suite("variant cap", () => {
    test("5th distinct shape seals the record", () => {
      resetObserver(ScalarValuesMessageSchema);
      // Shape 1..4 — graduate each.
      const shapes = [
        create(ScalarValuesMessageSchema, { doubleField: 1 }),
        create(ScalarValuesMessageSchema, { stringField: "a" }),
        create(ScalarValuesMessageSchema, { int32Field: 1 }),
        create(ScalarValuesMessageSchema, { int64Field: protoInt64.parse(1) }),
      ];
      for (const shape of shapes) {
        for (let i = 0; i < L3_WARMUP; i++) {
          toBinaryFast(ScalarValuesMessageSchema, shape, { adaptive: true });
        }
      }
      const rec1 = getOrCreateVariants(ScalarValuesMessageSchema);
      assert.strictEqual(
        rec1.variants.size,
        L3_VARIANT_CAP,
        "expected 4 graduated variants",
      );
      assert.strictEqual(rec1.sealed, false);

      // Shape 5 — attempt to graduate should seal.
      const shape5 = create(ScalarValuesMessageSchema, { boolField: true });
      for (let i = 0; i < L3_WARMUP; i++) {
        toBinaryFast(ScalarValuesMessageSchema, shape5, { adaptive: true });
      }
      const rec2 = getOrCreateVariants(ScalarValuesMessageSchema);
      assert.strictEqual(rec2.sealed, true, "record must seal on 5th shape");
      assert.strictEqual(
        rec2.variants.size,
        L3_VARIANT_CAP,
        "no new variant is added on seal",
      );
    });

    test("post-seal novel shapes still encode byte-parity", () => {
      resetObserver(ScalarValuesMessageSchema);
      // Graduate 4 shapes then trigger seal.
      const shapes = [
        create(ScalarValuesMessageSchema, { doubleField: 1 }),
        create(ScalarValuesMessageSchema, { stringField: "a" }),
        create(ScalarValuesMessageSchema, { int32Field: 1 }),
        create(ScalarValuesMessageSchema, { int64Field: protoInt64.parse(1) }),
        create(ScalarValuesMessageSchema, { boolField: true }),
      ];
      for (const shape of shapes) {
        for (let i = 0; i < L3_WARMUP; i++) {
          toBinaryFast(ScalarValuesMessageSchema, shape, { adaptive: true });
        }
      }
      assert.strictEqual(
        getOrCreateVariants(ScalarValuesMessageSchema).sealed,
        true,
      );

      // Previously-graduated shapes still route to variants (and stay correct).
      for (const shape of shapes.slice(0, 4)) {
        const adaptive = toBinaryFast(ScalarValuesMessageSchema, shape, {
          adaptive: true,
        });
        const reflective = toBinary(ScalarValuesMessageSchema, shape);
        assert.deepStrictEqual(Array.from(adaptive), Array.from(reflective));
      }

      // Novel post-seal shapes go through generic — still correct.
      const novel = create(ScalarValuesMessageSchema, {
        uint32Field: 12345,
        floatField: 2.5,
      });
      const adaptive = toBinaryFast(ScalarValuesMessageSchema, novel, {
        adaptive: true,
      });
      const reflective = toBinary(ScalarValuesMessageSchema, novel);
      assert.deepStrictEqual(Array.from(adaptive), Array.from(reflective));
    });
  });

  void suite("shape drift", () => {
    test("value changes within same shape keep variant stable", () => {
      resetObserver(ScalarValuesMessageSchema);
      // Graduate a shape with two scalars.
      const warm = create(ScalarValuesMessageSchema, {
        doubleField: 1,
        stringField: "one",
      });
      for (let i = 0; i < L3_WARMUP; i++) {
        toBinaryFast(ScalarValuesMessageSchema, warm, { adaptive: true });
      }
      assert.strictEqual(
        getOrCreateVariants(ScalarValuesMessageSchema).variants.size,
        1,
      );

      // Drift: same shape, different values. Expect variant hit + parity.
      const drift = create(ScalarValuesMessageSchema, {
        doubleField: 999,
        stringField: "two",
      });
      const adaptive = toBinaryFast(ScalarValuesMessageSchema, drift, {
        adaptive: true,
      });
      const reflective = toBinary(ScalarValuesMessageSchema, drift);
      assert.deepStrictEqual(Array.from(adaptive), Array.from(reflective));
      // No new graduation — still 1 variant, no counter entries.
      const rec = getOrCreateVariants(ScalarValuesMessageSchema);
      assert.strictEqual(rec.variants.size, 1);
    });
  });

  void suite("oneof parity under L3", () => {
    test("two oneof arms graduate as two variants", () => {
      resetObserver(OneofMessageSchema);
      const foo = create(OneofMessageSchema, {
        scalar: { case: "value", value: 99 },
      });
      const bar = create(OneofMessageSchema, {
        scalar: { case: "error", value: "boom" },
      });
      for (let i = 0; i < L3_WARMUP; i++) {
        toBinaryFast(OneofMessageSchema, foo, { adaptive: true });
        toBinaryFast(OneofMessageSchema, bar, { adaptive: true });
      }
      const rec = getOrCreateVariants(OneofMessageSchema);
      assert.strictEqual(
        rec.variants.size,
        2,
        "expected one variant per oneof arm",
      );
      assert.deepStrictEqual(
        Array.from(toBinaryFast(OneofMessageSchema, foo, { adaptive: true })),
        Array.from(toBinary(OneofMessageSchema, foo)),
      );
      assert.deepStrictEqual(
        Array.from(toBinaryFast(OneofMessageSchema, bar, { adaptive: true })),
        Array.from(toBinary(OneofMessageSchema, bar)),
      );
    });

    test("message oneof arm graduates correctly", () => {
      resetObserver(OneofMessageSchema);
      const msg = create(OneofMessageSchema, {
        message: {
          case: "foo",
          value: create(OneofMessageFooSchema, { name: "alpha" }),
        },
      });
      for (let i = 0; i < L3_WARMUP + 2; i++) {
        toBinaryFast(OneofMessageSchema, msg, { adaptive: true });
      }
      assert.strictEqual(
        getOrCreateVariants(OneofMessageSchema).variants.size,
        1,
      );
      assert.deepStrictEqual(
        Array.from(toBinaryFast(OneofMessageSchema, msg, { adaptive: true })),
        Array.from(toBinary(OneofMessageSchema, msg)),
      );
    });
  });

  void suite("Mode B codegen executor (opt-in)", () => {
    test("new Function() variant produces byte-identical output", () => {
      const flag = Symbol.for("@bufbuild/protobuf.adaptive-codegen");
      const g = globalThis as Record<symbol, unknown>;
      const prev = g[flag];
      g[flag] = true;
      try {
        resetObserver(ScalarValuesMessageSchema);
        const msg = create(ScalarValuesMessageSchema, {
          doubleField: 2.5,
          stringField: "codegen",
          int32Field: -7,
        });
        // Graduate.
        for (let i = 0; i < L3_WARMUP; i++) {
          toBinaryFast(ScalarValuesMessageSchema, msg, { adaptive: true });
        }
        const rec = getOrCreateVariants(ScalarValuesMessageSchema);
        const [variant] = Array.from(rec.variants.values());
        assert.ok(variant);
        assert.strictEqual(
          variant.codegen,
          true,
          "Mode B flag must produce a codegen variant",
        );
        const viaVariant = toBinaryFast(ScalarValuesMessageSchema, msg, {
          adaptive: true,
        });
        const viaReflective = toBinary(ScalarValuesMessageSchema, msg);
        assert.deepStrictEqual(
          Array.from(viaVariant),
          Array.from(viaReflective),
        );
      } finally {
        if (prev === undefined) {
          delete g[flag];
        } else {
          g[flag] = prev;
        }
      }
    });
  });
});
