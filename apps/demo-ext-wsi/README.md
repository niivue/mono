# demo-ext-wsi

Demo app for [`@niivue/nv-ext-wsi`](../../packages/nv-ext-wsi): open a tiled/pyramidal TIFF, BigTIFF, OME-TIFF or Aperio SVS whole-slide image, or a local DICOM-WSI folder, and pan/zoom it with `NVSlide` + `SlideRenderer` (WebGL2). Only the tiles in view are read and decoded.

```bash
bun install                    # From monorepo root
bunx nx dev demo-ext-wsi      # Dev server on port 8092
```

- **File picker** reads a local file (`fromBlob`), nothing is uploaded.
- **URL** streams by HTTP Range. The server must answer `206` and allow the request cross-origin (CORS with `Range`); a server that ignores Range is refused after its first response. `?url=<tiff>` opens one on load; without it the demo opens OpenSlide's [CMU-1-Small-Region.svs](https://media.githubusercontent.com/media/niivue/niivue-demo-images-lfs/main/streaming/svs/CMU-1-Small-Region.svs), served with Range and CORS from GitHub LFS.

- **DICOM-WSI folder** picks a folder (`webkitdirectory`). The demo indexes its headers (`indexDicomWsi`; no pixel data is read), lists each slide (optical path, focal-plane index `z`, levels, transfer syntax, sparse, frames and holes; skipped files are in the status tooltip) in a menu and opens the first; pick another to switch. JPEG 2000 and JPEG-LS tiles decode in `@niivue/dcm2niix` workers. **Colour management** (on by default) applies the slide's ICC profile, for TIFF/SVS too; the status line names a slide's profile, with `(off)` while the box is unticked. Index timings are in the [package README](../../packages/nv-ext-wsi#local-dicom-wsi-folders).
- `bunx nx e2e demo-ext-wsi` (about 1 s, not in CI) builds the demo and checks the folder workflow in headless Chromium on the package's synthetic fixtures.

## Part of the [NiiVue](https://github.com/niivue) ecosystem
