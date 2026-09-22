# OME-TIFF and plain TIFF stacks

NiiVue reads TIFF directly: no external TIFF library, no WASM. The reader covers
the subset that microscopy and ImageJ actually write, and throws a named error on
anything outside it rather than returning plausible-looking wrong pixels.

Three modules, in layers:

| Module | Responsibility |
| --- | --- |
| `volume/tiff.ts` | The container. Header, IFD walk, tag values, strip/tile assembly, decompression, predictor. Knows nothing about volumes. |
| `volume/omeTiff.ts` | The metadata. OME-XML and ImageJ `ImageDescription` parsing. Knows nothing about pixels. |
| `volume/tiffVolume.ts` | The bridge. Turns IFDs plus metadata into one `{dims, spacing, datatype, img}` volume. |

On top of those sit the two entry points, described under "One volume or many"
below: `volume/readers/tiff.ts` (auto-registered for `.tif`/`.tiff`) and
`volume/omeTiffLoader.ts` (`loadOmeTiffVolumes`).

## What is supported

- Classic TIFF (magic 42) and BigTIFF (magic 43), either byte order.
- Strips (`StripOffsets`/`RowsPerStrip`/`StripByteCounts`) and tiles
  (`TileOffsets`/`TileWidth`/`TileLength`/`TileByteCounts`), including padded
  edge tiles.
- `PlanarConfiguration` 1 (chunky) and 2 (separate planes, de-interleaved on
  read).
- 8, 16, 32 and 64-bit samples; `SampleFormat` 1 (uint), 2 (int) and 3 (float).
- Compression: None (1), LZW (5), Deflate (8 and 32946), PackBits (32773).
- `Predictor` 1 (none) and 2 (horizontal differencing).
- Multiple IFDs, each becoming one z plane.

## What throws

Each of these raises an error naming the cause. None of them silently degrades:

- JPEG-in-TIFF (compression 6, 7 and 34892) and JPEG 2000. These are how
  pyramidal whole-slide images store their tiles; NVSlide handles that case (see
  `docs/dicom-wsi.md`).
- Sub-byte bit depths (1, 2 and 4 bits per sample). Bilevel and paletted TIFFs
  are not scientific image data.
- Mixed `BitsPerSample` across the samples of one pixel.
- `Predictor` 3 (floating-point differencing).

## Metadata

An OME-TIFF is a TIFF whose first IFD carries an OME-XML document in
`ImageDescription`. The XML supplies the 5-D shape that the flat IFD list cannot:

```xml
<Pixels SizeX="512" SizeY="512" SizeZ="40" SizeC="3" SizeT="1"
        DimensionOrder="XYCZT" Type="uint16"
        PhysicalSizeX="0.65" PhysicalSizeXUnit="µm" ...>
  <Channel Name="DAPI" Color="65535"/>
</Pixels>
```

`DimensionOrder` is decoded positionally: the first two letters are always `XY`,
and the remaining three order Z, C and T from fastest-varying to slowest. So
`XYCZT` with `SizeC=2` puts channel 1's slices at IFDs 1, 3, 5, ...

`Color` is a **signed** 32-bit RGBA integer. Green is `16711935` and red is
`-16776961`, so parsing it as unsigned drops every colour whose red component
exceeds 127.

The parse uses a regex attribute scanner, not `DOMParser`. Volume readers must
stay usable outside a browser (the Bun unit harness has no DOM), and only a fixed
handful of attributes matter.

ImageJ writes a different block into the same tag: `key=value` lines starting
with `ImageJ=`. It is parsed too, because it is the only way to recover z-spacing
from an ImageJ-written stack. ImageJ hyperstacks are always ordered XYCZT.

## Spacing is in micrometres

Voxel spacing is reported in micrometres, not millimetres, matching
`allenAtlasSpacing` and OME's own default `PhysicalSize` unit. A 0.65 um pixel
expressed in mm is 0.00065, and voxel sizes that small make scene extents, clip
planes and label sizes behave badly. The common case is an exact passthrough.

Precedence, per axis:

1. OME `PhysicalSizeX/Y/Z` with its unit.
2. In-plane only: `XResolution`/`YResolution`, but only when `ResolutionUnit` is
   a real length (inch or centimetre, not "no unit").
3. Z only: the ImageJ `spacing` field with its `unit`.
4. Anything still unknown falls back to the in-plane size rather than to 1, so a
   stack of sub-micron pixels does not render as a stack of 1 um slabs.

## Rows are not flipped

Row 0 of the TIFF becomes row 0 of the volume. This matches `bmp.ts`,
`decodeImageRGBA` and `allenAtlasLoader.ts`. The Allen microscopy demo was
verified against the Allen IMSC reference viewer with this convention, so
deviating here would put two microscopy loaders in the same scene at odds.

## One volume or many

A multi-channel acquisition does not fit a volume reader's single `{hdr, img}`
return, so there are two entry points:

**`.tif` / `.tiff` reader** (auto-registered, `volume/readers/tiff.ts`). Loads
channel 0 and timepoint 0, logging a warning when the file holds more. This is
what drag-drop and `loadVolumes([{ url: 'stack.tif' }])` use.

**`loadOmeTiffVolumes(url, options)`** (`volume/omeTiffLoader.ts`). Returns one
`ImageFromUrlOptions` per channel, each already assigned a distinct colormap:

```ts
const channels = await loadOmeTiffVolumes(url, { channels: [0, 2] })
await nv.loadVolumes(channels)
```

The file is fetched and its directories parsed once; each channel then decodes
only its own planes. `fetchOmeTiff(url)` exposes that parse on its own, so a
channel picker can be built before committing to the (much larger) decode, and
`omeTiffVolumesFrom(source)` finishes the job without a second download.

Channel colours come from `volume/channelColormaps.ts`, shared with the Allen
atlas loader so the same specimen colours its channels the same way in both
formats: the nearest palette hue to the file's stated `Color`, or the next
palette entry when the file states none.

## Limitations

- **Only the first `<Image>`** of an OME-XML document is described. Multi-scene
  files and the sub-resolution levels of a pyramidal OME-TIFF both need the
  `<TiffData>` IFD map, which is not parsed.
- **Companion files are not followed.** A multi-file OME-TIFF set names its
  siblings in `<TiffData>`; only this file's IFDs are read, and a warning is
  logged when the metadata describes more planes than the file holds.
- **A plane with 3 or 4 8-bit samples becomes an RGBA volume**, matching the 2-D
  image readers. Any other multi-sample plane uses sample 0, because a
  multi-sample scientific plane is a channel stack, not a colour.
- **Deflate uses `DecompressionStream`**, so that one path is not reachable from
  the Bun unit harness (consistent with the documented `codecs/` exclusion). The
  other three compressors are hand-rolled and fully unit-tested.

## Tests

`tiff.test.ts` synthesizes TIFF containers byte by byte rather than shipping
fixtures, so each decoder path can be targeted alone: byte orders, BigTIFF,
multi-strip, tiled with padded edges, planar configuration 2, the predictor, LZW,
PackBits, and every supported sample format. `omeTiff.test.ts` covers the
metadata parse, including all six `DimensionOrder` permutations as a bijection
check. `tiffVolume.test.ts` covers plane selection and spacing precedence.
