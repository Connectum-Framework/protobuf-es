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

// compare-results.ts — diff two bench-matrix JSON dumps and emit a
// Markdown regression table. Input is the structured payload written by
// src/bench-matrix.ts (the last `=== Matrix JSON ===` block when run
// standalone; run-matrix-ci.sh strips everything except the JSON object
// so this script can fs.readFileSync() it directly).
//
// Thresholds are configurable on the CLI so CI can tune leniency without
// touching this file. Defaults match the Phase 2 contract: 5% throughput,
// 10% memory.

import { readFileSync, writeFileSync } from "node:fs";
import { argv, exit } from "node:process";

interface ResultRow {
  name: string;
  opsPerSec: number;
  rme: number;
  samples: number;
  /**
   * Optional — bench-matrix currently does not emit per-op memory. The
   * field is wired here so a follow-up fixture addition is a one-line
   * change in the runner, not a script rewrite.
   */
  bytesPerOp?: number;
}

interface BenchPayload {
  node: string;
  platform: string;
  timestamp: string;
  results: ResultRow[];
}

interface Options {
  baseline: string | null;
  current: string;
  output: string;
  thresholdOps: number;
  thresholdMem: number;
  noBaseline: boolean;
}

function parseArgs(): Options {
  const opts: Options = {
    baseline: null,
    current: "bench-results.json",
    output: "bench-report.md",
    thresholdOps: 5,
    thresholdMem: 10,
    noBaseline: false,
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--baseline=")) opts.baseline = arg.slice(11);
    else if (arg.startsWith("--current=")) opts.current = arg.slice(10);
    else if (arg.startsWith("--output=")) opts.output = arg.slice(9);
    else if (arg.startsWith("--threshold-ops="))
      opts.thresholdOps = Number(arg.slice(16));
    else if (arg.startsWith("--threshold-mem="))
      opts.thresholdMem = Number(arg.slice(16));
    else if (arg === "--no-baseline") opts.noBaseline = true;
    else if (arg === "--help" || arg === "-h") {
      printUsage();
      exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      printUsage();
      exit(2);
    }
  }
  return opts;
}

function printUsage(): void {
  console.error(`Usage: compare-results.ts [options]
  --baseline=PATH        Path to baseline JSON (omit for --no-baseline)
  --current=PATH         Path to current run JSON (default bench-results.json)
  --output=PATH          Markdown report path (default bench-report.md)
  --threshold-ops=N      Throughput regression threshold, % (default 5)
  --threshold-mem=N      Memory regression threshold, % (default 10)
  --no-baseline          Emit current-only report (first run on a fork)`);
}

function loadPayload(path: string): BenchPayload {
  const raw = readFileSync(path, "utf8").trim();
  // run-matrix-ci.sh produces a pure JSON file. When a developer points
  // the script at a raw bench-matrix stdout dump, tolerate the "=== Matrix
  // JSON ===" sentinel by locating the last top-level '{' in the text.
  if (raw.startsWith("{")) {
    return JSON.parse(raw) as BenchPayload;
  }
  const jsonStart = raw.lastIndexOf("\n{");
  if (jsonStart === -1) {
    throw new Error(`compare-results: no JSON payload found in ${path}`);
  }
  return JSON.parse(raw.slice(jsonStart + 1)) as BenchPayload;
}

function fmtOps(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "–";
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return n.toFixed(1);
}

function fmtBytes(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "–";
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function fmtDelta(pct: number): string {
  if (!Number.isFinite(pct)) return "–";
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

interface CompareRow {
  name: string;
  baselineOps: number | null;
  currentOps: number;
  opsDeltaPct: number | null;
  baselineMem: number | null;
  currentMem: number | null;
  memDeltaPct: number | null;
  status: "ok" | "improved" | "regression" | "new";
}

// Flat thresholds (ops %, memory %). Variance on CI runners is now
// controlled upstream in run-matrix-ci.sh via `taskset -c 0` CPU pinning
// + median-of-5 runs; see analysis/benchmark-variance-root-cause.md for
// the measurement that showed 76% -> 7% spread after pinning. Keeping
// thresholds flat lets real algorithmic regressions (>5% ops, >10% mem)
// surface without bucket-dependent policy the reviewer has to interpret.
function compare(
  baseline: BenchPayload | null,
  current: BenchPayload,
  thresholdOps: number,
  thresholdMem: number,
): CompareRow[] {
  const baseMap = new Map<string, ResultRow>();
  if (baseline) {
    for (const r of baseline.results) baseMap.set(r.name, r);
  }

  const rows: CompareRow[] = [];
  for (const cur of current.results) {
    const base = baseMap.get(cur.name);
    let opsDelta: number | null = null;
    let memDelta: number | null = null;
    if (base && base.opsPerSec > 0) {
      opsDelta = ((cur.opsPerSec - base.opsPerSec) / base.opsPerSec) * 100;
    }
    if (
      base?.bytesPerOp !== undefined &&
      cur.bytesPerOp !== undefined &&
      base.bytesPerOp > 0
    ) {
      memDelta = ((cur.bytesPerOp - base.bytesPerOp) / base.bytesPerOp) * 100;
    }

    let status: CompareRow["status"] = "ok";
    if (!base) {
      status = "new";
    } else if (opsDelta !== null && opsDelta <= -thresholdOps) {
      status = "regression";
    } else if (memDelta !== null && memDelta >= thresholdMem) {
      status = "regression";
    } else if (opsDelta !== null && opsDelta >= thresholdOps) {
      status = "improved";
    }

    rows.push({
      name: cur.name,
      baselineOps: base?.opsPerSec ?? null,
      currentOps: cur.opsPerSec,
      opsDeltaPct: opsDelta,
      baselineMem: base?.bytesPerOp ?? null,
      currentMem: cur.bytesPerOp ?? null,
      memDeltaPct: memDelta,
      status,
    });
  }
  return rows;
}

function statusBadge(s: CompareRow["status"]): string {
  switch (s) {
    case "regression":
      return "REGRESSION";
    case "improved":
      return "improved";
    case "new":
      return "new";
    case "ok":
      return "ok";
  }
}

function renderMarkdown(
  rows: CompareRow[],
  opts: {
    baseline: BenchPayload | null;
    current: BenchPayload;
    thresholdOps: number;
    thresholdMem: number;
  },
): string {
  const regressionCount = rows.filter((r) => r.status === "regression").length;
  const improvedCount = rows.filter((r) => r.status === "improved").length;
  const newCount = rows.filter((r) => r.status === "new").length;
  const unchangedCount =
    rows.length - regressionCount - improvedCount - newCount;

  const summaryTitle =
    regressionCount > 0
      ? `Benchmark: ${regressionCount} regression(s)`
      : "Benchmark: no regressions";

  const out: string[] = [];
  out.push(`## ${summaryTitle}`);
  out.push("");
  out.push(
    `Thresholds: throughput regression \`>${opts.thresholdOps}%\`, memory regression \`>${opts.thresholdMem}%\`. ` +
      `Runner pinned to CPU 0 via taskset; baseline and current are benchmarked on the same runner within one workflow invocation. ` +
      `Current run on \`${opts.current.platform}\`, Node \`${opts.current.node}\`, captured \`${opts.current.timestamp}\`.`,
  );
  if (opts.baseline) {
    out.push(
      `Baseline captured \`${opts.baseline.timestamp}\` on \`${opts.baseline.platform}\`, Node \`${opts.baseline.node}\`.`,
    );
  } else {
    out.push("No baseline available — this report is informational only.");
  }
  out.push("");
  out.push(
    `Summary: \`${regressionCount}\` regressed, \`${improvedCount}\` improved, \`${newCount}\` new, \`${unchangedCount}\` unchanged.`,
  );
  out.push("");
  out.push(
    "| Fixture | Baseline ops/s | PR ops/s | Δ ops | Baseline B/op | PR B/op | Δ mem | Status |",
  );
  out.push(
    "|---------|---------------:|---------:|------:|--------------:|--------:|------:|:-------|",
  );
  for (const r of rows) {
    out.push(
      `| ${r.name} | ${r.baselineOps === null ? "–" : fmtOps(r.baselineOps)} | ${fmtOps(r.currentOps)} | ${r.opsDeltaPct === null ? "–" : fmtDelta(r.opsDeltaPct)} | ${fmtBytes(r.baselineMem ?? undefined)} | ${fmtBytes(r.currentMem ?? undefined)} | ${r.memDeltaPct === null ? "–" : fmtDelta(r.memDeltaPct)} | ${statusBadge(r.status)} |`,
    );
  }
  out.push("");
  out.push(
    "_Produced by `benchmarks/scripts/compare-results.ts`. Artifacts: `bench-results-<pr>` (current), `bench-baseline-main` (baseline)._",
  );
  out.push("");
  return out.join("\n");
}

function main(): void {
  const opts = parseArgs();
  const current = loadPayload(opts.current);
  const baseline =
    opts.noBaseline || !opts.baseline ? null : loadPayload(opts.baseline);
  const rows = compare(baseline, current, opts.thresholdOps, opts.thresholdMem);
  const md = renderMarkdown(rows, {
    baseline,
    current,
    thresholdOps: opts.thresholdOps,
    thresholdMem: opts.thresholdMem,
  });
  writeFileSync(opts.output, md, "utf8");
  // Print to stdout for local/dev runs so developers don't have to open
  // the file to see the result.
  console.log(md);
  const hasRegression = rows.some((r) => r.status === "regression");
  // Exit 0 even on regression — the workflow surfaces the flag via the
  // PR comment + a ::warning:: annotation. Hard-failing the job would
  // block legitimate PRs that intentionally trade throughput for another
  // gain (e.g. bundle size). Tech-lead can promote to hard-fail later.
  if (hasRegression) {
    console.error("compare-results: REGRESSION flagged (non-fatal).");
  }
}

main();
