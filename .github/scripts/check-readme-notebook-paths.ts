#!/usr/bin/env bun
// Verify every notebook path mentioned in a README actually exists.
//
// README files drift when notebooks are renamed, removed, or added
// without a doc update. This script scans for `packages/.../*.ipynb`
// references and fails if any of them is missing on disk.
//
// Usage:
//   bun .github/scripts/check-readme-notebook-paths.ts [README ...]
//
// Default scope is `packages/ipyniivue/README.md`.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "..");
const args = Bun.argv.slice(2);
const readmes = args.length > 0 ? args : ["packages/ipyniivue/README.md"];

const NOTEBOOK_RE = /packages\/[\w./-]+\.ipynb/g;

let missing = 0;
let scanned = 0;

for (const rel of readmes) {
  const abs = resolve(root, rel);
  if (!existsSync(abs)) {
    console.error(`README not found: ${rel}`);
    process.exit(1);
  }
  const txt = readFileSync(abs, "utf-8");
  const refs = new Set(txt.match(NOTEBOOK_RE) ?? []);
  for (const ref of refs) {
    scanned++;
    if (!existsSync(resolve(root, ref))) {
      console.error(`  ${rel}: missing notebook ${ref}`);
      missing++;
    }
  }
}

if (missing > 0) {
  console.error(`Notebook path check failed: ${missing} missing reference(s).`);
  process.exit(1);
}

console.log(`OK: ${scanned} notebook references resolved`);
