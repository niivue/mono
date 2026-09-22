# Allen "volume-viewer" JSON + PNG atlas format

Reverse-engineered 2026-08-03 from the live Integrated Mitotic Stem Cell viewer
(`https://imsc.allencell.org/?page=3d-viewer`) and cross-checked against
`JsonImageInfoLoader` in [vole-core](https://github.com/allen-cell-animated/vole-core).

This is the legacy loader of Allen's Vol-E viewer. Their newer datasets use
OME-Zarr; this format is still what several published Allen sites serve, and it
is cheap to support because it needs no codec beyond PNG.

## Shape of the data

A dataset is one JSON sidecar plus N PNG "atlases". Each PNG is a 2D grid of
tiles, one tile per Z slice, and packs THREE independent image channels into its
R, G and B planes. Alpha is unused (observed uniformly 255). So a 32-channel
volume ships as 11 PNGs.

Live example (`COMP_crop_M1-M2_atlas.json`, 32 channels of a mitotic stem cell):

```json
{
  "width": 392, "height": 360,
  "channels": 32,
  "channel_names": ["DNA_raw", "ACTB_36152_raw", ..., "TUBA1B_71535_seg"],
  "rows": 8, "cols": 8, "tiles": 58,
  "tile_width": 256, "tile_height": 256,
  "atlas_width": 2048, "atlas_height": 2048,
  "pixel_size_x": 1, "pixel_size_y": 1, "pixel_size_z": 2.9,
  "images": [
    { "name": "COMP_crop_M1-M2_atlas_0.png", "channels": [0, 1, 2] },
    { "name": "COMP_crop_M1-M2_atlas_1.png", "channels": [3, 4, 5] }
  ]
}
```

## Fields

| Field | Meaning |
| --- | --- |
| `width`, `height` | XY size of the ORIGINAL volume, before any downsample into the atlas |
| `tiles` | Number of Z slices |
| `channels` | Total channel count across every atlas |
| `channel_names` | Per-channel label, `channels` entries |
| `channel_colors` | Optional per-channel RGB triplet |
| `rows`, `cols` | Tile grid of one atlas; `rows * cols >= tiles` |
| `tile_width`, `tile_height` | Stored XY size of one Z slice, may be smaller than `width`/`height` |
| `atlas_width`, `atlas_height` | `tile_width * cols`, `tile_height * rows` |
| `pixel_size_x/y/z` | Voxel spacing of the ORIGINAL volume; `pixel_size_unit` defaults to um |
| `images[]` | Per-PNG `{ name, channels }`, where `channels` maps R, G, B to channel indices |
| `times`, `time_scale`, `time_unit` | Optional time series |

Two details that are easy to get wrong:

- **Tiles are laid out row-major**, so tile `t` sits at column `t % cols`, row
  `floor(t / cols)`.
- **Spacing must be rescaled when the atlas is downsampled.** The stored volume
  is `tile_width x tile_height x tiles`, not `width x height x tiles`, so the
  effective spacing is `pixel_size_x * width / tile_width` (and likewise for y).
  Vol-E does the same rescale. In the IMSC dataset this matters: 392x360 of
  original XY is stored in 256x256 tiles.

`images[].channels` may name fewer than three channels for the final PNG, and
the vole-core loader also reads a fourth (alpha) plane when present, so the
mapping array is the authority rather than a fixed stride of 3.

## Decoding

For each PNG: `createImageBitmap`, draw to a canvas, `getImageData`, then walk
the tile grid deinterleaving one of R/G/B into a `Uint8Array` of
`tile_width * tile_height * tiles`, laid out z-major then y then x. That is
already the layout NiiVue wants, so each channel becomes an 8-bit volume with no
further transform.

Verified against the live data: atlas 0 is 2048x2048, and sampling tile 20 gives
independent per-plane maxima (R 203, G 185, B 127) with alpha flat at 255,
confirming the three planes are genuinely separate channels rather than a colour
image.

## Why this format is interesting beyond one site

The rendering demand it creates is the same one OME-Zarr multi-channel
microscopy creates: many single-channel volumes displayed at once, each with its
own colour, window and visibility toggle. The IMSC viewer shows 16 labeled
structures simultaneously. See `docs/tiled-volumes.md` for the streaming side and
`FEATURE_PARITY.md` for where Zarr sits.
