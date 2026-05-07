# Benchmarks

Performance harness and bundle-size budget for `@niivue/niivue`.

> The `performance.mark`/`measure` hooks in `src/view/NVPerfMarks.ts`
> are gated on a single runtime flag (`setPerfMarksEnabled`, also
> exposed as `nv.perf.enabled` on the controller). When the flag is
> off, every helper bails on its first line — cost in production is
> one well-predicted branch per call site. The benchmark harness flips
> the flag while a scenario is recording.

## Layout

| Path | What |
|------|------|
| `../examples/benchmark.html` | In-browser harness page |
| `../examples/benchmark.js` | Renderer / compute / sweep / tract scenarios |
| `diff-runs.mjs` | CLI A/B comparator for two benchmark JSON outputs |
| `runs/*.json` | Captured runs (gitignored by convention; commit only when documenting a regression or fix) |
| `baselines/bundle-sizes-baseline.json` | Bundle-size budget reference for `size:check` |
| `notes/*.md` | Per-investigation writeups |

## Running the in-browser harness

```bash
bun run dev
# open http://localhost:5173/examples/benchmark.html
```

Toggle the checkboxes for **Renderer / Compute / Sweeps / Tract**, hit **Run**, and use **Download JSON** / **Copy Markdown** to save results. The harness arms `setPerfMarksEnabled(true)` while a scenario is recording.

The bundle-sizes section is auto-fetched from `examples/entry-sizes.json`. Generate it after a build:

```bash
bun run build
node scripts/report-entry-sizes.js --json examples/entry-sizes.json
```

## Comparing two runs

```bash
node benchmarks/diff-runs.mjs run-a.json run-b.json > diff.md
```

The script fails fast if `schema` fields differ — runs from different harness versions aren't comparable.

Optional: tag runs by setting `env.label` in the JSON before diffing. The diff uses these labels in the column headers.

## Bundle-size budget

```bash
bun run build
node scripts/check-entry-sizes.js                  # check vs baseline
node scripts/check-entry-sizes.js --update         # refresh baseline
node scripts/check-entry-sizes.js --budget-kb 10   # custom growth budget
```

First run on a fresh checkout: `--update` to seed `baselines/bundle-sizes-baseline.json`.
