# @niivue/nv-ohif

A [NiiVue](https://github.com/niivue/niivue) viewport extension for the
[OHIF Viewer](https://ohif.org) (v3.12). Render series with NiiVue inside OHIF —
bringing 3D volume rendering, mesh/surface overlays, multiplanar with colormapped
overlays, and voxel drawing / vector annotation to your OHIF app.

> **Status: Phase 1 (proven).** Renders **NIfTI (volume-URL) display sets** today.
> DICOM support — building a NiiVue volume from OHIF's already-loaded cornerstone
> series — is the next phase. See `PLAN.md`.

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

## Compatibility

- **OHIF**: `^3.12` (developed against 3.12.6).
- **React**: `^18.3.1` (OHIF is on React 18 — this does not use `@niivue/nvreact`,
  which targets React 19).

## Roadmap

See `PLAN.md`. Next: DICOM via cornerstone-volume reuse (no re-fetch), then a toolbar
surfacing NiiVue's 3D render / overlays / drawing, then a `dcm2niix` fallback.
