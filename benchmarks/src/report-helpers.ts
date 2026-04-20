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
 *
 * `upstream` is `@bufbuild/protobuf@latest` published on npm, installed
 * under an alias so both the fork's in-tree `toBinary` (which already
 * includes the L0 contiguous-writer optimisation from PR #8) and the
 * unmodified upstream implementation live side-by-side. It is the honest
 * baseline against which cumulative fork improvements should be measured.
 */
export const ENCODERS = [
  "upstream",
  "toBinary",
  "toBinaryFast",
  "protobufjs",
] as const;
export type Encoder = (typeof ENCODERS)[number];

export const ENCODER_COLORS: Record<Encoder, string> = {
  upstream: "#e55137",
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

/**
 * Compact ops/sec formatter for bar-top labels. The markdown table above
 * has room for thousand-separated digits ("2,501"); the chart does not —
 * three bars per fixture group leave ~60 px for a label and a long number
 * either clips the neighbour or crosses the grid line. This variant is
 * deliberately lossy so the label fits inside the per-bar column even at
 * the narrowest groupings we render (SimpleMessage, Rpc*).
 */
function formatOpsCompact(ops: number): string {
  if (!Number.isFinite(ops) || ops <= 0) return "";
  if (ops >= 1_000_000) return `${(ops / 1_000_000).toFixed(2)}M`;
  if (ops >= 100_000) return `${Math.round(ops / 1000)}K`;
  if (ops >= 10_000) return `${(ops / 1000).toFixed(1)}K`;
  if (ops >= 1000) return `${(ops / 1000).toFixed(2)}K`;
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
  const entries = ENCODERS.map(
    (enc) => [enc, row[enc]?.opsPerSec ?? 0] as const,
  )
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
function groupByFixture(results: BenchmarkResult[]): Array<{
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
          upstream: undefined,
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
    "upstream",
    "toBinary",
    "toBinaryFast",
    "protobufjs",
    "Best",
  ];
  const rows: string[][] = groups.map((g) => [
    g.fixture,
    formatBytes(g.encodedSize),
    formatOps(g.perEncoder.upstream?.opsPerSec),
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
  const align = [
    "left",
    "right",
    "right",
    "right",
    "right",
    "right",
    "left",
  ] as const;

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
  lines.push(`| ${colWidths.map((w, i) => sep(w, align[i])).join(" | ")} |`);
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
  // encoders plus a gap before the next fixture group. Changing any of
  // these propagates downstream — they are the only magic numbers in
  // this function. Bar width scales down slightly with encoder count so
  // the overall chart width stays readable when we go from 3 to 4 bars.
  const barWidth = ENCODERS.length >= 4 ? 18 : 20;
  const groupGap = 20;
  const groupWidth = ENCODERS.length * barWidth + groupGap;
  const marginLeft = 90;
  const marginRight = 20;
  // marginTop accounts for: title (y=26), legend row (legendY = marginTop -
  // 24), and the rotated value labels we draw above each bar — those can
  // extend ~35 px up-and-right depending on label length, so keep the top
  // margin generous enough to prevent clipping on the tallest bars.
  const marginTop = 85;
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
      // Value label above the bar. Rotated -60 degrees so it reads upward
      // and does not overlap the neighbouring encoder's bar at narrow
      // groupings (3 bars × 20 px per fixture). Anchored at `start` so
      // the text extends up-and-right from the bar-top pivot — visually
      // that places the label over the bar it describes rather than
      // drifting into the next group.
      const labelText = formatOpsCompact(r.opsPerSec);
      if (labelText) {
        const labelPivotX = barX + (barWidth - 2) / 2;
        const labelPivotY = barTop - 3;
        parts.push(
          `  <g transform="translate(${labelPivotX}, ${labelPivotY}) rotate(-60)">\n` +
            `    <text text-anchor="start" font-size="10" fill="#333">${escapeXml(labelText)}</text>\n` +
            `  </g>\n`,
        );
      }
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

// --- SVG delta chart -------------------------------------------------------

/**
 * Per-fixture speed improvement of `toBinaryFast` over the three baselines
 * we track:
 *
 *   1. `upstream` — the unmodified `@bufbuild/protobuf@latest` published on
 *      npm. This is the honest "how much faster than the original
 *      protobuf-es?" number. It includes every L0/L1/L2 optimisation we
 *      landed, stacked.
 *   2. `toBinary` — the fork's current reflective encoder, which already
 *      ships the L0 contiguous-writer optimisation from PR #8. Comparing
 *      against it shows the *incremental* gain of toBinaryFast on top of
 *      L0. Useful when reasoning about whether the codegen-based fast
 *      path is still worth the complexity on top of what a minimal
 *      contiguous writer already delivers.
 *   3. `protobufjs` — cross-library reference where the static-module
 *      codegen is available.
 *
 * The main chart is log-scale, so a 5x improvement looks almost identical
 * to a 1.5x improvement — this chart restores the linear comparison.
 *
 * Bars render the ratio minus one, i.e. "toBinaryFast is N% faster than
 * baseline". Negative values (fast encoder slower than baseline) cross the
 * axis. We cap bar length at a floor of 300% so small gains on tiny
 * fixtures (e.g. SimpleMessage) still render visibly when some other
 * fixture is 500%+; the numeric label stays honest regardless of cap.
 */
export function generateBenchmarkDeltaChart(
  results: BenchmarkResult[],
): string {
  const groups = groupByFixture(results);

  // Three delta series per fixture. We plot only fixtures that have at
  // least a toBinaryFast measurement — that is the common subject of every
  // bar. Missing individual baselines (e.g. protobufjs has no stub for
  // this fixture) leave that series' sub-bar empty, without shrinking the
  // chart or hiding the full row.
  interface DeltaRow {
    fixture: string;
    vsUpstreamPct?: number;
    vsToBinaryPct?: number;
    vsProtobufjsPct?: number;
  }
  const rows: DeltaRow[] = [];
  for (const g of groups) {
    const fast = g.perEncoder.toBinaryFast?.opsPerSec;
    if (!fast || fast <= 0) continue;
    const upstream = g.perEncoder.upstream?.opsPerSec;
    const slow = g.perEncoder.toBinary?.opsPerSec;
    const pbjs = g.perEncoder.protobufjs?.opsPerSec;
    rows.push({
      fixture: g.fixture,
      vsUpstreamPct:
        upstream && upstream > 0 ? (fast / upstream - 1) * 100 : undefined,
      vsToBinaryPct: slow && slow > 0 ? (fast / slow - 1) * 100 : undefined,
      vsProtobufjsPct: pbjs && pbjs > 0 ? (fast / pbjs - 1) * 100 : undefined,
    });
  }

  // Layout. Horizontal bars work better than vertical here because fixture
  // names are long and % values are short — the chart reads like a table
  // with the ratio encoded as bar length. One row per fixture, three
  // stacked sub-bars per row (upstream top, toBinary middle, protobufjs
  // bottom) so the reader can see all three baselines side-by-side.
  const subBars = 3;
  const barHeight = 11;
  const barGap = 2;
  const rowPadding = 6;
  const rowHeight = subBars * barHeight + (subBars - 1) * barGap + rowPadding;
  const marginLeft = 260; // room for fixture names
  const marginRight = 90; // room for value labels on long bars
  const marginTop = 90;
  const marginBottom = 50;
  const chartHeight = rows.length * rowHeight;
  const chartWidth = 560;
  const totalWidth = marginLeft + chartWidth + marginRight;
  const totalHeight = marginTop + chartHeight + marginBottom;

  // Cap bar length at the largest positive delta, with a floor of 300%
  // so small-fixture gains (e.g. 30% on SimpleMessage) don't render as
  // a pixel-wide sliver just because one outlier fixture is 500%+.
  const allPcts = rows.flatMap((r) => [
    r.vsUpstreamPct ?? 0,
    r.vsToBinaryPct ?? 0,
    r.vsProtobufjsPct ?? 0,
  ]);
  const maxPct = Math.max(300, ...allPcts);
  // Include the most negative delta so bars can grow leftward across the
  // zero baseline without clipping. If everything is positive we keep the
  // zero-line flush with the left edge.
  const minPct = Math.min(0, ...allPcts);
  const pctRange = maxPct - minPct;
  // Zero-line X. If minPct < 0 we reserve a slice of the chart width for
  // negative-bar growth; otherwise the zero-line sits at marginLeft.
  const zeroX = marginLeft + (chartWidth * -minPct) / pctRange;

  const pctToWidth = (pct: number) => (Math.abs(pct) / pctRange) * chartWidth;

  // Colors. Re-use the encoder palette so the legend cross-references the
  // main chart cleanly: each baseline's bar uses the baseline's color —
  // the bars describe the baseline, not toBinaryFast itself, which is the
  // common subject of all three.
  const colorVsUpstream = ENCODER_COLORS.upstream;
  const colorVsToBinary = ENCODER_COLORS.toBinary;
  const colorVsProtobufjs = ENCODER_COLORS.protobufjs;

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
      `      .zero { stroke: #333; stroke-width: 1.5; }\n` +
      `    ]]>\n` +
      `  </style>\n`,
  );

  // Title.
  parts.push(
    `  <text x="${totalWidth / 2}" y="28" text-anchor="middle" class="title">` +
      `toBinaryFast speedup vs baselines (linear %)` +
      `</text>\n`,
  );
  parts.push(
    `  <text x="${totalWidth / 2}" y="46" text-anchor="middle" font-size="11" fill="#666">` +
      `higher is better — "+300%" means 4x throughput; ` +
      `"vs upstream" is the honest cumulative gain over @bufbuild/protobuf@latest` +
      `</text>\n`,
  );

  // Legend row (above the chart body).
  const legendY = marginTop - 22;
  parts.push(
    `  <g transform="translate(${marginLeft}, ${legendY})">\n` +
      `    <rect x="0" y="0" width="14" height="10" fill="${colorVsUpstream}" />\n` +
      `    <text x="18" y="9">vs upstream</text>\n` +
      `    <rect x="150" y="0" width="14" height="10" fill="${colorVsToBinary}" />\n` +
      `    <text x="168" y="9">vs toBinary (fork, L0)</text>\n` +
      `    <rect x="330" y="0" width="14" height="10" fill="${colorVsProtobufjs}" />\n` +
      `    <text x="348" y="9">vs protobufjs</text>\n` +
      `  </g>\n`,
  );

  // Vertical grid lines every 100%. Draw dashed lines over the full
  // chartHeight so rows read like a tufte-minimal bar chart — no heavy
  // axis clutter, just the zero line and the percentage scale.
  for (let pct = Math.ceil(minPct / 100) * 100; pct <= maxPct; pct += 100) {
    const x = marginLeft + ((pct - minPct) / pctRange) * chartWidth;
    parts.push(
      `  <line class="grid" x1="${x}" x2="${x}" y1="${marginTop}" y2="${marginTop + chartHeight}" />\n` +
        `  <text x="${x}" y="${marginTop - 3}" text-anchor="middle" font-size="10" fill="#777">${pct}%</text>\n`,
    );
  }

  // Zero baseline (bold).
  parts.push(
    `  <line class="zero" x1="${zeroX}" x2="${zeroX}" y1="${marginTop}" y2="${marginTop + chartHeight}" />\n`,
  );

  // Per-row helper: draw one baseline sub-bar at the given vertical slot.
  const drawSubBar = (
    rowY: number,
    slot: number,
    pct: number,
    color: string,
    baselineName: string,
    fixture: string,
  ) => {
    const w = pctToWidth(pct);
    const y = rowY + rowPadding / 2 + slot * (barHeight + barGap);
    const x = pct >= 0 ? zeroX : zeroX - w;
    parts.push(
      `  <rect x="${x}" y="${y}" width="${w}" height="${barHeight}" fill="${color}">\n` +
        `    <title>${escapeXml(fixture)}: toBinaryFast vs ${baselineName} = ${pct.toFixed(1)}%</title>\n` +
        `  </rect>\n`,
    );
    const labelX = pct >= 0 ? x + w + 4 : x - 4;
    const labelAnchor = pct >= 0 ? "start" : "end";
    parts.push(
      `  <text x="${labelX}" y="${y + barHeight - 2}" text-anchor="${labelAnchor}" font-size="10" fill="#333">${pct.toFixed(0)}%</text>\n`,
    );
  };

  // One row per fixture. Each row renders up to three stacked sub-bars so
  // the three baselines read vertically within a single fixture block.
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowY = marginTop + i * rowHeight;
    // Fixture label on the left, vertically centered in the row.
    parts.push(
      `  <text x="${marginLeft - 8}" y="${rowY + rowHeight / 2 + 4}" text-anchor="end">${escapeXml(row.fixture)}</text>\n`,
    );
    if (row.vsUpstreamPct !== undefined) {
      drawSubBar(
        rowY,
        0,
        row.vsUpstreamPct,
        colorVsUpstream,
        "upstream",
        row.fixture,
      );
    }
    if (row.vsToBinaryPct !== undefined) {
      drawSubBar(
        rowY,
        1,
        row.vsToBinaryPct,
        colorVsToBinary,
        "toBinary (fork, L0)",
        row.fixture,
      );
    }
    if (row.vsProtobufjsPct !== undefined) {
      drawSubBar(
        rowY,
        2,
        row.vsProtobufjsPct,
        colorVsProtobufjs,
        "protobufjs",
        row.fixture,
      );
    }
  }

  parts.push(`</svg>\n`);
  return parts.join("");
}
