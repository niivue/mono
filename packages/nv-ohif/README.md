# @niivue/nv-ohif

A [NiiVue](https://github.com/niivue/niivue) viewport extension for the
[OHIF Viewer](https://ohif.org) (v3.12). Render series with NiiVue inside OHIF —
bringing 3D volume rendering, mesh/surface overlays, multiplanar with colormapped
overlays, and voxel drawing / vector annotation to your OHIF app.

> **Status: Phase 1 (proven, incl. in a real OHIF app).** Renders **NIfTI
> (volume-URL) display sets** today; verified mounting inside a full local OHIF Viewer
> (registered via `pluginConfig.json` + a mode). DICOM support — building a NiiVue
> volume from OHIF's already-loaded cornerstone series — is the next phase. See
> `PLAN.md`.

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
- A non-volume-URL (DICOM) display set shows a placeholder until the DICOM bridge
  lands.
- Mirrors OHIF's active primary tool (Window/Level, Pan) onto NiiVue's left-drag.
- Ships **toolbar buttons + commands**: a views dropdown (axial / coronal /
  sagittal / multiplanar / 3D render), a **clip-plane** dropdown (off / anterior /
  posterior / left / right / superior / inferior), a **window/level** dropdown
  (auto robust window + OHIF's modality presets, applied as NiiVue calMin/calMax),
  an **overlay** toggle (load the study's next series as a colormapped overlay),
  and a reset-view button — all with active/disabled state tracked per viewport.

## Toolbar buttons

The extension registers the commands (`niivueSetSliceType`, `niivueResetView`,
`niivueSetClipPlane`, `niivueToggleOverlay`, `niivueSetWindowLevel`,
`niivueSetWindowLevelPreset`, `niivueAutoWindowLevel`), the toolbar evaluators,
and a customization pack with the button definitions. A mode pulls them in by
reference and places them in its primary bar:

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
              'NiivueWindowLevel', 'NiivueOverlay', 'NiivueReset'] },
],
```

## Compatibility

- **OHIF**: `^3.12` (developed against 3.12.6).
- **React**: `^18.3.1` (OHIF is on React 18 — this does not use `@niivue/nvreact`,
  which targets React 19).

## Roadmap

See `PLAN.md`. Next: DICOM via cornerstone-volume reuse (no re-fetch), then a toolbar
surfacing NiiVue's 3D render / overlays / drawing, then a `dcm2niix` fallback.
