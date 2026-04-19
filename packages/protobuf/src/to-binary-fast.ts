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
 * L1 plan-driven fast encoder.
 *
 * `toBinaryFast` replaces the earlier closure-based prototype (H3) with a
 * compiled `SchemaPlan` interpreter. Each schema is compiled once and cached
 * in a `WeakMap`; subsequent encodes walk a flat Int32Array opcode stream and
 * inline every writer call so V8 keeps monomorphic receivers on the hot path.
 *
 * Unsupported features (proto2 groups, delimited-encoded messages inside
 * lists, or messages carrying unknown fields with `writeUnknownFields: true`)
 * transparently fall back to the reflective `toBinary`. Output bytes are
 * therefore identical to the reflective encoder for every input.
 */

import type { DescMessage } from "./descriptors.js";
import type { MessageShape } from "./types.js";
import { toBinary, type BinaryWriteOptions } from "./to-binary.js";
import { BinaryWriter } from "./wire/binary-encoding.js";
import { compileSchemaPlan, executeSchemaPlan } from "./wire/schema-plan.js";

/**
 * Serialize a message to its binary protobuf representation using the compiled
 * schema-plan path. Byte-for-byte equivalent to `toBinary` — on any input that
 * the fast path cannot handle, the call transparently delegates to `toBinary`.
 */
export function toBinaryFast<Desc extends DescMessage>(
  schema: Desc,
  message: MessageShape<Desc>,
  options?: Partial<BinaryWriteOptions>,
): Uint8Array<ArrayBuffer> {
  const plan = compileSchemaPlan(schema);
  if (plan === null) {
    return toBinary(schema, message, options);
  }
  // Unknown fields (wire-format passthrough) are retained by default. When any
  // are present we fall back to the reflective encoder so the emitted bytes
  // include them in the exact order expected by the legacy writer.
  const writeUnknown = options?.writeUnknownFields ?? true;
  if (writeUnknown) {
    const unknown = (message as { $unknown?: unknown[] }).$unknown;
    if (unknown !== undefined && unknown.length > 0) {
      return toBinary(schema, message, options);
    }
  }
  const writer = new BinaryWriter();
  executeSchemaPlan(
    plan,
    message as unknown as Record<string, unknown>,
    writer,
  );
  return writer.finish();
}
