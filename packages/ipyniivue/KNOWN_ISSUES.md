# Known issues

## Current status

The basic notebook workflow is working:

- The widget mounts in JupyterLab.
- Constructor options reach NiiVue, including `backend="webgl2"`.
- Python-to-JavaScript fire-and-forget commands are queued in the
  browser and run in order after the canvas attaches.
- Asynchronous web assets can be loaded from the browser with
  `add_volume_from_url(...)`.
- `download_bitmap(...)` queues NiiVue's built-in `saveBitmap` method and
  works as a simple browser smoke-test signal.

The current example notebook uses this supported path:

```python
from IPython.display import display
from ipyniivue import NiiVue

nv = NiiVue(slice_type=4, is_colorbar_visible=True, backend="webgl2")
display(nv)

nv.add_volume_from_url(
    "https://niivue.github.io/mono/volumes/mni152.nii.gz",
    cal_min=30,
    cal_max=80,
    colormap="gray",
)
```

Then, in a separate cell:

```python
nv.download_bitmap("ipyniivue-smoke.png")
```

The example gallery notebooks under `packages/ipyniivue/examples/` also
use this direction of travel. Their `ipywidgets` controllers run Python
callbacks that update NiiVue traitlets or enqueue generated methods; they
do not depend on NiiVue browser events returning to Python.

## JS-to-Python response path

The original failure mode was raw browser-to-kernel message delivery.
The browser-side comm eventually reported `Comm.send(...): Cannot send`
because the underlying comm was closed while Python was waiting for a
readiness response.

**Environment seen with failures**: Python 3.13.2 through pyenv,
JupyterLab 4.4.10, ipywidgets 8.1.8, anywidget 0.9.19, Chrome and
Safari.

The wrapper now avoids that raw path for responses. JavaScript writes
response bodies to the synced `_msg_outbox` traitlet, and Python observes
that traitlet to resolve pending requests. A browser-driven JupyterLab
smoke test now verifies:

- `await nv.wait_ready()`

Generated async value-returning methods use the same request/response
path. Keep those calls to small JSON-serializable responses.

Python event callbacks registered with `nv.on(...)` also use
`_msg_outbox`, but demos should still avoid high-frequency events and
large payloads. The widget deliberately skips noisy internal events such
as `canvasResize`, `viewAttached`, and `viewDestroyed`.

## Recommended usage for now

Prefer fire-and-forget methods for demos and smoke tests:

- `add_volume_from_url(...)`
- `load_volumes(...)`
- `add_mesh_from_url(...)`
- `download_bitmap(...)`
- other generated methods that return `None`

Do not use `wait_ready()` as a guard for volume loading. It works as a
mount confirmation, but the JavaScript side already owns command ordering
and waits for the canvas before invoking NiiVue methods.

For automated bitmap checks, use a real browser session such as
JupyterLab driven by Playwright. Plain `jupyter execute` runs notebook
Python but does not render any browser widget, so it cannot create a
bitmap download.

## Notebook output and lifecycle traps

Do not save example notebooks with executed widget outputs. JupyterLab
stores widget views as normal cell outputs containing
`application/vnd.jupyter.widget-view+json` and a transient `model_id`.
On a later open, JupyterLab may try to restore that output before the
kernel has a matching live model, producing:

```text
Error: widget model not found
```

Setting Jupyter Widgets `saveState` to `false` prevents
`metadata.widgets` from being written, but it does not prevent these
normal cell outputs. Keep notebooks under `packages/ipyniivue/examples/`
output-free, and make smoke tests write executed notebooks to `/tmp` or
another scratch directory instead of executing examples in place.

Also be careful with anywidget lifecycle state. anywidget passes model
proxy objects to `initialize()` and `render()`, and those proxies are not
guaranteed to be the same object identity. Runtime state must be keyed by
a stable value such as `_anywidget_id`, not by the proxy object itself.
Keying by proxy identity can make `render()` wait on a never-initialized
state object, leaving a blank widget output container with no canvas and
no useful browser console error.

## Backend notes

The widget bundle uses the dual NiiVue entry point. Backend selection
matches TypeScript:

```python
NiiVue()                  # NiiVue default: WebGPU with WebGL2 fallback
NiiVue(backend="webgpu")  # request WebGPU
NiiVue(backend="webgl2")  # request WebGL2
```

Use `backend="webgl2"` for headless browser automation. Headless Chromium
may not expose a WebGPU adapter unless launched with WebGPU-specific
flags, while WebGL2 works through SwiftShader.

## Defensive scaffolding

- `_msg_outbox` synthetic traitlet: used for JS-to-Python responses and
  low-frequency events.
- `SKIP_EVENT_FORWARDING`: avoids forwarding high-frequency internal
  resize/view events.
- Event payload sanitization: removes non-cloneable fields, including
  functions, before attempting JS-to-Python sync.
- The browser command queue: serializes commands so an async
  `loadVolumes` completes before a later `saveBitmap`.
