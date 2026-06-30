// TIFF/SVS slide source for NVSlide, used by the slides demo.
//
// Aperio SVS (and pyramidal/BigTIFF) decoding — IFD walking, tiled JPEG with the
// shared JPEGTables tag, YCbCr->RGB — is offloaded to geotiff.js, which streams
// the file by HTTP Range and decodes one tile at a time. This is a heavy
// dependency, so it lives in the demo (a geotiff-backed SlideTileSource) rather
// than the niivue core. NVSlide draws the resulting raw-rgba tiles.
//
// Fetch a sample SVS into public/svs/ (the server has no CORS, so it must be
// served same-origin), e.g. OpenSlide's Aperio CMU-1-Small-Region.svs:
//   curl -o public/svs/CMU-1-Small-Region.svs \
//     https://openslide.cs.cmu.edu/download/openslide-testdata/Aperio/CMU-1-Small-Region.svs
import { fromUrl } from 'geotiff'

// Build a SlideTileSource (manifest + bind + fetchTileBytes) backed by geotiff.
export async function createTiffSource(svsUrl, id) {
  const tiff = await fromUrl(svsUrl)
  const count = await tiff.getImageCount()
  const images = []
  for (let i = 0; i < count; i++) {
    const img = await tiff.getImage(i)
    // Only tiled images are pyramid levels; SVS thumbnail/label/macro are stripped.
    if (img.isTiled) images.push(img)
  }
  if (images.length === 0) {
    throw new Error('No tiled pyramid levels found in the TIFF')
  }
  images.sort((a, b) => b.getWidth() - a.getWidth())
  const l0Width = images[0].getWidth()
  const levels = images.map((img, index) => {
    const width = img.getWidth()
    const height = img.getHeight()
    const tileWidth = img.getTileWidth()
    const tileHeight = img.getTileHeight()
    const columns = Math.ceil(width / tileWidth)
    const rows = Math.ceil(height / tileHeight)
    const tiles = []
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < columns; col++) {
        tiles.push({
          x: col,
          y: row,
          width: Math.min(tileWidth, width - col * tileWidth),
          height: Math.min(tileHeight, height - row * tileHeight),
        })
      }
    }
    return {
      index,
      width,
      height,
      downsample: l0Width / width,
      tileWidth,
      tileHeight,
      columns,
      rows,
      codec: 'raw-rgba',
      tiles,
    }
  })
  const name = id ?? svsUrl.replace(/^.*\//, '').replace(/\.[^.]+$/, '')
  const manifest = {
    id: name,
    name: `${name} (TIFF/SVS)`,
    format: 'tiff',
    width: images[0].getWidth(),
    height: images[0].getHeight(),
    tileSize: images[0].getTileWidth(),
    dtype: 'uint8',
    channels: 'encoded-rgb',
    displayYAxis: 'down',
    levels,
  }

  let host = null
  return {
    manifest,
    bind(h) {
      host = h
    },
    async fetchTileBytes(level, tile, label) {
      host?.pushRangeEvent({ label, status: 'pending' })
      try {
        const img = images[level.index]
        const x0 = tile.x * img.getTileWidth()
        const y0 = tile.y * img.getTileHeight()
        // geotiff fetches only the tile(s) overlapping the window via Range.
        const data = await img.readRasters({
          window: [x0, y0, x0 + tile.width, y0 + tile.height],
          interleave: true,
        })
        const spp = img.getSamplesPerPixel()
        const pixels = tile.width * tile.height
        const rgba = new Uint8Array(pixels * 4)
        if (spp >= 3) {
          for (let i = 0; i < pixels; i++) {
            rgba[i * 4] = data[i * spp]
            rgba[i * 4 + 1] = data[i * spp + 1]
            rgba[i * 4 + 2] = data[i * spp + 2]
            rgba[i * 4 + 3] = 255
          }
        } else {
          for (let i = 0; i < pixels; i++) {
            const v = data[i]
            rgba[i * 4] = v
            rgba[i * 4 + 1] = v
            rgba[i * 4 + 2] = v
            rgba[i * 4 + 3] = 255
          }
        }
        host?.addWireBytes(rgba.length)
        host?.updateRangeEvent(label, 'hit')
        return rgba
      } catch (err) {
        host?.updateRangeEvent(label, 'failed')
        throw err
      }
    },
  }
}
