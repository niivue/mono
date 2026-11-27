# `@niivue/nv-ohif`: design notes

NiiVue as a third-party OHIF viewport: NIfTI, DICOM (converted by dcm2niix),
whole-slide, SEG/RTSTRUCT/SR, 4D and TMTV run in OHIF. README.md lists what
works and how to install it; this file keeps the design decisions and the
traps. The delivery history (phases R1-R30) is in git and in the rig's
scorecard (`rordenlab/ohif-niivue`).

## The OHIF contract

OHIF viewers are extensions plus a mode.

1. **Extension**: `{ id, version, getViewportModule, ... }` (`src/index.ts`),
   with `onModeExit`, which drops state that lives for a study (quantification,
   calibration, parked contours, released rows). Pane state goes with each pane.
2. **Viewport component props**: `displaySets`, `viewportId`, `dataSource`,
   the three managers and `viewportOptions`. `NiivueViewport.tsx` owns a canvas
   and a NiiVue instance; it loads only after `attachToCanvas` resolves and
   defaults to WebGL2 (WebGPU device churn under OHIF's mount/unmount).
3. **SOPClassHandlerModule**: the display sets NiiVue claims.
4. **Modes** (`src/modes/*.js`: viewer, tmtv, dynamic; exported as
   `@niivue/nv-ohif/modes/<name>`): plain JS, since OHIF's mode objects are
   untyped and `@ohif/*` resolves from the host. They reuse OHIF's hanging
   protocols and tool groups. `@ohif/mode-preclinical-4d` exports neither
   `initToolGroups` nor `toolbarButtons`, so dynamic.js deep-imports its `src/`
   (fragile across OHIF releases).
5. **React**: OHIF pins React 18; NiiVue core is framework-free, so the viewport
   instantiates `NiiVue` directly and does not use `nv-react` (React 19).

## Packaging

- No `@ohif/*` or `react-dom` peers: bun installs peers, and OHIF's tree would
  hoist `react-dom@18` over the monorepo's React 19. nv-ohif builds against
  local OHIF typings (`src/ohif-types.ts`, one interface per OHIF service) and
  externalizes `react` (peer `^18.3.1 || ^19`).
- `@niivue/niivue` is a `workspace:^` peer (published as `^<version>`); uikit,
  nv-ext-tile and dcm2niix are runtime dependencies, externalized in `build:lib`.
  Release nv-ohif with core: a core API removal breaks published nv-ohif rcs
  whose peer range accepts the new core.
- Publish with a workspace-aware packer (`bun pm pack`); `npm pack` leaves
  `workspace:` ranges in place.
- Test in a real OHIF app from packed tarballs (the rig's `repack.sh`), never a
  symlink into this monorepo: rspack then bundles duplicate shared deps (OHIF's
  floating-ui failed with `platform.detectOverflow is not a function`).
- OHIF's bundled `/viewer` route is mode-longitudinal (cornerstone); an
  injected display set needs a `SOPClassHandlerId` some mode viewport lists in
  `displaySetsToDisplay`, or nothing renders.

## Status and known limitations (2026-11-27)

Every row of the rig's scorecard passes on the packed build or is an approved
exception:

- **LivewireContour** snaps along a different edge cost than cornerstone's: area
  +0.24% on the rig's path, +7.1% on OHIF's Livewire spec path.
- **ClickSegment, MarkerLabelmap, LabelmapSlicePropagation** are not implemented.
- **Dirty-annotations prompt on leave**: dirty state is forwarded, but the tested
  cornerstone configuration shows no prompt to compare against.
- **Volume lighting**: standard 3D has Shade only; Ambient, Diffuse and Specular
  drive 3D Cinematic. Diffuse shades normal-free samples only, and Specular needs
  a colormap with a specular channel (`S`), which NiiVue's CT colormaps lack.
- **OHIF's own specs** that read cornerstone's SVG layer (handles, label text,
  contour paths) cannot pass on a canvas renderer; the rig maps each to an
  equivalent executed check.

## Non-goals

- Replacing cornerstone as OHIF's default viewport.
- Oblique reformatting beyond what NiiVue does.
