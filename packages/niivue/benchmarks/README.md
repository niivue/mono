# Benchmarks

Performance harness and bundle-size budget for `@niivue/niivue`.

> **Production builds carry zero perf-instrumentation cost.** The
> `performance.mark`/`measure` hooks in `src/view/NVPerfMarks.ts` are
> gated on a build-time constant `__NIIVUE_PERF__`, injected by Vite's
> `define`. The default build (`bun run build`, `bun run dev`,
> `bun run deploy`) sets it to `false`, so esbuild dead-code-eliminates
> every perf-mark body — the calls inline to a bare `return` and tree-shake
> away. Only the dedicated `*:perf` scripts (driven by `NIIVUE_PERF=1`)
> ship with marks armed, and they exist solely for running this harness.

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

The renderer's `performance.mark`/`measure` instrumentation is gated on a
build-time flag (`__NIIVUE_PERF__`, injected by Vite's `define`). Standard
builds set it to `false` so esbuild dead-code-eliminates the bodies of
`markCpuStart` / `markSubmitStart` / `markEnd` — production renders pay
nothing. Run the dedicated **perf** scripts when benchmarking:

```bash
bun run dev:perf
# auto-opens http://localhost:5173/examples/benchmark.html with marks armed
```

Toggle the checkboxes for **Renderer / Compute / Sweeps / Tract**, hit **Run**, and use **Download JSON** / **Copy Markdown** to save results.

If you load the bench against a non-perf build, the page banner says so and
CPU-vs-submit splits / phase stats will be empty (`setPerfMarksEnabled(true)`
no-ops in non-perf bundles). For a static perf build of the examples site
(e.g. for sharing a hosted copy):

```bash
bun run build:examples:perf
```

For library consumers who want to ship perf-instrumented bundles:

```bash
bun run build:perf
```

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
