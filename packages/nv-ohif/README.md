# @niivue/nv-ohif

A [NiiVue](https://github.com/niivue/niivue) viewport extension for the
[OHIF Viewer](https://ohif.org) (v3.12). Render series with NiiVue inside OHIF —
bringing 3D volume rendering, mesh/surface overlays, multiplanar with colormapped
overlays, and voxel drawing / vector annotation to your OHIF app.

> **Status: proven in a real OHIF app.** Renders **NIfTI (volume-URL) display sets**
> and **DICOM series** (fetched + converted to NIfTI with `@niivue/dcm2niix`), with a
> toolbar surfacing NiiVue's views / clip plane / overlay / window-level. Verified
> mounting inside a full local OHIF Viewer (registered via `pluginConfig.json` + a
> mode). See `PLAN.md`.
>
> **DICOM has an unshipped-dependency caveat — read [DICOM support](#dicom-support)
> before relying on it.** The NIfTI path works with published deps today; DICOM
> needs a `@niivue/dcm2niix` release that is not published yet.

> **Consuming the local build (dev):** install **packed tarballs**, do not symlink.
> Symlinking the monorepo package into an OHIF app makes its bundler follow the link
> and bundle a duplicate of shared deps (breaks OHIF's floating-ui). Use
> `npm pack` + `pnpm add file:<dir>` so each resolves self-contained from the app tree.

## Try the proof demo

`bun run dev` starts a small OHIF-shaped harness (`demo/`) that drives the real
extension — it pulls the viewport via `getViewportModule()` and renders it with a mock
OHIF display set pointing at a public NIfTI, so you can see NiiVue rendering a volume
without a full OHIF app.

## Install

```bash
bun add @niivue/nv-ohif
# peers your OHIF app already provides: @ohif/core, @ohif/extension-default,
# react@^18.3.1, react-dom@^18.3.1, and @niivue/niivue
```

## Register the extension

Add it to your OHIF app's `pluginConfig.json` (or `addExtension`) and reference the
viewport from a mode. The extension id is `@niivue/nv-ohif`; the viewport name is
`niivue`.

```js
// in a mode's viewport config
{
  namespace: '@niivue/nv-ohif.viewportModule.niivue',
  displaySetsToDisplay: ['<your NIfTI/volume display-set handler>'],
}
```

## What it does today

- Registers a **React 18 viewport** that owns a `<canvas>` + a NiiVue instance.
- Loads a display set whose URL is a NiiVue-readable volume (`.nii/.nii.gz`, `.nrrd`,
  `.mgz`, `.mha`, `.mif`, …) via `nv.loadVolumes(...)`, opening in multiplanar.
- Loads a **DICOM** series by fetching it and converting to NIfTI with
  `@niivue/dcm2niix` (see [DICOM support](#dicom-support) for the dependency caveat);
  a whole-slide (SM) series shows a placeholder (NVSlide path not wired yet).
- Mirrors OHIF's active primary tool (Window/Level, Pan) onto NiiVue's left-drag,
  and reflects a manual NiiVue window/level drag onto any sibling OHIF viewport
  showing the same series (`setViewportWindowLevel`).
- Ships **toolbar buttons + commands**: a views dropdown (axial / coronal /
  sagittal / multiplanar / 3D render), a **clip-plane** dropdown (off / anterior /
  posterior / left / right / superior / inferior), a **window/level** dropdown
  (auto robust window + OHIF's modality presets, applied as NiiVue calMin/calMax),
  a **colormap** dropdown (gray / hot / bone / cool / warm / viridis / plasma /
  inferno / turbo / jet, applied to the base volume), a **colorbar** toggle (the
  colormap legend), a **smoothing** toggle (nearest-neighbor vs linear
  interpolation), an **overlay** toggle (load the study's next series as a
  colormapped overlay), and a reset-view button — all with active/disabled state
  tracked per viewport.

## Toolbar buttons

The extension registers the commands (`niivueSetSliceType`, `niivueResetView`,
`niivueSetClipPlane`, `niivueToggleOverlay`, `niivueSetWindowLevel`,
`niivueSetWindowLevelPreset`, `niivueAutoWindowLevel`, `niivueSetColormap`,
`niivueToggleColorbar`, `niivueToggleInterpolation`), the toolbar evaluators, and a customization pack with the
button definitions. A mode pulls them in by reference and places them in its
primary bar:

```js
// in a mode
toolbarButtons: [
  { $reference: 'cornerstone.toolbarButtons' },
  { $reference: 'niivue.toolbarButtons' },
],
toolbarSections: [
  { $reference: 'cornerstone.toolbarSections' },
  { $reference: 'niivue.toolbarSections' },
  // restate your primary bar with the NiiVue buttons added (sections
  // shallow-merge per key, later wins)
  { primary: [/* ...your button ids, */ 'NiivueViews', 'NiivueClip',
              'NiivueWindowLevel', 'NiivueColormap', 'NiivueColorbar', 'NiivueInterpolation',
              'NiivueOverlay', 'NiivueReset'] },
],
```

## DICOM support

DICOM series are rendered by fetching the instances and converting them to NIfTI
in-browser with `@niivue/dcm2niix` (a WASM build of dcm2niix). This is verified
working end-to-end in a real OHIF app for both uncompressed and JPEG-LS studies.

> **Dependency caveat (as of this writing): the required `@niivue/dcm2niix` fix is
> not published yet.** dcm2niix's Web Worker aborts every in-browser conversion on
> the published versions: Emscripten's `exit()` *throws* inside a Web Worker (it
> returns the code under Node), and the worker does `const exitCode =
> mod.callMain(args)` and lets that throw hit its catch, so it never reads
> `/output`. The fix wraps `callMain` in try/catch and reads `err.status`. It has
> been confirmed for upstream (`rordenlab/dcm2niix` `js/src/worker*.js`) but is
> **not in any published `@niivue/dcm2niix`** — neither `1.2.0` (current latest) nor
> the `1.3.0-dev.0` prerelease contains it (both still have the bare `callMain`).
>
> Consequences:
> - **NIfTI display sets work with published deps today.** DICOM does **not** until
>   a fixed `@niivue/dcm2niix` is published.
> - This package pins `@niivue/dcm2niix` at `^1.2.0` as a placeholder. **When the
>   fixed release ships, bump the pin to `>=<that version>`** (search this repo for
>   `DCM2NIIX_PIN` — the marker is on the dependency in `package.json`).
> - In the monorepo dev rig, DICOM works because a locally-built patched dcm2niix is
>   installed by hand; that is not what `npm`-install consumers get.

## Compatibility

- **OHIF**: `^3.12` (developed against 3.12.6; also exercised against OHIF
  `master`/3.13-beta in the dev rig).
- **React**: `^18.3.1` (OHIF is on React 18 — this does not use `@niivue/nvreact`,
  which targets React 19).
- **`@niivue/dcm2niix`**: required for DICOM only — see [DICOM support](#dicom-support).

## Roadmap

See `PLAN.md`. Landed: NIfTI + DICOM rendering, and a toolbar for views / clip plane /
overlay / window-level (both directions) / colormap. Next: segmentation
overlays, mesh/surface overlay, and **NVSlide for 2D / whole-slide (SM)** series (see
the `## TODO — NVSlide for 2D` section in `PLAN.md`).
