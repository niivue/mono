import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const entries = process.argv.slice(2);
const defaultEntries = [
  "niivuegpu.js",
  "niivuegpu.webgpu.js",
  "niivuegpu.webgl2.js",
];
const targets = entries.length > 0 ? entries : defaultEntries;
const distDir = resolve(process.cwd(), "dist");

const importRe = /(?:import|export)\s+(?:[^'"`]*?from\s+)?["'](\.[^"']+)["']/g;

function collectDeps(entryFile) {
  const seen = new Set();

  function walk(filePath) {
    const absPath = resolve(distDir, filePath);
    if (seen.has(absPath)) return;
    seen.add(absPath);

    const code = readFileSync(absPath, "utf8");
    const baseDir = dirname(absPath);

    let match = importRe.exec(code);
    while (match !== null) {
      const rel = match[1];
      const depAbs = resolve(baseDir, rel);
      if (!depAbs.startsWith(distDir)) continue;
      const depRel = depAbs.slice(distDir.length + 1);
      walk(depRel);
      match = importRe.exec(code);
    }
  }

  walk(entryFile);
  return [...seen];
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function report(entry) {
  const files = collectDeps(entry);
  let total = 0;
  const rows = files
    .map((abs) => {
      const size = statSync(abs).size;
      total += size;
      return { file: abs.slice(distDir.length + 1), size };
    })
    .sort((a, b) => b.size - a.size);

  console.log(`\nEntry: ${entry}`);
  console.log(`Total reachable JS: ${formatBytes(total)} (${total} bytes)`);
  console.log(`Chunks: ${rows.length}`);
  for (const row of rows) {
    console.log(`  - ${row.file}: ${formatBytes(row.size)}`);
  }
}

for (const entry of targets) {
  report(entry);
}
