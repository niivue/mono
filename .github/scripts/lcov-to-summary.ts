#!/usr/bin/env bun
// Parse an lcov.info file and emit a markdown coverage summary.
// Writes to $GITHUB_STEP_SUMMARY when set; otherwise prints to stdout.
//
// Usage: bun .github/scripts/lcov-to-summary.ts <lcov-path> [--title "Section title"]

import { appendFileSync } from "node:fs";
import { relative } from "node:path";

type Record = {
  file: string;
  linesFound: number;
  linesHit: number;
  fnFound: number;
  fnHit: number;
  brFound: number;
  brHit: number;
};

type Totals = Omit<Record, "file">;

const args = Bun.argv.slice(2);
const lcovPath = args.find((a) => !a.startsWith("--"));
const titleIdx = args.indexOf("--title");
const title = titleIdx >= 0 ? (args[titleIdx + 1] ?? "Coverage") : "Coverage";

if (!lcovPath) {
  Bun.stderr.write("usage: lcov-to-summary.ts <lcov-path> [--title <title>]\n");
  process.exit(2);
}

const lcovFile = Bun.file(lcovPath);
if (!(await lcovFile.exists())) {
  Bun.stderr.write(`lcov-to-summary: cannot read ${lcovPath}\n`);
  process.exit(0);
}
const lcov = await lcovFile.text();

const records: Record[] = [];
let current: Record | null = null;
for (const rawLine of lcov.split("\n")) {
  const line = rawLine.trim();
  if (!line) continue;
  if (line.startsWith("SF:")) {
    current = {
      file: line.slice(3),
      linesFound: 0,
      linesHit: 0,
      fnFound: 0,
      fnHit: 0,
      brFound: 0,
      brHit: 0,
    };
    continue;
  }
  if (!current) continue;
  if (line === "end_of_record") {
    records.push(current);
    current = null;
    continue;
  }
  const colon = line.indexOf(":");
  if (colon < 0) continue;
  const key = line.slice(0, colon);
  const value = Number(line.slice(colon + 1));
  if (Number.isNaN(value)) continue;
  switch (key) {
    case "LF": current.linesFound = value; break;
    case "LH": current.linesHit = value; break;
    case "FNF": current.fnFound = value; break;
    case "FNH": current.fnHit = value; break;
    case "BRF": current.brFound = value; break;
    case "BRH": current.brHit = value; break;
  }
}

if (records.length === 0) {
  Bun.stderr.write(`lcov-to-summary: no records parsed from ${lcovPath}\n`);
  process.exit(0);
}

const totals: Totals = records.reduce<Totals>(
  (acc, r) => {
    acc.linesFound += r.linesFound;
    acc.linesHit += r.linesHit;
    acc.fnFound += r.fnFound;
    acc.fnHit += r.fnHit;
    acc.brFound += r.brFound;
    acc.brHit += r.brHit;
    return acc;
  },
  { linesFound: 0, linesHit: 0, fnFound: 0, fnHit: 0, brFound: 0, brHit: 0 },
);

const pct = (hit: number, found: number): number | null =>
  found === 0 ? null : (hit / found) * 100;
const fmtPct = (v: number | null): string => (v === null ? "-" : `${v.toFixed(2)}%`);

const linesPct = pct(totals.linesHit, totals.linesFound);
const fnPct = pct(totals.fnHit, totals.fnFound);
const brPct = pct(totals.brHit, totals.brFound);

const rootRel = relative(process.cwd(), lcovPath) || lcovPath;

const lines: string[] = [];
lines.push(`## ${title}`);
lines.push("");
lines.push(`Source: \`${rootRel}\` - ${records.length} files`);
lines.push("");
lines.push("| Metric | Covered | Total | Percent |");
lines.push("| --- | ---: | ---: | ---: |");
lines.push(`| Lines | ${totals.linesHit} | ${totals.linesFound} | ${fmtPct(linesPct)} |`);
lines.push(`| Functions | ${totals.fnHit} | ${totals.fnFound} | ${fmtPct(fnPct)} |`);
if (totals.brFound > 0) {
  lines.push(`| Branches | ${totals.brHit} | ${totals.brFound} | ${fmtPct(brPct)} |`);
}
lines.push("");

const perFile = records
  .map((r) => ({ ...r, pct: pct(r.linesHit, r.linesFound) }))
  .sort((a, b) => {
    if (a.pct === null && b.pct === null) return a.file.localeCompare(b.file);
    if (a.pct === null) return 1;
    if (b.pct === null) return -1;
    return a.pct - b.pct;
  });

lines.push("<details><summary>Per-file coverage (worst to best)</summary>");
lines.push("");
lines.push("| File | Lines | Functions | Branches | Line % |");
lines.push("| --- | ---: | ---: | ---: | ---: |");
for (const r of perFile) {
  const linePct = pct(r.linesHit, r.linesFound);
  const fns = `${r.fnHit}/${r.fnFound}`;
  const brs = r.brFound === 0 ? "-" : `${r.brHit}/${r.brFound}`;
  lines.push(
    `| \`${r.file}\` | ${r.linesHit}/${r.linesFound} | ${fns} | ${brs} | ${fmtPct(linePct)} |`,
  );
}
lines.push("");
lines.push("</details>");
lines.push("");

const output = `${lines.join("\n")}\n`;

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
  appendFileSync(summaryPath, output);
} else {
  await Bun.write(Bun.stdout, output);
}
