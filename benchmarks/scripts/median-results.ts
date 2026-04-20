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

// median-results.ts — combine N bench-matrix JSON dumps into a single
// payload whose ops/sec per fixture is the median across runs.
//
// Why
// ---
// Local 5-run measurements on main showed 2x host-level spread on fast
// fixtures (SimpleMessage, GraphQLRequest) even with tinybench's own RME
// under 0.2%. A single-run comparison therefore produces false-positive
// "regressions" whose magnitude is entirely noise. Median-of-N is the
// standard, cheap mitigation: one outlier cannot move the reported number.
//
// Usage
// -----
//   node scripts/median-results.ts runs/run-1.json runs/run-2.json ... > baseline.json
//
// Behaviour
// ---------
// - With a single input file, passes the payload through unchanged — this
//   keeps the script safe to use as a no-op step in CI pipelines that
//   occasionally reduce to one run (e.g. local development).
// - With N >= 2 inputs, groups rows by `name`, takes the numeric median of
//   `opsPerSec` per fixture, and attaches the `rme` / `samples` fields
//   from the run whose ops/sec is closest to that median — so downstream
//   consumers still see a representative (not synthetic) confidence
//   interval.
// - Fixtures missing from some runs are included if they appear in >= 1
//   input; the median is computed across whatever subset is present and a
//   warning is emitted to stderr so drift is visible.
// - Output JSON structure matches bench-matrix.ts's payload exactly.

import { readFileSync } from "node:fs";
import { argv, exit, stderr, stdout } from "node:process";

interface ResultRow {
  name: string;
  opsPerSec: number;
  rme?: number;
  samples?: number;
  bytesPerOp?: number;
  encodedSize?: number;
}

interface BenchPayload {
  node: string;
  platform: string;
  timestamp: string;
  results: ResultRow[];
}

function loadPayload(path: string): BenchPayload {
  const raw = readFileSync(path, "utf8").trim();
  if (raw.startsWith("{")) {
    return JSON.parse(raw) as BenchPayload;
  }
  // Tolerate raw bench-matrix stdout (with table output before the JSON
  // payload) — same forgiveness rule as compare-results.ts.
  const jsonStart = raw.lastIndexOf("\n{");
  if (jsonStart === -1) {
    throw new Error(`median-results: no JSON payload found in ${path}`);
  }
  return JSON.parse(raw.slice(jsonStart + 1)) as BenchPayload;
}

/**
 * Numeric median. For even N we return the lower of the two middle values
 * instead of interpolating — this keeps the output row anchored to an
 * actually-observed run (so the attached rme/samples remain meaningful).
 */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function main(): void {
  const paths = argv.slice(2).filter((a) => !a.startsWith("-"));
  if (paths.length === 0) {
    stderr.write(
      "Usage: median-results.ts <run-1.json> [<run-2.json> ...] > out.json\n",
    );
    exit(2);
  }

  const payloads = paths.map(loadPayload);

  // Single-run fallback: nothing to median, just pass through.
  if (payloads.length === 1) {
    stdout.write(`${JSON.stringify(payloads[0], null, 2)}\n`);
    return;
  }

  // Collect rows by fixture name across all runs.
  const byName = new Map<string, ResultRow[]>();
  for (const payload of payloads) {
    for (const row of payload.results) {
      const rows = byName.get(row.name) ?? [];
      rows.push(row);
      byName.set(row.name, rows);
    }
  }

  const merged: ResultRow[] = [];
  for (const [name, rows] of byName) {
    if (rows.length < payloads.length) {
      stderr.write(
        `median-results: fixture "${name}" present in ${rows.length}/${payloads.length} runs; median computed across subset.\n`,
      );
    }
    const opsValues = rows.map((r) => r.opsPerSec);
    const medianOps = median(opsValues);
    // Pick the row closest to median so rme/samples/bytesPerOp/encodedSize
    // reflect an actually-observed run, not a synthesized one.
    let closest = rows[0];
    let bestDistance = Math.abs(rows[0].opsPerSec - medianOps);
    for (const r of rows) {
      const d = Math.abs(r.opsPerSec - medianOps);
      if (d < bestDistance) {
        closest = r;
        bestDistance = d;
      }
    }
    merged.push({
      name,
      opsPerSec: medianOps,
      rme: closest.rme,
      samples: closest.samples,
      bytesPerOp: closest.bytesPerOp,
      encodedSize: closest.encodedSize,
    });
  }

  // Envelope metadata: keep node/platform from the first run (they must
  // match across runs to be comparable; divergence means the operator
  // did something wrong) and use the latest timestamp.
  const first = payloads[0];
  const timestamp = payloads
    .map((p) => p.timestamp)
    .sort()
    .at(-1) as string;

  const out: BenchPayload = {
    node: first.node,
    platform: first.platform,
    timestamp,
    results: merged,
  };

  stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

main();
