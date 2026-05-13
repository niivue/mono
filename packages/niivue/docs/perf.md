# Performance benchmarking

NiiVue ships a built-in benchmark suite that measures both backends
(WebGPU and WebGL2) across a fixed set of rendering and compute
scenarios. It's used three ways:

| Use case | Entry point | Browser mode |
| --- | --- | --- |
| Exploratory / one-off measurement | `bun run dev:perf` (open in your browser) | Real GPU |
| HTML report comparing both backends | `bun run bench:report` | Headed Chromium, real GPU |
| CI / local regression gate vs `main` | `bun run bench:compare` | Headless Chromium, SwiftShader |

All three share the same scenarios, the same instrumentation, and the
same `niivue-benchmark-v1` JSON schema.

> Perf instrumentation is gated on a runtime flag in
> `src/view/NVPerfMarks.ts` — every helper bails on its first line when
> the flag is off, so the cost in default builds is one well-predicted
> branch per call site. The bench harness flips it on with
> `setPerfMarksEnabled(true)` while measuring; the controller API
> exposes it as `nv.perf.enabled = true`, which additionally emits a
> `perfFrame` event after every render. The flag is off by default.

## Quickstart

```bash
# Live, interactive — open the page and click around
bun run dev:perf

# Generate a self-contained HTML report comparing WebGPU + WebGL2
bun run bench:report                 # writes ./perf-report.html
bun run bench:report /tmp/perf.html  # custom path

# Gate the current branch against main (refuses to run on main)
bun run bench:compare
```

## What gets measured

For every renderer scenario the harness records:

| Phase | How measured | Where |
| --- | --- | --- |
| `cpu` | JS work before issuing GPU commands | `niivue:render-cpu` perf mark |
| `submit` | JS work issuing GPU commands | `niivue:render-submit` perf mark |
| `frame` | `cpu + submit` (whole JS render call) | `niivue:render-frame` perf mark |
| `wall` | End-to-end time around the render call | `performance.now()` in the bench loop |
| `gpu` | Per-frame device time | `EXT_disjoint_timer_query_webgl2` (WebGL2 only) |

`wall` differs by backend because the two backends synchronise with the
GPU differently:

- **WebGPU**: the bench awaits `device.queue.onSubmittedWorkDone()` per
  frame, so `wall` includes GPU execution. GPU time can be approximated
  as `wall − frame`.
- **WebGL2**: there is no cheap analogous fence — Chromium's
  `clientWaitSync` has a ~10 ms IPC floor that swamps real numbers — so
  the bench does not pace, and `wall ≈ frame`. Real GPU time comes from
  `EXT_disjoint_timer_query_webgl2` when the driver exposes it.

For compute scenarios there is only one phase, recorded in `stats`.

## Running the report

```bash
bun run bench:report
```

The report script always launches **headed Chromium** with the real GPU,
because headless rendering numbers (even with `--headless=new`) do not
reflect what users see — the compositor and vsync paths are different,
and many platforms expose SwiftShader instead of the host GPU. Expect a
visible browser window to flash up while the bench runs.

Environment overrides:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BENCH_BACKENDS` | `webgpu webgl2` | Space-separated subset to run |
| `BENCH_FRAMES` | `200` | Frames per renderer scenario |
| `BENCH_COMPUTE_ITER` | `100` | Iterations per compute scenario |
| `BENCH_PORT` | `4173` | Vite preview port |

Output is a single self-contained HTML file. No external CSS or JS.

## Interpreting the report

The report has four sections (in order):

### 1. Environment

Side-by-side run metadata: backend resolved, paced flag, WebGPU adapter
description, WebGL renderer string (via
`WEBGL_debug_renderer_info`), timestamp, source file, and canvas size
(CSS px × DPR). A prominent amber banner appears if a SwiftShader
driver was detected — that means the run is software-rasterised and
absolute numbers are not representative.

The bench pins canvas CSS size to 1024×576 when `autorun=1`, so two
runs of `bench:report` on the same machine compare against the same
fragment count regardless of window size. Override per-run with
`canvasW` / `canvasH` URL params.

### 2. fps head-to-head

The practical view. For each scenario:

| Column | Meaning |
| --- | --- |
| `WebGPU fps`, `WebGPU frame (ms)` | `1000 / max(frame, GPU)` and `max(frame, GPU)` |
| `WebGL2 fps`, `WebGL2 frame (ms)` | `1000 / max(frame, GPU)` and `max(frame, GPU)` |
| `Winner` | Whichever backend has the lower frame time |
| `Speedup` | `slower frame time / faster frame time` |

Effective frame time is `max(frame, GPU)` on both backends — CPU submit
and GPU execution overlap on real hardware, so steady-state frame rate
is governed by whichever side is slower. For WebGPU the GPU side is
estimated as `wall − frame` (paced via `onSubmittedWorkDone`); for
WebGL2 it comes from `EXT_disjoint_timer_query_webgl2`. If GPU time is
unavailable for a row (e.g. WebGL2 with no timer-query extension), the
row shows `—` rather than a misleadingly high CPU-only number.

### 3. Per-backend tables

Backend-specific column layouts (the columns mean different things on
each backend, so they're not shared):

**WebGPU** — `Scenario` | `Frames` | `Wall (paced)` | `CPU` | `Submit` | `Frame` | `GPU est. (wall−frame)` | `Effective` | `~fps` | `p95` | `Stddev`

**WebGL2** — `Scenario` | `Frames` | `Frame (CPU+submit)` | `GPU (timer)` | `Effective` | `~fps` | `p95` | `Stddev`

The WebGL2 table doesn't break out `CPU` and `Submit` columns because
in WebGL2 there's no meaningful boundary between them — `markSubmitStart`
and `markEnd` fire adjacently with no work in between, so the split is
always ~0 and would just be noise.

If `GPU (timer)` is blank on every WebGL2 row, the host driver doesn't
expose `EXT_disjoint_timer_query_webgl2` (commonly SwiftShader in
headless mode; rare on real desktop GPUs). The `Effective` and `~fps`
columns intentionally stay blank in that case.

### 4. Apples-to-apples comparison

Pairs both backends on the two measurements that are directly
comparable across them:

- **CPU (frame, ms)** — the `niivue:render-frame` perf mark. Pure JS
  work issuing GPU commands. Same instrumentation, same units, on both
  backends.
- **GPU (ms)** — `wall − frame` for WebGPU, `EXT_disjoint_timer_query`
  for WebGL2. Different measurement techniques, but both are real
  device time.

Each pair has a `Ratio` column = `slower / faster`.

## Running the regression gate

```bash
bun run bench:compare
```

This is for the local "did I break perf?" workflow. It:

1. Builds the perf-flavored examples site on the current working tree.
2. Builds the same site on `main` in a temporary git worktree.
3. Runs the headless bench against both, for each backend in
   `$BENCH_BACKENDS`.
4. Diffs the JSON with `bench/compare-bench.ts`, exiting non-zero if
   any backend regressed past the configured threshold.

Headless SwiftShader is used **on purpose** here — it's deterministic
and free of GPU-driver variance, which is what a regression gate needs.
PR-vs-main on identical SwiftShader still surfaces real regressions
because the comparison is relative.

If `main` predates the perf-harness infrastructure (no `bench/`
directory), `compare-to-main.sh` writes a sentinel JSON and
`compare-bench.ts` falls back to head-only reporting instead of failing
the gate.

Tunables for the regression gate (pass after `--`):

```bash
bun run bench:compare -- --warn-pct=10 --fail-pct=20 --noise-ms=0.5
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--warn-pct=N` | 10 | Warn if regression exceeds N% |
| `--fail-pct=N` | 20 | Exit non-zero if regression exceeds N% |
| `--noise-ms=N` | 0.5 | Ignore deltas smaller than N ms |

## When to trust which numbers

| Question | Use |
| --- | --- |
| What fps will users see on this scene? | `bench:report` (headed, real GPU) |
| Did this PR regress perf? | `bench:compare` (headless, deterministic) |
| Why is this scenario slow? | `dev:perf` interactively, plus the per-backend table |
| Is WebGPU faster than WebGL2 here? | The fps head-to-head, on the host GPU |

## Adding a new scenario

Scenarios live in `examples/benchmark.js`. The renderer scenarios are
defined in `rendererScenarios()` and the compute ones in
`computeScenarios()`. Each scenario is `{ name, setup, run }` — the
setup loads volumes/meshes and configures the view, then `run` is called
once per measurement loop iteration.

When you add a scenario:

- Pick a short, stable `name` — it becomes the row key in the JSON and
  the report.
- Keep the setup deterministic. Random data, JIT-friendly cold paths,
  and network fetches all add variance the regression gate has to fight.
- Verify the new scenario appears in both the headed report
  (`bench:report`) and the headless compare (`bench:compare`).
