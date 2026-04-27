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

## Module-boundary exception

The workspace boundary checker ([nx-tools/check-boundaries.js](../../nx-tools/check-boundaries.js))
forbids Python projects from depending on TypeScript projects in
general — but **`ipyniivue` is explicitly allowed** via `PY_TO_TS_ALLOWED`.
Reason: the codegen pipeline bundles `@niivue/niivue` and
`@niivue/nv-ext-*` TypeScript outputs into the generated browser bundle
[src/ipyniivue/static/widget.js](src/ipyniivue/static/widget.js) that
ships inside the Python wheel. The TS dependency is a codegen-time
artifact, not a runtime call.

How the dependency surfaces in Nx's graph:

- The generated [_widget.template.js](src/ipyniivue/static/_widget.template.js)
  contains real `import { ... } from '@niivue/nv-ext-image-processing'`
  statements that Nx's `@nx/js` plugin picks up as a static project edge.
- `bunx nx graph` will show `ipyniivue -> nv-ext-image-processing` (and
  potentially other `nv-ext-*` packages once Phase B.2 / B.3 land).
- The boundary checker accepts this edge because `ipyniivue` is in
  `PY_TO_TS_ALLOWED`.

**Unintended consequences to watch for:**

- `bunx nx affected` will run TypeScript-side checks when ipyniivue
  changes, because Nx now sees the cross-language edge. This is
  technically correct (a niivue API change can break the bundled JS)
  but means CI for ipyniivue-only changes runs more than the literal
  Python diff suggests.
- Adding more `@niivue/nv-ext-*` packages to the codegen bundle adds
  more graph edges automatically — no extra config needed beyond a
  `dependsOn` entry in [project.json](project.json) and a workspace
  symlink via the root `package.json` devDependencies.
- If a future Python project (not ipyniivue) needs the same exception,
  add it explicitly to `PY_TO_TS_ALLOWED` — don't broaden the rule.
  The narrow allow-list is the design.

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

## Roadmap

What's left, in execution order. Each phase produces something
demoable before the next one starts.

### A. Validate JS-to-Python event messaging in a real notebook

Status: mechanism exists, **not yet exercised** by any example.

The `nv.on(event, callback)` path through `_msg_outbox` is wired
end-to-end and `wait_ready()` proves the round-trip works, but **no
notebook in `examples/` actually uses `nv.on(...)`**. Every port
sidesteps it by using `ipywidgets` controls for Python→JS only. That
leaves the high-bandwidth side untested.

Concrete next step: port [packages/niivue/examples/vox.atlas.stat.html](../niivue/examples/vox.atlas.stat.html)
faithfully — the JS demo subscribes to `locationChange` and writes
`detail.string` into a status footer on every mouse move. The current
[examples/19_vox_atlas_stat.ipynb](examples/19_vox_atlas_stat.ipynb)
deliberately omits that subscription. Add a new notebook (or extend
19) that uses:

```python
status = ipywidgets.Label()
nv.on("locationChange", lambda d: setattr(status, "value", d.get("string", "")))
```

Then drag the crosshair for ~30 seconds in JupyterLab and watch the
kernel comm. If the comm survives, declare messaging complete. If it
floods (the original failure mode that pushed us to `_msg_outbox`),
add per-event throttling on the JS side — either a hard-coded
`THROTTLE_EVENT_FORWARDING` map (`{ locationChange: 50, azimuthElevationChange: 50 }`)
or a synced `_event_throttle_ms` Dict trait that Python can configure.

### B.1. Bundle and demo `nv-ext-image-processing` (done)

The four image-processing transforms (`otsu`, `removeHaze`, `conform`,
`connectedLabel`) are now bundled into `widget.js` and pre-registered
on widget mount.

- JS side: codegen emits the import and registers all four transforms
  inside `initialize()` before any user command can land. A composite
  command `__ext_apply_image_transform` does
  `applyVolumeTransform` → `resultDefaults` → `addVolume` (or
  `removeAllVolumes` + `addVolume` when `replace_background=True`) in
  one round-trip, returning `{name, elapsed_ms}` to Python. The
  extension context is cached on `state.extContext` and disposed on
  widget unmount.
- Python side: `nv.apply_image_transform(name, volume_index=0, options=None, replace_background=False)`
  in [widget.py](src/ipyniivue/widget.py).
- Demo: [examples/23_ext_imgproc.ipynb](examples/23_ext_imgproc.ipynb)
  — dropdown of bundled transforms, options form built dynamically
  from `await nv.get_volume_transform_info(name)`, Apply / Reset.
- Bundle size impact: 1.27 MB → 1.29 MB (+~20 KB; the worker is
  inlined into the ext package's pre-built `dist/`).

### B.2. Drawing interpolation (done)

The `nv-ext-drawing` interpolation workflow ships:

- JS side: codegen emits imports for `findDrawingBoundarySlices` and
  `interpolateMaskSlices`, plus two composite commands
  (`__ext_drawing_find_boundaries`, `__ext_drawing_interpolate_slices`).
  Each pulls the live bitmap from `ctx.drawing.bitmap`, calls the
  worker-backed extension function, writes the result back via
  `ctx.drawing.update(...)`, and returns a summary dict.
- Python side: `nv.find_drawing_boundary_slices(axis)` and
  `nv.interpolate_drawing_slices(axis, use_intensity_guided=False, ...)`
  in [widget.py](src/ipyniivue/widget.py).
- Demo: [examples/24_ext_drawing.ipynb](examples/24_ext_drawing.ipynb)
  — pen color/size/undo controls, axis dropdown, intensity-guided
  toggle with three sliders, Find boundaries / Interpolate buttons,
  status label.
- Bundle size impact: 1.29 MB → 1.31 MB (+~12 KB).

The hover-driven magic-wand demo (`apps/demo-ext-drawing/magic-wand.ts`)
is **not ported**. Its sub-frame `slicePointerMove` preview UX needs
sub-100 ms round-trips that Jupyter's request/response model can't
deliver, and `MagicWandShared` requires COOP+COEP headers that
JupyterLab does not set. A programmatic
`magic_wand(seed_voxel, slice_axis, **opts)` API that runs the
single-shot `magicWand` worker call is straightforward to add (no
hover preview, no SAB) and would be the next small B.2.next ship.

### B.3. `nv-ext-save-html` (deferred — niivue-bundle bootstrap)

### B.3. Scene export (done — chose `.nvd` over self-contained `.html`)

Shipped: [examples/25_save_document.ipynb](examples/25_save_document.ipynb)
demonstrating two export paths backed by the existing codegen output:

- `nv.save_document(filename)` (fire-and-forget) — triggers a browser
  download of an `.nvd` file (CBOR-encoded NVD document). Opens in
  any niivue viewer including [niivue.github.io](https://niivue.github.io/niivue/).
- `await nv.serialize_document()` — returns the raw bytes for
  programmatic use (write to disk, upload to object storage, etc.).

**Why we did not bundle `@niivue/nv-ext-save-html`:**
`saveHTML(nv, filename, {niivueBundleSource})` requires a
self-contained niivue ESM (the `apps/demo-ext-save-html/public/niivue-standalone.js`
artifact is ~1.2 MB) bundled in for the `import()` machinery in the
saved HTML to work. Shipping it inside `widget.js` would roughly
double the wheel size to ~2.5 MB; shipping it as a separate static
asset would still add 1.2 MB to the install and complicate the
anywidget asset-loading path (anywidget serves the widget JS via a
`blob:` URL with no hierarchical base, so a relative `fetch()` of a
sibling asset doesn't resolve cleanly). For a Jupyter/data-science
audience, `.nvd` is the better artifact — it's KB rather than MB, it
opens in any niivue viewer, and the kernel/notebook already provides
the share-with-someone affordance that `.html` solves for browser
apps.

If a user explicitly asks for `.html` export later, the right design
is to ship `niivue-bundle.js` as a separate static asset (rather than
inlining it into `widget.js`) so it can be gitignored independently
and rebuilt on demand. The codegen pattern would mirror Phase B.1 —
a second `Bun.build` pass with a tiny `import NiiVueGPU from '@niivue/niivue'; export default NiiVueGPU`
entry — and JS-side widget code would load it via `importlib.resources`
on Python and pass the source string to `saveHTML` through a
composite command.

### C. Binary buffer ingress (numpy → volume)

Today, `add_volume_from_url` is the only ingress path. Real workflows
often have a `numpy.ndarray` already in memory (e.g. a derived
statistical map) and want to view it without round-tripping to disk.

Work:

1. anywidget supports binary buffers in `model.send(content, buffers)`.
   Add a buffer-aware variant of the `_msg_inbox` path: `{seq, body, buffers}`
   where `buffers` lives in a parallel synced trait or rides on the
   raw `model.send` channel (the latter, since it's Python→JS only,
   doesn't suffer the JS→Python comm fragility).
2. JS side: receive the `ArrayBuffer`, wrap into the appropriate
   `TypedArray`, build a NIfTI header from the Python-supplied
   metadata, hand to `nv.addVolume(...)`.
3. Python helpers:
   ```python
   nv.add_volume_from_array(arr, affine=..., name=..., colormap=...)
   nv.add_mesh_from_bytes(mz3_bytes, name=...)
   ```

This is the single most-requested feature for any scientific Python
viewer. It also unlocks pytest unit tests that don't depend on a
network round-trip.

### D. Polish, test, and ship

1. **Tests.** Add a `pytest` target to [project.json](project.json):
   - codegen-output integrity (every method in `api.generated.json`
     appears in `_generated.py`, every traitlet has a sane default,
     `NIIVUE_EVENT_NAMES` is non-empty).
   - widget construction with each major option combination.
   - **Playwright smoke**: `01_hello_volume.ipynb` produces a
     non-empty PNG with `backend="webgl2"`. This is the only test
     that exercises real GPU rendering end-to-end.
2. **PyPI publish path.**
   - Bump `pyproject.toml` to a real version.
   - Add a Python release target to [project.json](project.json) that
     hooks into Nx Release.
   - Resolve the `widget.js` gitignore question (Phase B forces a
     decision): either keep committed and live with the 1.3+ MB
     diff churn, or move generation into a hatch build hook so
     `pip install` invokes Bun.

### Deferred (do only if asked)

- **JS-handle proxy objects** (`NVImage`, `NVMesh`, `NVDrawingVolume`,
  `NVAnnotation` Python classes that hold an opaque JS handle id).
  Codegen currently skips the seven properties listed in the
  "Skipped properties" table; methods are sufficient for most flows.
- **R port via the [anywidget R package](https://github.com/manzt/anywidget/tree/main/packages/anywidget-r).**
  The `widget.js` bundle is reusable verbatim; only a third codegen
  emitter (`emitR()`) is needed. Estimate: 1–2 weeks for a prototype
  matching the Python feature set. Worth revisiting once Phase C
  lands and the API surface stabilizes.

## Related

- [packages/niivue](../niivue) — the underlying TypeScript library
  that codegen reads and bundles.
- [README.md](README.md) — user-facing install and usage docs.
- [examples/README.md](examples/README.md) — table of notebook ports.
