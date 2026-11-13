---
title: OME-Zarr volumes
description: "Load OME-Zarr stores into a NiiVue scene, one resolution level at a time or streamed piece by piece, with their channels, time points and labels."
sidebar:
  order: 3
---

OME-Zarr (also called OME-NGFF) stores a large image as a pyramid of
resolution levels, each cut into small chunks that can be fetched one at a
time. Image archives such as IDR and the Human Organ Atlas publish their data
this way. `@niivue/nv-ext-tile/zarr` brings these stores into a NiiVue
scene in one of two ways:

- **Load one level whole.** Simple, and the right choice when the level
  you want fits in memory.
- **Stream it.** For stores far too big to load, chunks arrive as you look
  around, with finer detail near the crosshair.

A flat 2D image, such as a fluorescence scan, can also be shown as a pannable
slide. See [Viewing slides](/packages/nv-ext-tile/slides/).

## Loading a store

```js
import { loadOmeZarrVolumes } from '@niivue/nv-ext-tile/zarr'

const volumes = await loadOmeZarrVolumes('https://example.org/cells.ome.zarr')
await nv.loadVolumes(volumes)
```

Here `nv` is your NiiVue viewer (see [Getting started](/guide/)). Each
channel of the store becomes its own volume. If the store has display
settings (its `omero` block), each volume takes its name, colour and
contrast from them; otherwise channels are named "Channel 1", "Channel 2"
and so on, each in its own colour.

The URL must point at the root of the store: the folder that holds
`zarr.json` or `.zattrs`, not an array inside it.

## Choosing a resolution level

Level 0 is the finest. By default the loader picks the finest level where
one channel fits in 256 MiB once decoded, or the coarsest level if none
does. This keeps a huge store from flooding the network or the graphics
card. To choose yourself:

```js
const volumes = await loadOmeZarrVolumes(url, { level: 2 })
```

`levelBudgetBytes` changes the 256 MiB limit used for the automatic choice.

## Choosing channels

By default you get the channels the store marks as active. A channel with
no mark counts as active, and if every channel is marked inactive you get
the first one. To choose:

```js
await loadOmeZarrVolumes(url, { channels: [0, 2] }) // exactly these, all visible
await loadOmeZarrVolumes(url, { channels: 'all' }) // everything, inactive ones hidden
```

## Looking before you load

`fetchOmeZarr` opens a store and reads its description without downloading
any image data. Use it to build a level or channel picker, then load from
the same opened store:

```js
import { fetchOmeZarr, omeZarrVolumesFrom } from '@niivue/nv-ext-tile/zarr'

const store = await fetchOmeZarr(url)
console.log(store.levels.map((level) => level.dims)) // size of each level, [x, y, z]
console.log(store.channelCount, store.timepointCount)

const volumes = await omeZarrVolumesFrom(store, { level: 1, channels: [0] })
```

## Time series

`timepoint` picks which time point to load. With `lazyTime`, the other time
points are fetched only when you show them:

```js
const volumes = await loadOmeZarrVolumes(url, { lazyTime: true })
await nv.loadVolumes(volumes)
await nv.setFrame4D(nv.volumes[0].id, 5) // fetch and show time point 5
```

`setFrame4D` switches every channel of the store together and resolves once
the new frame is on screen. Frames you have seen are kept in memory, up to
256 MiB per store (`frameCacheBytes`), and the next frame in the direction
you are moving is fetched ahead of time.

To keep two stores in step, such as an image and its segmentation, give both
the same object as `lazyTime`:

```js
const time = {}
await nv.loadVolumes([
  ...(await loadOmeZarrVolumes(imageUrl, { lazyTime: time })),
  ...(await loadOmeZarrVolumes(labelsUrl, { lazyTime: time })),
])
```

Saving the scene as a document keeps the frame on screen as an ordinary
volume.

## Segmentations and labels

A store marked as a label image (it has `image-label` metadata) loads with
a label colormap: random colours, with label 0 left clear. Pass
`labels: true` to treat any store this way, or `labels: false` to turn it
off.

When the store lists its own colours for each label, use them instead:

```js
import { omeZarrLabelColormap } from '@niivue/nv-ext-tile/zarr'

const store = await fetchOmeZarr(labelsUrl)
const colors = omeZarrLabelColormap(store.info) // null when the store lists none
if (colors) nv.addColormap('tissue', colors)
const volumes = await omeZarrVolumesFrom(store)
await nv.loadVolumes(volumes.map((v) => ({ ...v, colormap: 'tissue' })))
```

## Streaming stores too big to load

```js
import { streamOmeZarr } from '@niivue/nv-ext-tile/zarr'

await streamOmeZarr(nv, url)
```

The store is added to the scene as one volume and streamed chunk by chunk,
with finer levels near the crosshair. It streams one channel,
the first active one unless you pass `channel`. Pass `replace: true` to
remove the volumes already shown once the store has opened, so a store that
fails to open leaves the scene as it was.

Chunks are read in background workers, half your processor cores and at
most four (`workers`, or `0` to read on the page itself). Raw chunks are
kept in a 256 MiB memory cache (`cacheBytes`). The workers stop by
themselves when the volume is removed or the viewer is destroyed.

To keep downloaded chunks between visits, pass `persist: true`. They are
then stored in the browser's Cache Storage, so a reload streams from disk.
It is off by default because it writes to the user's disk. It needs a
secure page (https or localhost), and it is ignored with a custom `fetch` or
a URL that carries a query string or credentials.

To show the same store in more than one place, such as a volume and a slide,
open it yourself with `fetchOmeZarrChunkedSource`, pass it to
`nv.loadChunkedVolume`, and call `source.dispose()` when you are done with
it.

## Servers that need a login

Every loader takes a `fetch` option, called the same way as the browser's
`fetch`, so you can add headers:

```js
const volumes = await loadOmeZarrVolumes(url, {
  fetch: (url, init) =>
    fetch(url, {
      ...init,
      headers: { ...init?.headers, Authorization: `Bearer ${token}` },
    }),
})
```

A function cannot be passed to a worker, so with a custom `fetch` streamed
chunks are read on the page itself.

If you are upgrading: this replaces the loaders' old `fetchImpl` option and
the old `(request) => fetch(request)` callback of `ZarrSlideSource`. Wrap an
old callback as `fetch: (url, init) => old(new Request(url, init))`.

## Which stores work

- Zarr format 2 and 3, detected automatically.
- OME-NGFF 0.4 and 0.5. Older 0.1 to 0.3 stores load too.
- Axes in any order. The x, y and z axes are found by name.
- Two or three spatial axes. A 2D image loads as a volume one slice thick.
- 8, 16 and 32-bit integers, signed or unsigned, and 32 and 64-bit floats.
- The usual compressors (blosc, gzip, zstd and others) and sharded arrays.
- Voxel spacing comes from the store, in micrometres. Every channel and level
  of a store lines up in the same place.

It has been checked against stores from IDR (for example idr0062, idr0076
and idr0101) and Human Organ Atlas hearts.

## When a store will not load

- **The URL points inside the store.** Point it at the root group.
- **The group has no `multiscales` metadata.** It is plain Zarr, not
  OME-Zarr.
- **The data is 64-bit integer**, which has no lossless place in NiiVue.
- **There are fewer than two or more than three spatial axes.**
- **A level, channel or time point is out of range.** This is checked
  before anything is downloaded.
- **Your copy has only some levels.** Pass `levels: [2, 3]` (the levels you
  have) or `ignoreMissingLevels: true` to `fetchOmeZarr` or `streamOmeZarr`.
- **The server is on another domain** and does not send CORS headers.

A 404 for `zarr.json` in the console when you open a format 2 store is
expected: the loader tries format 3 first. Pass `zarrVersion: 2` to skip
that check.
