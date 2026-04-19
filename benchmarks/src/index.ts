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

// Aggregate runner. Each suite is also runnable standalone — see
// package.json scripts `bench:create`, `bench:toBinary`, etc.

import { runCreateBench } from "./bench-create.js";
import { runToBinaryBench } from "./bench-toBinary.js";
import { runCreateToBinaryBench } from "./bench-create-toBinary.js";
import { runFromJsonPathBench } from "./bench-fromJson-path.js";

async function main() {
  console.log("protobuf-es benchmark suite");
  console.log(
    `Node ${process.version} on ${process.platform}/${process.arch}\n`,
  );

  const create = await runCreateBench();
  console.log("\n=== create() cost ===");
  console.table(create.table());

  const toBin = await runToBinaryBench();
  console.log("\n=== toBinary() cost on pre-built messages ===");
  console.table(toBin.table());

  const combined = await runCreateToBinaryBench();
  console.log("\n=== create() + toBinary() combined workload ===");
  console.table(combined.table());

  const fromJson = await runFromJsonPathBench();
  console.log("\n=== fromJson / fromJsonString + toBinary paths ===");
  console.table(fromJson.table());
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
