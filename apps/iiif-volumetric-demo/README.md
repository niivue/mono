# iiif-volumetric-demo

Browser demo for the IIIF Volumetric Server, built on `@niivue/niivue`.

## Pages

- `index.html` — 3-pane IIIF Image API slices (axial / coronal / sagittal)
  plus a niivue 3D render driven by the Presentation 4.0 alpha manifest.

Additional POC pages from the standalone repo (infinite, neuro-desktop,
openneuro, osd-volume-desktop, volume-fly-space) are deferred — they
depend on niivuegpu APIs (`setInstances`, `setViewport`,
`NVCanvasViewportController`, `setGlobalCamera`) that are not yet ported
into `@niivue/niivue`.

## Running

The IIIF Volumetric Server must be running locally (default
`http://127.0.0.1:8080`). Then:

```sh
bunx nx dev iiif-volumetric-demo
```

Vite serves on port 8087 and proxies `/api`, `/iiif`, `/volumes`,
`/vendor`, and `/dev` to the IIIF server. Override the target with the
`IIIF_SERVER_URL` env var.
