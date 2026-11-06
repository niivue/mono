# demo-ext-wsi

Demo app for [`@niivue/nv-ext-wsi`](../../packages/nv-ext-wsi): open a tiled/pyramidal TIFF, BigTIFF, OME-TIFF or Aperio SVS whole-slide image and pan/zoom it with `NVSlide` + `SlideRenderer` (WebGL2). Only the tiles in view are read and decoded.

```bash
bun install                    # From monorepo root
bunx nx dev demo-ext-wsi      # Dev server on port 8092
```

- **File picker** reads a local file (`fromBlob`), nothing is uploaded.
- **URL** streams by HTTP Range. The server must answer `206` and allow the request cross-origin (CORS with `Range`); a server that ignores Range is refused after its first response. `?url=<tiff>` opens one on load; without it the demo opens OpenSlide's [CMU-1-Small-Region.svs](https://media.githubusercontent.com/media/niivue/niivue-demo-images-lfs/main/streaming/svs/CMU-1-Small-Region.svs), served with Range and CORS from GitHub LFS.

## Part of the [NiiVue](https://github.com/niivue) ecosystem
