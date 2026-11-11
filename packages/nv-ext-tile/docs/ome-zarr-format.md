# OME-Zarr (OME-NGFF) multiscale stores

OME-Zarr is the cloud-native container of the OME-NGFF specification: a Zarr
group whose attributes describe a resolution pyramid over up to five named
dimensions, with the pixels chunked into separately-fetchable objects. It is
the format the Allen Institute's IMSC viewer, IDR, and the Human Organ Atlas
publish. `@niivue/nv-ext-tile/zarr` reads it (formerly part of
`@niivue/niivue`); core reads the other microscopy containers (the Allen JSON+PNG
atlas, plain TIFF stacks and OME-TIFF) itself.

Three modules, in layers:

| Module | Responsibility |
| --- | --- |
| `src/zarr/omeZarr.ts` | The metadata. Parses a group's attributes into axes, pyramid datasets and omero channels, and answers the axis questions (which dimension is channel? which spatial axis is display x?). Pure JSON in, no network, Bun-testable. |
| `src/zarr/omeZarrLoader.ts` | The pixels, whole levels at a time. Opens a store with zarrita-rs, picks a pyramid level, pins time and channel, and assembles each requested channel into a NIfTI `File` for `loadVolumes`. |
| `src/zarr/omeZarrChunkedSource.ts` | The pixels, brick by brick. Adapts an opened pyramid to the core `ChunkedVolumeSource` seam for `nv.loadChunkedVolume`, which streams multi-LOD bricks of stores far too large to load whole. |

Unlike TIFF, the container itself is NOT hand-parsed: chunk layout, codecs
(blosc, gzip, zstd, lz4) and both Zarr format versions come from
`@niivue/zarrita-rs/inline`, a runtime dependency that decodes chunks in
wasm with no worker or asset URL for the host app to serve. `OmeZarrSource.arrays` are therefore
`@niivue/zarrita-rs/inline` arrays: read them with that entry's `get`. The
default `@niivue/zarrita-rs` entry and zarrita.js both throw on them, because
each keys its array context with its own private symbol.

## Streaming very large stores

`fetchOmeZarrChunkedSource(url, { channel })` (or `omeZarrChunkedSource` over
an already-opened source) yields a `ChunkedVolumeSource`: finest-first levels
in display terms, plus a `fetchChunk` that reads one brick's voxel region from
one level, clamped to the level's extent and zero-padded past it. The core
`NVChunkedVolume` owns plan-building, per-level dispatch, concurrency, retry,
dedup and GPU residency. Bricks honour the declared axis order the same way
the whole-level loader does (an `x y z` store is transposed per brick), and
the time/channel axes are pinned per source, so multi-channel stores stream
one chosen channel rather than silently dropping the rest.

The convenience fetch wraps the store in `zarr.withByteCaching` with a
`ByteLruCache` (default 256 MiB): raw store responses are reused across the
plan rebuilds that crosshair moves trigger, and a 404'd chunk is remembered as
a zero-byte CONFIRMED ABSENCE: zarr's missing-chunk-means-fill-value
convention makes sparse stores lean on 404s hard, and a store is immutable for
the life of a load, so each absence needs discovering exactly once.

`openOmeZarr`/`fetchOmeZarr` accept `levels` (open a subset of the pyramid,
e.g. a partial local mirror) and `ignoreMissingLevels` (skip a listed level
whose array is absent); each opened level keeps its `datasetIndex` so labels
and telemetry match the store's own numbering. The store root is opened once
to learn the Zarr format version, and every level array is opened
version-pinned; the version-agnostic probe would cost a 404 per level on
every v2 store. `zarrVersion: 2 | 3` (also on `fetchOmeZarrChunkedSource`)
skips that root probe, and the `zarr.json` 404 it logs on a v2 store. A successful `text/html` answer reads as a missing key: Vite's dev server and SPA hosts answer any missing path with their index page and 200, which would otherwise break the v3-to-v2 fallback.

## What is supported

- Zarr v2 (`.zattrs`/`.zarray`) and v3 (`zarr.json`), auto-detected.
- NGFF 0.4 metadata (`multiscales` at the group's top level) and 0.5 (wrapped
  in `ome`). 0.1-0.3 stores load too: string axes are accepted, and a store
  with no axes at all falls back to the fixed `t c z y x` order those versions
  mandated.
- Axes in any declared order. Spatial axes are matched by name (`x`/`y`/`z`),
  so an `x y z`-ordered store (the Human Organ Atlas) presents identically to
  the usual `z y x`; unconventional names fall back to fastest-varying = x.
  The read block is transposed to NIfTI's x-fastest layout when the two
  disagree.
- 2D images (two spatial axes) load as single-slice volumes.
- Time series: one timepoint per load, or all of them on demand with
  `lazyTime` (`setFrame4D` reads frame `t` of every channel through the
  volume's `frameSource`; a byte-bounded LRU keeps decoded frames).
- Label images: `image-label` in the attributes (top level in 0.4, under `ome`
  in 0.5) loads with a generated label colormap. Its `colors` table is not
  read yet.
- Dtypes: (u)int8, (u)int16, (u)int32, float32, float64.
- Voxel spacing from each dataset's `scale` transform, converted to
  MICROMETRES via the axis `unit` (shared `omeLengthToMicrons`; an unstated
  unit is already micrometres, OME's default). Volumes are centred on the
  origin, so every channel and level of a dataset shares one world position.

## What throws

- A store whose root is an array rather than a group, or a group without
  `multiscales`/`datasets`.
- Fewer than 2 or more than 3 spatial axes, or a declared axis count that
  contradicts an array's rank.
- int64/uint64 and non-numeric dtypes (NIfTI has no lossless home for them).
- Out-of-range channel, timepoint or level requests, validated before any
  chunk is fetched.

## Channel display: the omero block

The group may carry display metadata alongside the pyramid:

```json
"omero": {
  "channels": [
    { "label": "LaminB1", "color": "00FF00",
      "window": { "start": 0, "end": 1500, "min": 0, "max": 65535 } }
  ]
}
```

The loader consumes all of it: each volume is named by its channel `label`,
its colormap is the closest `CHANNEL_COLORMAPS` hue to `color` (falling back
to the shared palette rotation, so channels never collide), and `window.start`
/`window.end` become `calMin`/`calMax`. By default only channels not marked
`"active": false` load (channel 0 when every one is); `channels: 'all'` loads
the rest hidden. `streamOmeZarr` applies the same styling to the channel it
streams (your volume options win), and `omeZarrChannelOptions` returns it for
other streamed channels. Colours tolerate a leading `#` and an
appended alpha byte. A store without an omero block gets positional names and
palette colours, like a colourless OME-TIFF.

## Level choice

`loadOmeZarrVolumes` reads ONE pyramid level per call (`level` option,
0 = finest). By default it picks the finest level whose per-channel decoded
size fits a 256 MiB budget (`levelBudgetBytes`): pointing the loader at a
slide-sized pyramid must not flood the network or the GPU, which is the lesson
of the streaming demo's L0 incident. `fetchOmeZarr` opens the store without
reading chunks, so a picker can list channels and levels (`OmeZarrLevel.dims`,
`channelBytes`) before committing; `omeZarrVolumesFrom` then reuses the opened
store.

## Sources verified against

- IDR idr0062 (`6001240.zarr`, NGFF 0.4, czyx uint16, 2 channels with omero
  colours and windows), idr0101 (tczyx, 6 channels, 18 timepoints) and
  idr0076 (cyx float64, 50 channels, loading as single-slice volumes).
- Human Organ Atlas hearts (NGFF 0.4, `x y z` declared order), also the
  streaming demo's store.
- The unit suite's in-memory v2 stores (raw codec), which pin the exact
  hyperslab and byte order read.
