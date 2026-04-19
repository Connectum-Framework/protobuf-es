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

// Report helpers: markdown table generator, SVG chart builder, and README
// marker-based injector. Pattern lifted from packages/bundle-size/src/util.ts
// so two reports in this repo share a look-and-feel, but the inputs differ:
// bundle-size plots bytes vs file count as line series; we plot ops/sec as
// grouped bar charts keyed on fixture, with one bar per encoder variant.
//
// SVG is produced as a raw string, no external charting dependency. We
// stay at a fixed viewBox and compute x/y positions per bar so the output
// is stable under re-runs (barring genuine benchmark variance).

import { readFileSync, writeFileSync } from "node:fs";

/**
 * Single benchmark measurement. One row per (fixture × encoder) pair.
 * `opsPerSec` is the median throughput reported by tinybench; `bytesPerOp`
 * is the encoded size divided by one (we do not currently measure heap per
 * op in this report — see bench-memory.ts for that).
 */
export interface BenchmarkResult {
  fixture: string;
  encoder: string;
  opsPerSec: number;
  bytesPerOp?: number;
  encodedSize: number;
}

/**
 * Encoders we plot. Order matters — it drives the legend and bar ordering
 * within a fixture group. Kept small and fixed so the chart is legible;
 * when a new encoder is added, extend this array and the colors map.
 */
export const ENCODERS = ["toBinary", "toBinaryFast", "protobufjs"] as const;
export type Encoder = (typeof ENCODERS)[number];

export const ENCODER_COLORS: Record<Encoder, string> = {
  toBinary: "#8b8b8b",
  toBinaryFast: "#ffa600",
  protobufjs: "#347fc4",
};

// --- Markdown table --------------------------------------------------------

/**
 * Format an ops/sec number the way the tinybench tables in README.md do:
 * three significant digits for the common ~100..10M range, thousand
 * separators on the integer part. "-" for missing (encoder not applicable
 * to this fixture).
 */
function formatOps(ops: number | undefined): string {
  if (ops === undefined || ops === 0 || !Number.isFinite(ops)) return "-";
  if (ops >= 1_000_000) return `${(ops / 1_000_000).toFixed(2)}M`;
  if (ops >= 10_000)
    return new Intl.NumberFormat("en-US").format(Math.round(ops));
  if (ops >= 1000)
    return new Intl.NumberFormat("en-US").format(Math.round(ops));
  return Math.round(ops).toString();
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || bytes === 0) return "-";
  return new Intl.NumberFormat("en-US").format(bytes);
}

/**
 * Best-ratio column summary. For each fixture we pick the fastest encoder
 * and report "<encoder> <ratio>x vs <slowest>". Useful at-a-glance
 * signal: if toBinary is the winner on every row, the fast path isn't
 * helping; if protobufjs always wins, we still have ground to cover.
 */
function bestEncoderRatio(row: Record<Encoder, BenchmarkResult | undefined>) {
  const entries = ENCODERS.map((enc) => [enc, row[enc]?.opsPerSec ?? 0] as const)
    .filter(([, ops]) => ops > 0)
    .sort((a, b) => b[1] - a[1]);
  if (entries.length < 2) return "-";
  const [winner, winnerOps] = entries[0];
  const [, runnerUpOps] = entries[1];
  const ratio = winnerOps / runnerUpOps;
  return `${winner} (${ratio.toFixed(2)}x)`;
}

/**
 * Group the flat result list by fixture, pick one row per encoder. Fixtures
 * keep the order they were first encountered — the matrix preserves a
 * meaningful layout (simple → complex → synthetic) that we do not want to
 * re-sort alphabetically.
 */
function groupByFixture(
  results: BenchmarkResult[],
): Array<{
  fixture: string;
  encodedSize: number;
  perEncoder: Record<Encoder, BenchmarkResult | undefined>;
}> {
  const order: string[] = [];
  const groups = new Map<
    string,
    {
      fixture: string;
      encodedSize: number;
      perEncoder: Record<Encoder, BenchmarkResult | undefined>;
    }
  >();
  for (const r of results) {
    let g = groups.get(r.fixture);
    if (!g) {
      g = {
        fixture: r.fixture,
        encodedSize: r.encodedSize,
        perEncoder: {
          toBinary: undefined,
          toBinaryFast: undefined,
          protobufjs: undefined,
        },
      };
      groups.set(r.fixture, g);
      order.push(r.fixture);
    }
    if ((ENCODERS as readonly string[]).includes(r.encoder)) {
      g.perEncoder[r.encoder as Encoder] = r;
    }
    // Keep the largest observed encoded size — encoders produce wire-
    // identical bytes for the same input, but if a future variant ever
    // diverges this prevents an accidental zero.
    if (r.encodedSize > g.encodedSize) g.encodedSize = r.encodedSize;
  }
  return order.flatMap((n) => {
    const group = groups.get(n);
    return group ? [group] : [];
  });
}

/**
 * Generate a markdown table with one row per fixture and one column per
 * encoder (ops/sec). Extra columns: encoded bytes and the best-encoder
 * ratio. Emitted between the README markers by `injectTable`.
 */
export function generateBenchmarkMarkdownTable(
  results: BenchmarkResult[],
): string {
  const groups = groupByFixture(results);
  const header = [
    "Fixture",
    "Bytes",
    "toBinary",
    "toBinaryFast",
    "protobufjs",
    "Best",
  ];
  const rows: string[][] = groups.map((g) => [
    g.fixture,
    formatBytes(g.encodedSize),
    formatOps(g.perEncoder.toBinary?.opsPerSec),
    formatOps(g.perEncoder.toBinaryFast?.opsPerSec),
    formatOps(g.perEncoder.protobufjs?.opsPerSec),
    bestEncoderRatio(g.perEncoder),
  ]);

  const colWidths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );

  // Alignment: fixture left, everything else right — ops/sec and bytes
  // read better right-aligned because they are variable-width numbers.
  const align = ["left", "right", "right", "right", "right", "left"] as const;

  const pad = (s: string, w: number, a: (typeof align)[number]) =>
    a === "left" ? s.padEnd(w) : s.padStart(w);

  const sep = (w: number, a: (typeof align)[number]) => {
    if (a === "left") return "-".repeat(w);
    return `${"-".repeat(w - 1)}:`;
  };

  const lines: string[] = [];
  lines.push(
    `| ${header.map((h, i) => pad(h, colWidths[i], align[i])).join(" | ")} |`,
  );
  lines.push(
    `| ${colWidths.map((w, i) => sep(w, align[i])).join(" | ")} |`,
  );
  for (const r of rows) {
    lines.push(
      `| ${r.map((c, i) => pad(c, colWidths[i], align[i])).join(" | ")} |`,
    );
  }
  return `\n${lines.join("\n")}\n\n`;
}

// --- README injector -------------------------------------------------------

const TABLE_START = "<!--BENCHMARK_TABLE_START-->\n";
const TABLE_END = "<!--BENCHMARK_TABLE_END-->";

/**
 * Replace the content between the `<!--BENCHMARK_TABLE_START-->` and
 * `<!--BENCHMARK_TABLE_END-->` markers with the provided table. If the
 * markers are missing the function inserts a new section right after the
 * top-level title so the first run of `bench:report` on a freshly
 * authored README still works.
 */
export function injectTable(filePath: string, table: string): void {
  const fileContent = readFileSync(filePath, "utf-8");
  const iStart = fileContent.indexOf(TABLE_START);
  const iEnd = fileContent.indexOf(TABLE_END);
  if (iStart < 0 || iEnd < 0) {
    // Markers missing — append a new section so the README remains the
    // canonical home for the table without a manual editing step.
    const section = `\n## Report output\n\n${TABLE_START}${table}${TABLE_END}\n`;
    writeFileSync(filePath, fileContent + section);
    return;
  }
  const head = fileContent.substring(0, iStart + TABLE_START.length);
  const foot = fileContent.substring(iEnd);
  const newContent = head + table + foot;
  if (newContent !== fileContent) {
    writeFileSync(filePath, newContent);
  }
}

// --- SVG chart -------------------------------------------------------------

/**
 * Log-base-10 of an ops/sec value, clamped at 0 so a missing / zero
 * measurement does not blow up the axis or produce a negative bar. The
 * report spans ~100..2M ops/sec across fixtures, so a log scale is the
 * only way to keep SimpleMessage and ExportTraceRequest readable on the
 * same chart.
 */
function log10Ops(ops: number): number {
  if (!Number.isFinite(ops) || ops <= 1) return 0;
  return Math.log10(ops);
}

/**
 * Escape characters that would break out of a <text> node or attribute
 * value. Fixtures can contain `&` via future naming — keep this resilient.
 */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Render a grouped bar chart to SVG as a plain string. Each fixture is a
 * group on the X axis; each encoder is a colored bar within the group. The
 * Y axis is log(ops/sec). Dimensions are generous enough to fit long
 * fixture names rotated 35 degrees without overlapping adjacent groups.
 */
export function generateBenchmarkChart(results: BenchmarkResult[]): string {
  const groups = groupByFixture(results);
  const n = groups.length;

  // Layout constants. `barWidth` is per-encoder; `groupWidth` is all
  // three encoders plus a gap before the next fixture group. Changing
  // any of these propagates downstream — they are the only magic numbers
  // in this function.
  const barWidth = 20;
  const groupGap = 18;
  const groupWidth = ENCODERS.length * barWidth + groupGap;
  const marginLeft = 90;
  const marginRight = 20;
  const marginTop = 60;
  const marginBottom = 150;
  const chartHeight = 320;
  const chartWidth = n * groupWidth;
  const totalWidth = marginLeft + chartWidth + marginRight;
  const totalHeight = marginTop + chartHeight + marginBottom;

  // Y axis: pick the smallest decade below the fastest encoder across all
  // fixtures so the tallest bar reaches ~95% of the chart area. log10
  // grid lines every decade.
  const maxOps = Math.max(
    1,
    ...results.map((r) => (Number.isFinite(r.opsPerSec) ? r.opsPerSec : 0)),
  );
  const yMaxLog = Math.ceil(log10Ops(maxOps));
  const yMinLog = 1; // 10 ops/sec floor — anything slower is not in scope.
  const yRange = yMaxLog - yMinLog;

  const yToPixel = (opsLog: number) => {
    const clamped = Math.max(yMinLog, Math.min(yMaxLog, opsLog));
    return (
      marginTop + chartHeight - ((clamped - yMinLog) / yRange) * chartHeight
    );
  };

  const parts: string[] = [];
  parts.push(
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" ` +
      `width="${totalWidth}" height="${totalHeight}" ` +
      `viewBox="0 0 ${totalWidth} ${totalHeight}" class="chart">\n` +
      `  <style>\n` +
      `    <![CDATA[\n` +
      `      text { font: 12px Verdana, Helvetica, Arial, sans-serif; }\n` +
      `      .title { font-size: 16px; font-weight: bold; }\n` +
      `      .axis { stroke: #333; stroke-width: 1; }\n` +
      `      .grid { stroke: #ebebeb; stroke-width: 1; }\n` +
      `    ]]>\n` +
      `  </style>\n`,
  );

  // Title + Y axis label (rotated so it runs vertically along the axis).
  parts.push(
    `  <text x="${totalWidth / 2}" y="26" text-anchor="middle" class="title">` +
      `Encoder throughput by fixture (ops/sec, log scale)` +
      `</text>\n`,
  );
  parts.push(
    `  <g transform="translate(22, ${marginTop + chartHeight / 2}) rotate(-90)">\n` +
      `    <text text-anchor="middle">ops/sec (log10)</text>\n` +
      `  </g>\n`,
  );

  // Y axis line + decade grid lines + labels.
  parts.push(
    `  <line class="axis" x1="${marginLeft}" y1="${marginTop}" x2="${marginLeft}" y2="${marginTop + chartHeight}" />\n`,
  );
  for (let tick = yMinLog; tick <= yMaxLog; tick++) {
    const y = yToPixel(tick);
    const value = 10 ** tick;
    const label =
      value >= 1_000_000
        ? `${value / 1_000_000}M`
        : value >= 1000
          ? `${value / 1000}K`
          : `${value}`;
    parts.push(
      `  <line class="grid" x1="${marginLeft}" x2="${marginLeft + chartWidth}" y1="${y}" y2="${y}" />\n` +
        `  <text x="${marginLeft - 6}" y="${y + 4}" text-anchor="end">${label}</text>\n`,
    );
  }

  // X axis line.
  parts.push(
    `  <line class="axis" x1="${marginLeft}" y1="${marginTop + chartHeight}" x2="${marginLeft + chartWidth}" y2="${marginTop + chartHeight}" />\n`,
  );

  // Bars + fixture labels (rotated 35 degrees to keep long names legible).
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const groupX = marginLeft + i * groupWidth + groupGap / 2;
    for (let j = 0; j < ENCODERS.length; j++) {
      const enc = ENCODERS[j];
      const r = g.perEncoder[enc];
      if (!r || !Number.isFinite(r.opsPerSec) || r.opsPerSec <= 0) continue;
      const barX = groupX + j * barWidth;
      const barTop = yToPixel(log10Ops(r.opsPerSec));
      const barH = marginTop + chartHeight - barTop;
      const color = ENCODER_COLORS[enc];
      parts.push(
        `  <rect x="${barX}" y="${barTop}" width="${barWidth - 2}" height="${barH}" fill="${color}">\n` +
          `    <title>${escapeXml(enc)}: ${Math.round(r.opsPerSec).toLocaleString("en-US")} ops/sec (${g.fixture})</title>\n` +
          `  </rect>\n`,
      );
    }
    // Fixture label rotated to avoid clipping against neighbours.
    const labelX = groupX + (ENCODERS.length * barWidth) / 2;
    const labelY = marginTop + chartHeight + 12;
    parts.push(
      `  <g transform="translate(${labelX}, ${labelY}) rotate(35)">\n` +
        `    <text text-anchor="start">${escapeXml(g.fixture)}</text>\n` +
        `  </g>\n`,
    );
  }

  // Legend: a row of (swatch, label) pairs placed horizontally near the
  // top of the chart area. Kept on one line — three encoders fit.
  const legendY = marginTop - 24;
  let legendX = marginLeft;
  parts.push(`  <g transform="translate(0, ${legendY})">\n`);
  for (const enc of ENCODERS) {
    const color = ENCODER_COLORS[enc];
    parts.push(
      `    <rect x="${legendX}" y="0" width="14" height="10" fill="${color}" />\n` +
        `    <text x="${legendX + 18}" y="9">${enc}</text>\n`,
    );
    legendX += 18 + enc.length * 7 + 16;
  }
  parts.push(`  </g>\n`);

  parts.push(`</svg>\n`);
  return parts.join("");
}
