# ipyniivue

Jupyter widget wrapper for NiiVue. The Python package uses anywidget and
a generated, self-contained JavaScript bundle built from the local
`@niivue/niivue` package.

## Install for local development

The bundled widget JavaScript (`src/ipyniivue/static/widget.js`,
~1.3 MB) is gitignored — generate it before installing:

```bash
bun install                       # from the monorepo root, once
bunx nx codegen ipyniivue         # builds widget.js into static/
cd packages/ipyniivue
pip install -e .
```

`bunx nx codegen ipyniivue` is fast and Nx-cached; rerun it after any
change to the niivue TS sources or to `scripts/codegen.ts`.

Launch JupyterLab from the package directory so the example notebooks and
local package resolve consistently:

```bash
cd packages/ipyniivue
jupyter lab --no-browser
```

If JupyterLab appears to be restoring stale widget state during local
development, clear the local Jupyter cache and runtime files before
starting it:

```bash
rm -rf ~/.cache/jupyter ~/.local/share/jupyter/runtime
cd packages/ipyniivue
jupyter lab --no-browser
```

Regenerate the Python API and bundled widget after TypeScript-side API or
bundle changes:

```bash
bunx nx codegen ipyniivue
```

## Basic notebook usage

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

`add_volume_from_url(...)` is a small Python helper around NiiVue's
`loadVolumes(...)`. Keyword arguments are converted from snake_case to
NiiVue's camelCase option names.

The smoke-test notebook is:

```bash
packages/ipyniivue/examples/01_hello_volume.ipynb
```

It keeps bitmap export in its own final cell so the user can inspect the
rendered widget before saving.

## Example notebooks

The `examples/` folder also contains notebook ports of selected
`packages/niivue/examples/*.html` demos:

```bash
packages/ipyniivue/examples/02_vox_basic.ipynb
packages/ipyniivue/examples/03_vox_atlas.ipynb
packages/ipyniivue/examples/04_mesh_basic.ipynb
packages/ipyniivue/examples/05_mesh_layers.ipynb
packages/ipyniivue/examples/06_tract_dsi.ipynb
packages/ipyniivue/examples/07_connectome.ipynb
packages/ipyniivue/examples/08_clip_planes.ipynb
packages/ipyniivue/examples/09_freesurfer_crosscut.ipynb
packages/ipyniivue/examples/10_vox_4d.ipynb
packages/ipyniivue/examples/11_vox_stats.ipynb
packages/ipyniivue/examples/12_vox_modulate.ipynb
packages/ipyniivue/examples/13_vox_paqd.ipynb
packages/ipyniivue/examples/14_tract_tsf.ipynb
packages/ipyniivue/examples/15_tract_group.ipynb
packages/ipyniivue/examples/16_tract_groups.ipynb
packages/ipyniivue/examples/17_layout.ipynb
packages/ipyniivue/examples/18_mesh_atlas.ipynb
packages/ipyniivue/examples/19_vox_atlas_stat.ipynb
packages/ipyniivue/examples/20_freesurfer_clip.ipynb
packages/ipyniivue/examples/21_vox_mask.ipynb
packages/ipyniivue/examples/22_vox_thumbnail.ipynb
packages/ipyniivue/examples/23_ext_imgproc.ipynb
packages/ipyniivue/examples/24_ext_drawing.ipynb
packages/ipyniivue/examples/25_save_document.ipynb
packages/ipyniivue/examples/26_data_loading_formats.ipynb
```

These notebooks load assets from the public GitHub Pages mirror:

```python
BASE_URL = "https://niivue.github.io/mono"
VOLUMES = f"{BASE_URL}/volumes"
MESHES = f"{BASE_URL}/meshes"
```

Some ports use `ipywidgets` controls for sliders, dropdowns, and
checkboxes. These are Python-to-JavaScript updates and avoid the
currently fragile NiiVue JavaScript-to-Python event callback path.

## Backend selection

Backend selection follows NiiVue's TypeScript API:

```python
NiiVue()                  # NiiVue default: WebGPU with WebGL2 fallback
NiiVue(backend="webgpu")  # request WebGPU
NiiVue(backend="webgl2")  # request WebGL2
```

The notebook ports use NiiVue APIs that are intended to work with both
WebGPU and WebGL2. In an interactive browser, use `NiiVue()` to get
NiiVue's default WebGPU-with-WebGL2-fallback behavior, or pass
`backend="webgpu"` / `backend="webgl2"` explicitly when testing a
specific backend.

Most examples pin `backend="webgl2"` because WebGL2 is the reliable
backend for automated Jupyter browser smoke tests. Headless Chromium
usually exposes WebGL2 through SwiftShader, while headless WebGPU may
require browser flags, a hardware adapter, or platform-specific browser
configuration.

`01_hello_volume.ipynb` follows the same rule. The notebook itself can be
opened interactively with either backend, but its autonomous bitmap smoke
path should use WebGL2 unless the test environment has known-good
headless WebGPU support.

## Bitmap export

Use `download_bitmap(...)` to queue NiiVue's built-in `saveBitmap`
method:

```python
nv.download_bitmap("ipyniivue-smoke.png")
```

This triggers a browser download. In an interactive notebook the file
goes wherever the browser saves downloads. In browser automation, accept
the download and save it wherever the test needs.

`download_bitmap(...)` is intentionally fire-and-forget. The browser
command queue preserves order, so this works:

```python
nv.add_volume_from_url("https://niivue.github.io/mono/volumes/mni152.nii.gz")
nv.download_bitmap("ipyniivue-smoke.png")
```

The bitmap download runs after the asynchronous volume load completes.

## Headless bitmap smoke testing

Plain `jupyter execute` runs notebook Python but does not create a
browser widget view, so it cannot produce a bitmap download or validate
backend rendering. To test bitmap export without manual input, drive
JupyterLab with a headless browser:

1. Start JupyterLab with the repository package on `PYTHONPATH`, or
   install `ipyniivue` in the active Python environment.
2. Open `examples/01_hello_volume.ipynb` in a browser automation tool
   such as Playwright.
3. Run the notebook cells.
4. Accept the `ipyniivue-smoke.png` download and save it to a known path.

The browser must render the widget because `saveBitmap` reads pixels from
the browser canvas.

## Current limitations

The core fire-and-forget path is the supported path for demos:

- display the widget
- queue volume or mesh loads
- queue bitmap export

JavaScript-to-Python responses now use the `_msg_outbox` traitlet
workaround instead of raw browser `model.send(...)` delivery. The
`wait_ready()` path is browser-smoke-tested, but it is not needed for
normal volume or mesh loading because the browser command queue already
waits for the canvas and preserves async command order.

Keep demos on low-bandwidth, explicit Python-to-JavaScript controls.
Python event callbacks from `nv.on(...)` are available for low-frequency
events, but avoid using high-volume browser events or large event payloads
as part of the main demo path. A few internal events (`canvasResize`,
`viewAttached`, `viewDestroyed`) are silenced at the JS layer to keep
the WebSocket clear during mount; subscribing to them via `nv.on(...)`
raises `ValueError`. The full subscribable list is `NIIVUE_EVENT_NAMES`
in `ipyniivue`.

See `CLAUDE.md` for architecture details and known traps.
