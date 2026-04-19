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

// Heap profile analyzer.
//
// Parses a `.heapprofile` produced by `node --heap-prof` and aggregates
// `selfSize` samples by (function, file, line). Writes a markdown table
// of the top-N allocation sites to stdout. The analyzer runs headlessly
// so CI jobs can publish the attribution without a DevTools UI.
//
// Usage:
//   tsx scripts/analyze-heap-prof.ts <path-to-.heapprofile> [--top=20] [--filter=<regex>]
//
// `--filter` accepts a regex matched against `url|functionName`; defaults
// to a filter that excludes Node.js internals so the output is scoped to
// the encode call stack that interests us. Pass `--filter=.*` to
// include everything (useful when debugging the filter itself).
//
// `--focus-encoder` is a stronger filter that keeps only sites under the
// protobuf encoder source trees (to-binary, to-binary-fast, binary-encoding).
// Use this flag when the unfiltered output is dominated by one-time
// schema registration / codegen cost and you want the per-call picture.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

// --- CLI -------------------------------------------------------------------

function parseArg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const rawProfilePath = positional[0];
const topN = Number(parseArg("top", "20"));
const focusEncoder = process.argv.includes("--focus-encoder");
// Default filter: drop Node.js built-in internals (node:internal/*, node:fs, etc.)
// and V8 API frames. Those dominate by sample count in short runs but don't
// tell us anything about the encoder's own behavior.
const defaultFilter = focusEncoder
  ? "to-binary|binary-encoding|text-encoding|varint|size-delimited"
  : "^(?!node:internal|node:fs|\\(V8 API\\)|\\(root\\)).*";
const filterRegex = new RegExp(parseArg("filter", defaultFilter));

if (!rawProfilePath) {
  console.error(
    "usage: tsx scripts/analyze-heap-prof.ts <path-to-.heapprofile> [--top=20] [--filter=<regex>]",
  );
  console.error(
    "  path may be a directory; in that case the newest .heapprofile inside is analyzed.",
  );
  process.exit(2);
}

// Accept either a .heapprofile file directly or a directory — in the
// directory case we pick the most recently modified .heapprofile. `node
// --heap-prof-dir` writes files with timestamp-based names, so "newest"
// is always "the one from this run".
function resolveProfileFile(input: string): string {
  const p = resolve(input);
  const s = statSync(p);
  if (s.isFile()) return p;
  if (s.isDirectory()) {
    const entries = readdirSync(p)
      .filter((n) => n.endsWith(".heapprofile"))
      .map((n) => ({ name: n, mtime: statSync(resolve(p, n)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (entries.length === 0) {
      throw new Error(`no .heapprofile files found in ${p}`);
    }
    return resolve(p, entries[0].name);
  }
  throw new Error(`not a file or directory: ${p}`);
}

const profilePath = resolveProfileFile(rawProfilePath);

// --- Profile types ---------------------------------------------------------
//
// Matches the V8 sampling heap profile format (Chrome DevTools Protocol
// `HeapProfiler.SamplingHeapProfile`). We care about `selfSize` — bytes
// allocated at the leaf call frame at sample time — and the call frame
// identity (function + script URL + line). `children` recurse deeper
// into the stack.

interface CallFrame {
  functionName: string;
  scriptId: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

interface SampleNode {
  callFrame: CallFrame;
  selfSize: number;
  id: number;
  children: SampleNode[];
}

interface HeapProfile {
  head: SampleNode;
}

// --- Aggregation -----------------------------------------------------------

interface SiteTotal {
  key: string;
  functionName: string;
  url: string;
  lineNumber: number;
  selfBytes: number;
  samples: number;
}

// Walk the sample tree and accumulate (functionName, url, line) → bytes.
// `samples` is the number of call-frame occurrences contributing to that
// site, a useful secondary signal when the selfBytes are close together.
function aggregate(root: SampleNode): Map<string, SiteTotal> {
  const byKey = new Map<string, SiteTotal>();
  const stack: SampleNode[] = [root];
  for (;;) {
    const n = stack.pop();
    if (!n) break;
    // Only record leaf samples — any node with non-zero selfSize counts,
    // including intermediate nodes (V8 attributes samples to whichever
    // frame was on top when the allocation happened).
    if (n.selfSize > 0) {
      const fn = n.callFrame.functionName || "(anonymous)";
      const url = n.callFrame.url || "(native)";
      const line = n.callFrame.lineNumber;
      const key = `${fn}|${url}|${line}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.selfBytes += n.selfSize;
        existing.samples += 1;
      } else {
        byKey.set(key, {
          key,
          functionName: fn,
          url,
          lineNumber: line,
          selfBytes: n.selfSize,
          samples: 1,
        });
      }
    }
    for (const c of n.children) stack.push(c);
  }
  return byKey;
}

// Apply user-supplied filter against `url|functionName` so frames in
// Node internals / V8 API don't crowd out the interesting encoder
// frames. The default regex excludes internals; pass `--filter=.*` to
// see everything.
function filterSites(sites: SiteTotal[]): SiteTotal[] {
  return sites.filter((s) => filterRegex.test(`${s.url}|${s.functionName}`));
}

// --- Rendering -------------------------------------------------------------

function shortenUrl(url: string): string {
  if (!url || url === "(native)") return url;
  // `file://` URLs are fine to trim to the last two path segments so the
  // table stays readable. For bare `node:` URLs we keep them as-is.
  if (url.startsWith("node:")) return url;
  const withoutScheme = url.replace(/^file:\/\//, "");
  const parts = withoutScheme.split("/");
  if (parts.length > 2) return `…/${parts.slice(-2).join("/")}`;
  return withoutScheme;
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

function renderTable(sites: SiteTotal[], totalBytes: number): string {
  const header = [
    "| Rank | Site | Bytes | % total | Samples |",
    "| ---: | ---- | ----: | ------: | ------: |",
  ];
  const rows = sites.map((s, i) => {
    const loc = `${s.functionName} @ ${shortenUrl(s.url)}${
      s.lineNumber >= 0 ? `:${s.lineNumber + 1}` : ""
    }`;
    const pct = totalBytes === 0 ? 0 : (s.selfBytes / totalBytes) * 100;
    return `| ${i + 1} | ${loc.replace(/\|/g, "\\|")} | ${formatBytes(
      s.selfBytes,
    )} | ${pct.toFixed(1)}% | ${s.samples} |`;
  });
  return [...header, ...rows].join("\n");
}

// --- Main ------------------------------------------------------------------

// Group per-site totals by source file so the high-level picture
// ("where is most of the memory going, module-wise?") is one grep away.
// This is complementary to the per-site table: the table tells you
// where to start optimizing, the per-file summary tells you whether
// your optimization shifted the distribution.
interface FileTotal {
  url: string;
  selfBytes: number;
  samples: number;
  sites: number;
}

function aggregateByFile(sites: SiteTotal[]): FileTotal[] {
  const byUrl = new Map<string, FileTotal>();
  for (const s of sites) {
    const existing = byUrl.get(s.url);
    if (existing) {
      existing.selfBytes += s.selfBytes;
      existing.samples += s.samples;
      existing.sites += 1;
    } else {
      byUrl.set(s.url, {
        url: s.url,
        selfBytes: s.selfBytes,
        samples: s.samples,
        sites: 1,
      });
    }
  }
  return Array.from(byUrl.values()).sort((a, b) => b.selfBytes - a.selfBytes);
}

function renderFileTable(files: FileTotal[], totalBytes: number): string {
  const header = [
    "| Rank | File | Bytes | % total | Sites | Samples |",
    "| ---: | ---- | ----: | ------: | ----: | ------: |",
  ];
  const rows = files.map((f, i) => {
    const pct = totalBytes === 0 ? 0 : (f.selfBytes / totalBytes) * 100;
    return `| ${i + 1} | ${shortenUrl(f.url).replace(/\|/g, "\\|")} | ${formatBytes(
      f.selfBytes,
    )} | ${pct.toFixed(1)}% | ${f.sites} | ${f.samples} |`;
  });
  return [...header, ...rows].join("\n");
}

function main() {
  const raw = readFileSync(profilePath, "utf8");
  const profile = JSON.parse(raw) as HeapProfile;

  const byKey = aggregate(profile.head);
  const allSites = Array.from(byKey.values());
  const totalBytes = allSites.reduce((acc, s) => acc + s.selfBytes, 0);
  const filtered = filterSites(allSites).sort(
    (a, b) => b.selfBytes - a.selfBytes,
  );
  const top = filtered.slice(0, topN);
  const filteredTotal = filtered.reduce((acc, s) => acc + s.selfBytes, 0);

  console.log(`# Heap profile analysis\n\nProfile: ${basename(profilePath)}  `);
  console.log(
    `Dir: ${dirname(profilePath)}  \nTotal sampled bytes: ${formatBytes(
      totalBytes,
    )}  \nAfter filter (${filterRegex.source}): ${formatBytes(
      filteredTotal,
    )} (${filtered.length} sites)\n`,
  );
  console.log(`## Top ${top.length} allocation sites (by self bytes)\n`);
  console.log(renderTable(top, filteredTotal));

  const fileTotals = aggregateByFile(filtered);
  console.log("\n## Allocation totals by source file\n");
  console.log(renderFileTable(fileTotals.slice(0, 15), filteredTotal));
}

main();
