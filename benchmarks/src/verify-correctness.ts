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

// Correctness check for the experimental `toBinaryFast` encoder.
//
// We don't claim byte-identical output against `toBinary` — repeated
// scalar ordering and presence-zero handling could legitimately differ
// on future descriptors. The load-bearing claim is *semantic* round-trip
// equivalence: decoding either encoding produces structurally-equal
// messages. This file exercises that on the OTel-shaped fixture used by
// the benchmarks.

import assert from "node:assert/strict";
import { toBinary, toBinaryFast, fromBinary } from "@bufbuild/protobuf";
import { ExportTraceRequestSchema } from "./gen/nested_pb.js";
import { SimpleMessageSchema } from "./gen/small_pb.js";
import { buildExportTraceRequest, buildSmallMessage } from "./fixtures.js";

function summarize(label: string, slow: Uint8Array, fast: Uint8Array): void {
  const byteMatch =
    slow.length === fast.length && slow.every((b, i) => b === fast[i]);
  console.log(
    `[${label}] slow=${slow.length}B fast=${fast.length}B bytesIdentical=${byteMatch}`,
  );
}

// OTel-shaped ExportTraceRequest with 100 spans.
{
  const msg = buildExportTraceRequest();
  const slow = toBinary(ExportTraceRequestSchema, msg);
  const fast = toBinaryFast(ExportTraceRequestSchema, msg);

  // Decode both — require structural equality of the resulting messages.
  const decodedSlow = fromBinary(ExportTraceRequestSchema, slow);
  const decodedFast = fromBinary(ExportTraceRequestSchema, fast);
  assert.deepStrictEqual(
    decodedFast,
    decodedSlow,
    "toBinaryFast produced a payload that decodes differently than toBinary",
  );
  summarize("ExportTraceRequest", slow, fast);
}

// SimpleMessage (scalars only): ensures the flat-scalar path works.
{
  const msg = buildSmallMessage();
  const slow = toBinary(SimpleMessageSchema, msg);
  const fast = toBinaryFast(SimpleMessageSchema, msg);
  const decodedSlow = fromBinary(SimpleMessageSchema, slow);
  const decodedFast = fromBinary(SimpleMessageSchema, fast);
  assert.deepStrictEqual(decodedFast, decodedSlow);
  summarize("SimpleMessage", slow, fast);
}

console.log("\nOK — semantic round-trip verified for all fixtures");
