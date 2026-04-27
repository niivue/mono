# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## ipyniivue (state of play)

Jupyter widget for the local `@niivue/niivue` package. Built on
[anywidget](https://anywidget.dev). Most of the API surface is
auto-generated from TypeScript; only a thin hand-written wrapper lives
in [src/ipyniivue/widget.py](src/ipyniivue/widget.py).

Read this before editing — the lifecycle and message-routing details
below were learned from concrete, hard-to-debug failures.

## Current status

Working:

- Widget mounts in JupyterLab.
- Constructor options reach NiiVue, including `backend="webgpu"|"webgl2"`.
- Python-to-JavaScript fire-and-forget commands queue in the browser
  and run in order after the canvas attaches.
- Web assets load with `nv.add_volume_from_url(...)` /
  `nv.add_mesh_from_url(...)`.
- `nv.download_bitmap(...)` queues NiiVue's `saveBitmap` and is the
  smoke-test signal used by automation.
- `await nv.wait_ready()` succeeds (browser-smoke-tested).
- Generated value-returning async methods (e.g. `get_crosshair_pos`)
  and `nv.on(event, ...)` callbacks work via the `_msg_outbox`
  workaround — keep payloads small and event volume low.

Recommended demo path: display, queue loads, queue bitmap. See
[examples/01_hello_volume.ipynb](examples/01_hello_volume.ipynb).

## Layout

```
scripts/codegen.ts           # AST walker + bundler. Produces all generated files.
api.generated.json           # Structured descriptor of the niivue API surface (committed)
src/ipyniivue/__init__.py    # Re-exports NiiVue and NIIVUE_EVENT_NAMES
src/ipyniivue/widget.py      # Hand-written subclass with on/off, helpers, dispatch
src/ipyniivue/_generated.py  # Auto-generated traitlets + command methods + event names
src/ipyniivue/static/
  _widget.template.js        # Auto-generated reviewable JS (PROPS_*, EVENTS, lifecycle)
  widget.js                  # Auto-generated bundled JS (~1.3 MB; includes niivue)
examples/                    # 01_hello_volume.ipynb + ports of niivue demo HTMLs
pixi.toml / pyproject.toml   # Two install paths (pixi env vs plain pip -e .)
```

## Codegen workflow

```bash
bunx nx codegen ipyniivue
```

Reads `packages/niivue/src/NV*.ts` and the niivue `dist/` build,
classifies every public member of `NVControlBase`, and emits:

- [api.generated.json](api.generated.json) — descriptor (review API
  changes here)
- [src/ipyniivue/_generated.py](src/ipyniivue/_generated.py) —
  traitlets + command methods + `NIIVUE_EVENT_NAMES`
- [src/ipyniivue/static/_widget.template.js](src/ipyniivue/static/_widget.template.js) —
  small reviewable JS template (PROPS_RW / PROPS_RO / EVENTS / lifecycle)
- [src/ipyniivue/static/widget.js](src/ipyniivue/static/widget.js) —
  Bun-bundled output that anywidget loads in the browser

Codegen depends on the niivue package being built first (declared in
[project.json](project.json) `dependsOn`).

After Bun.build produces the bundle, codegen rewrites every
`new URL("assets/X", import.meta.url)` reference into a base64 `data:`
URL inlined into `widget.js`. anywidget serves the ESM via a `blob:`
URL that has no hierarchical base, so `new URL(..., import.meta.url)`
would throw at module init. This inlining is what pushes `widget.js`
to ~1.3 MB — fonts, matcaps, and other niivue `dist/assets/*` are
embedded in the bundle.

## Architecture: how messages move

### Python → JS commands

Commands route through a synced `_msg_inbox` traitlet (a list of
`{seq, body}`), not raw `model.send`. Reason: ipywidgets custom
messages are dropped if Python sends them before the browser view
registers its handler. Demos call methods immediately after
`display(nv)`, so this race is the default. JS drains unseen
sequence numbers after `initialize`.

The browser keeps a per-widget command queue. Each command awaits
the canvas mount promise before touching NiiVue, and async NiiVue
methods (e.g. `loadVolumes`) are awaited inside the queue so a
later `saveBitmap` runs only after the load completes.

### JS → Python responses and events

Use the synced `_msg_outbox` Dict traitlet, **not** `model.send`.
In this environment (Python 3.13, JupyterLab 4.4.x, ipywidgets 8.1.x,
anywidget 0.9.x) raw `model.send` from JS succeeds JS-side but
vanishes before reaching Python's `on_msg`. State-update sync via
the trait channel is reliably delivered.

Python's [widget.py](src/ipyniivue/widget.py) observes
`_msg_outbox` and routes the body into `_dispatch_message`, which
handles two kinds:

- `kind: "response"` — resolves a `Future` parked in `_pending` by
  `_request(...)`. Used by codegen-emitted async methods and
  `wait_ready`.
- `kind: "event"` — fans out to callbacks registered via `nv.on(...)`.
  Validated against `NIIVUE_EVENT_NAMES`.

`SKIP_EVENT_FORWARDING` in the JS template silences high-frequency
internal events (`canvasResize`, `viewAttached`, `viewDestroyed`)
that fire tens to hundreds of times per second during mount and
flood the WebSocket. Event payloads are also passed through
`toJsonSafe` with size caps (`TJS_TYPED_MAX = 1024`,
`TJS_ARRAY_MAX = 4096`) — events like `volumeLoaded` carry the full
voxel buffer in their detail, and serializing 50 MB across the comm
disconnects the kernel.

### anywidget lifecycle gotchas

- `initialize(model)` runs once per Python instance. Do model-level
  wiring there (msg handlers, change observers, NiiVue event
  listeners). Doing this in `render` causes per-view re-registration
  and breaks message routing — this is the bug that ate hours.
- `render(model, el)` may run multiple times per model. Keep it to
  DOM work (canvas, `nv.attachToCanvas`).
- The `model` proxy passed to `initialize` and `render` is **not**
  guaranteed to be object-identity equal. Per-widget runtime state
  is keyed by `_anywidget_id` in a module-level `Map`. Keying by the
  proxy itself can leave `render` waiting on a never-initialized
  state object — a blank container with no canvas and no console
  error.
- The Python `__init__` stashes `_outbox_handler` as a strong
  reference on the instance because some traitlets setups have
  flaky observer registration with bound methods.

## Backend selection

```python
NiiVue()                  # NiiVue default: WebGPU with WebGL2 fallback
NiiVue(backend="webgpu")  # request WebGPU
NiiVue(backend="webgl2")  # request WebGL2 (use for headless smoke tests)
```

`backend` is getter-only in NiiVue, so codegen treats it as a
constructor-only option (`CONSTRUCTOR_PROPS` in the JS template)
that is forwarded into `new NiiVue(opts)` rather than synced.

Pin `backend="webgl2"` for browser automation. Headless Chromium
runs WebGL2 through SwiftShader without flags; WebGPU usually needs
flags, a hardware adapter, or platform-specific configuration.

## What does *not* work / things to avoid

- Don't gate volume or mesh loading on `await nv.wait_ready()`. The
  browser command queue already serializes commands behind the
  canvas mount promise. `wait_ready` is fine as a mount confirmation
  for code that genuinely needs it.
- Don't lean on `nv.on(...)` as a control path. Event delivery works
  but is bandwidth-limited; high-frequency events or large payloads
  will make the comm unreliable. Use Python `ipywidgets` controls
  (sliders, dropdowns) that drive Python→JS updates instead — most
  of the example notebooks follow this pattern.
- Don't return large objects from generated value-returning methods.
  Keep responses small and JSON-serializable.
- Don't expect `jupyter execute` (or the `smoke` Nx target via
  `nbconvert --execute`) to validate browser rendering. It runs the
  Python cells but never starts a browser, so `download_bitmap`
  produces no file. Use a Playwright-driven JupyterLab session for
  real bitmap verification (see "Headless bitmap smoke testing"
  below).

## Skipped properties (no Python traitlet)

The codegen walker skips seven `NVControlBase` properties whose TS
types are non-serializable JS handles. Reach them through
auto-generated command methods or hand-written helpers in
[widget.py](src/ipyniivue/widget.py):

| Property | Use these methods |
| --- | --- |
| `volumes` | `add_volume_from_url`, `load_volumes`, `remove_volume`, `remove_all_volumes`, `set_volume` |
| `meshes` | `add_mesh_from_url`, `load_meshes`, `remove_mesh`, `remove_all_meshes`, `set_mesh` |
| `drawingVolume` | `load_drawing`, `create_empty_drawing`, `close_drawing`, `draw_undo` |
| `annotations` | `add_annotation`, `remove_annotation`, `clear_annotations`, `get_annotations_json` |
| `annotationStyle` | individual `annotation_*` reactive props |
| `customLayout` | `set_custom_layout`, `clear_custom_layout` |
| `volumeTransform` | `register_volume_transform`, `apply_volume_transform` |

### Two paths to `saveBitmap`

Both exist intentionally:

- `nv.download_bitmap(filename, quality)` — hand-written in
  [widget.py](src/ipyniivue/widget.py). Fire-and-forget; queues a
  `saveBitmap` command and returns immediately. This is the demo /
  smoke-test path.
- `await nv.save_bitmap(filename, quality)` — codegen-emitted async.
  Goes through `_request` / `_msg_outbox` and resolves with whatever
  NiiVue's `saveBitmap` returns. Use only when you need the return
  value; the response path adds the `_msg_outbox` round-trip.

## Notebook hygiene (read before committing)

### Strip executed outputs from `.ipynb` files

Always remove cell outputs before committing example notebooks.
JupyterLab stores widget views as cell outputs containing
`application/vnd.jupyter.widget-view+json` and a transient
`model_id`. On a later open, JupyterLab tries to restore that
output before the kernel has a matching live model and shows:

```text
Error: widget model not found
```

Setting `saveState` to `false` suppresses `metadata.widgets` but
not normal cell outputs. Strip outputs explicitly:

```bash
jupyter nbconvert --clear-output --inplace examples/*.ipynb
```

Smoke runs that need to keep their executed copy must write to
`/tmp` or another scratch directory (the `smoke` Nx target already
does this with `--output-dir /tmp`).

Stray scratch notebooks (e.g. `Untitled.ipynb`) and
`.ipynb_checkpoints/` should not be committed. JupyterLab's
auto-checkpoint directory is already in the workspace `.gitignore`;
`Untitled.ipynb` and macOS `.DS_Store` files appear regularly in this
working tree and should be deleted, not committed.

### Headless bitmap smoke test

[examples/01_hello_volume.ipynb](examples/01_hello_volume.ipynb)
is the canonical end-to-end check. Drive it with
`backend="webgl2"` from a headless browser to verify a real PNG is
produced:

1. Start JupyterLab with `ipyniivue` installed (`pip install -e .`)
   or on `PYTHONPATH`.
2. Open `examples/01_hello_volume.ipynb` with Playwright Chromium.
3. Run all cells.
4. Accept the `ipyniivue-smoke.png` download and validate it is a
   non-empty PNG.

The browser must actually render — `saveBitmap` reads pixels from
the live canvas. Plain `jupyter execute` / the `smoke` Nx target
runs Python only and cannot validate this path.

### Generated files in version control (open question)

Today, all four codegen outputs are committed:

| File | Size | Reviewable? |
| --- | --- | --- |
| `api.generated.json` | ~60 KB | yes — API diffs surface here |
| `src/ipyniivue/_generated.py` | ~28 KB | yes |
| `src/ipyniivue/static/_widget.template.js` | ~15 KB | yes |
| `src/ipyniivue/static/widget.js` | ~1.3 MB bundled | no — minified niivue inlined |

The bundled `widget.js` is the strongest candidate for removal from
git — it is large, regenerates on every niivue change, and is not
human-reviewable. The other three are small, churn rarely, and are
useful as code-review surfaces. Keeping `_generated.py` committed
also lets `pip install -e .` work without invoking Bun on the
consumer side.

Recommendation when revisiting this: gitignore `widget.js` and
generate it at install time via a hatch build hook (or document
that `bunx nx codegen ipyniivue` is a prerequisite for `pip install
-e .`); keep the other three committed.

## Commands

```bash
bunx nx codegen ipyniivue          # Regenerate api.generated.json + Python + JS
bunx nx typecheck ipyniivue        # tsc --noEmit on scripts/codegen.ts
bunx nx smoke ipyniivue            # Python-only nbconvert; verifies imports
                                   # and Python construction don't raise.
                                   # Does NOT validate browser rendering or
                                   # produce a bitmap — see the headless
                                   # smoke section above for the real check.
pip install -e .                   # Local dev install (from this directory)
jupyter lab --no-browser           # Manual inspection
```

If JupyterLab restores stale widget state during dev:

```bash
rm -rf ~/.cache/jupyter ~/.local/share/jupyter/runtime
```

## Related

- [packages/niivue](../niivue) — the underlying TypeScript library
  that codegen reads and bundles.
- [README.md](README.md) — user-facing install and usage docs.
- [examples/README.md](examples/README.md) — table of notebook ports.
