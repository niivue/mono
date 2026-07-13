# `@niivue/nv-ohif` — NiiVue viewport extension for OHIF

Design + delivery plan. Status: **planning** (no code yet). Branch: `ohif-viewer-integration`.

## Goal

Ship NiiVue as a **third-party OHIF viewport**, so OHIF users can render series with
NiiVue — bringing capabilities OHIF's default cornerstone viewport does not focus
on: high-quality **3D volume rendering**, **mesh / surface overlays**, **multiplanar
with colormapped overlays**, and **voxel drawing / vector annotation**. Neuroimaging
workflows in particular.

Decisions taken:
- **Submission path: standalone published npm extension** (added to an OHIF app via
  `pluginConfig.json`), developed here in the monorepo. Not (initially) a PR into the
  OHIF/Viewers monorepo — that can follow once this is proven.
- **Data path is phased**: NIfTI display sets first, DICOM second (details below).

## How OHIF loads a third-party viewport (the contract we must satisfy)

OHIF viewers are **extensions + a mode**, not standalone apps.

1. **Extension** — a plain object `{ id, version, getViewportModule(...) }`.
   `getViewportModule` returns `[{ name, component }]`; `component` is a React
   component. May also expose `onModeEnter` / `onModeExit` lifecycle hooks.
2. **Viewport component props** — `displaySets`, `viewportId`, `dataSource`,
   `servicesManager`, `extensionManager`, `commandsManager`, `viewportOptions`
   (orientation etc.), `children`. Should be memoized (`areEqual`) to control
   re-renders; honor `needsRerendering`.
3. **SOPClassHandlerModule** — declares which display sets this viewport handles
   (`displaySetsToDisplay` / SOP Class UIDs), so OHIF routes matching series here.
4. **Mode** — wires the extension + a layout template + panels, and maps display
   sets → the NiiVue viewport. We ship a demo mode; consumers can also add the
   viewport to their own mode.
5. **React 18** — OHIF pins `react@^18.3.1`. We target React 18 (see below).

## Package shape

```
packages/nv-ohif/
  src/
    index.ts                # the OHIF extension object (id, version, getViewportModule, lifecycle)
    getNiivueViewportModule.tsx
    NiivueViewport.tsx       # React 18 component: owns a <canvas> + a Niivue instance
    sopClassHandler.ts       # SOPClassHandlerModule — which displaySets we claim
    mode/                    # a demo OHIF mode that hangs series in the NiiVue viewport
    data/
      displaySetToNiivue.ts  # displaySet -> NiiVue load (the data bridge; phased)
      cornerstoneVolumeToNVImage.ts  # (phase 2) in-memory cornerstone volume -> NVImage
    commands.ts              # OHIF commands (reset view, set slice type, toggle 3D render, ...)
    toolbar.ts               # toolbar buttons wired to commands
  PLAN.md                    # this file
  README.md                  # consumer docs (add to pluginConfig, mode config)
  package.json / project.json / tsconfig.json
```

**Packaging / deps (learned during scaffold):** the published entry is `src/index.ts`
(the extension object — a real module, so Biome doesn't flag it as a barrel). We do
NOT declare `@ohif/*` (or `react-dom`) as peerDependencies: **bun installs peer deps**,
and pulling the OHIF tree drags in `react-dom@18`, which hoists and breaks
`@niivue/nvreact` (React 19) in this monorepo. Instead we build against **local OHIF
typings** (`src/ohif-types.ts`) and externalize `react`. The only deps are
`@niivue/niivue` (workspace) + a `react` peer of `^18.3.1 || ^19` (so bun reuses the
monorepo's React 19 for dev; the OHIF host supplies React 18 at runtime). The OHIF /
react-dom requirement is documented in `README.md`, not enforced via peers.

### React 18, not `nv-react`

`nv-react` pins React 19; OHIF is on React 18. NiiVue's core is framework-agnostic
(a canvas + the `Niivue` class), so `NiivueViewport.tsx` instantiates `Niivue`
directly (`new Niivue(opts)` → `attachToCanvas(ref)` → `loadVolumes(...)`), and
tears it down on unmount. We do **not** depend on `nv-react`. Shared logic (event
wiring, load diffing) can be factored later if worthwhile.

## Data bridge — the central work, phased

OHIF hands the viewport a **displaySet** (series metadata + image references), not a
NIfTI file. Getting pixels into NiiVue:

### Phase 1 — NIfTI display sets (MVP)
Handle display sets that reference a NIfTI (a NIfTI data source, or DICOM-JSON /
custom display set pointing at a `.nii.gz` URL). `NiivueViewport` calls
`nv.loadVolumes([{ url }])` directly. Proves the extension/mode/SOPClassHandler
plumbing and NiiVue's rendering inside OHIF end-to-end, with the least data work.

### Phase 2 — DICOM via cornerstone volume reuse (best UX)
OHIF/cornerstone3D already streams a DICOM series into an **in-memory volume**
(typed-array scalar data + image metadata: spacing, orientation, origin,
rescale). Build an `NVImage` from that already-loaded volume — **no re-fetch** —
by mapping cornerstone volume metadata → a NIfTI-like header + RAS affine. This is
the "good experience": one load, NiiVue renders it.
- Risk: getting the affine / axis orientation exactly right (DICOM LPS ↔ NIfTI RAS,
  row/column/slice direction cosines). Needs careful tests against known series.

### Phase 3 — `dcm2niix` fallback (self-contained)
For series cornerstone hasn't volume-loaded, fetch instances via `dataSource` and
convert DICOM→NIfTI in-browser with `@niivue/dcm2niix` (already a NiiVue plugin).
Heavier (re-fetch + convert); a fallback, not the default.

## Surfacing NiiVue's value (the "good experience")

Wire OHIF toolbar buttons/commands to NiiVue features so an OHIF user actually gets
the differentiators:
- Slice type: axial / coronal / sagittal / **multiplanar** / **3D render**.
- **3D volume rendering** with clip plane + the exploded-block / drawing work.
- **Overlays** (load a second series/segmentation as a colormapped overlay).
- **Mesh / surface** overlay on the volume.
- Colormap + window/level (bridge OHIF's W/L to `calMin`/`calMax`).
- Sync: crosshair / camera sync with other OHIF viewports where it makes sense.
- Respect OHIF's active tool, measurement, and layout where feasible.

## Testing / verification

- Unit-test the pure bridge (`cornerstoneVolumeToNVImage`, affine mapping) with the
  Bun runner — this is where correctness bugs will live.
- The viewport/rendering is verified in a running OHIF app (the demo mode) — mirrors
  the repo convention that rendering is verified in a real app, not unit tests.
- Add the extension to a local OHIF dev build (`pluginConfig.json`) and drive it in
  the browser; screenshot the NiiVue viewport rendering a known series.

## Open items / decisions still to make

- Which OHIF version to target first (pin to a recent `3.x`; confirm the exact
  `@ohif/core` API surface for `getViewportModule` + SOPClassHandler in that release).
- Exact display-set criteria we claim in the SOPClassHandler (start narrow:
  a NIfTI/volume display set; expand to DICOM SOP classes in phase 2).
- How much of OHIF's tool/measurement model to honor vs. NiiVue's own interactions.
- Monorepo build: OHIF uses webpack/React 18; our packages are Bun/Nx. The extension
  is a library build (externalize react + @ohif/*), consumed by the OHIF app's build.

## Non-goals (for v1)

- Replacing cornerstone as OHIF's default viewport.
- Full measurement/segmentation parity with cornerstone tools.
- Oblique/arbitrary-plane reformatting beyond what NiiVue already does.
