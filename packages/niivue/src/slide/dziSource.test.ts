import { afterEach, describe, expect, mock, test } from 'bun:test'

import { buildDziManifest, DziSource, parseDziDescriptor } from './dziSource'

const DZI_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Image TileSize="256" Overlap="0" Format="jpeg"
       xmlns="http://schemas.microsoft.com/deepzoom/2008">
  <Size Width="1024" Height="512"/>
</Image>`

describe('parseDziDescriptor', () => {
  test('reads tile size, overlap, format, and dimensions', () => {
    const d = parseDziDescriptor(DZI_XML)
    expect(d.tileSize).toBe(256)
    expect(d.overlap).toBe(0)
    expect(d.format).toBe('jpeg')
    expect(d.width).toBe(1024)
    expect(d.height).toBe(512)
  })

  test('defaults overlap to 0 and throws on a missing size', () => {
    expect(
      parseDziDescriptor(
        '<Image TileSize="256" Format="png"><Size Width="10" Height="10"/></Image>',
      ).overlap,
    ).toBe(0)
    expect(() => parseDziDescriptor('<Image Format="png"/>')).toThrow()
  })
})

describe('buildDziManifest', () => {
  test('refuses a grid over 2^22 tiles before building it', () => {
    const d = {
      tileSize: 1,
      overlap: 0,
      format: 'jpeg',
      width: 2049,
      height: 2048,
    }
    expect(() => buildDziManifest(d, 'huge')).toThrow('over the 4194304')
  })

  test('emits a finest-first pyramid ending at a single-tile level', () => {
    const d = parseDziDescriptor(DZI_XML)
    const { manifest, dziLevelForIndex } = buildDziManifest(d, 'sample')
    const l0 = manifest.levels[0]
    // 1024x512, tile 256 -> maxLevel = ceil(log2(1024)) = 10, full res = level 10.
    expect(l0.width).toBe(1024)
    expect(l0.height).toBe(512)
    expect(l0.columns).toBe(4) // ceil(1024/256)
    expect(l0.rows).toBe(2) // ceil(512/256)
    expect(l0.tiles).toHaveLength(8)
    expect(l0.downsample).toBe(1)
    expect(dziLevelForIndex[0]).toBe(10)
    // Each subsequent level halves; the last one is a single tile.
    const last = manifest.levels[manifest.levels.length - 1]
    expect(last.columns).toBe(1)
    expect(last.rows).toBe(1)
    // downsample grows finest-first.
    for (let i = 1; i < manifest.levels.length; i++) {
      expect(manifest.levels[i].downsample).toBeGreaterThan(
        manifest.levels[i - 1].downsample,
      )
    }
    // Tiles never exceed the tile size, edges are clamped.
    for (const lvl of manifest.levels) {
      for (const t of lvl.tiles) {
        if (!t) throw new Error('a DZI level has no holes')
        expect(t.width).toBeGreaterThan(0)
        expect(t.width).toBeLessThanOrEqual(256)
        expect(t.height).toBeLessThanOrEqual(256)
      }
    }
  })
})

describe('DziSource.fromUrl', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('keeps the descriptor query on tile URLs and drops the fragment', async () => {
    const urls: string[] = []
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      urls.push(String(url))
      return new Response(urls.length === 1 ? DZI_XML : new Uint8Array([1]))
    }) as unknown as typeof fetch
    const source = await DziSource.fromUrl(
      'https://example.org/a/image.dzi?v=1&t=x?y#frag',
    )
    const level = source.manifest.levels[0]
    const tile = level?.tiles[0]
    if (!level || !tile) throw new Error('no tile')
    await source.fetchTileBytes(level, tile, 'L0')

    expect(source.manifest.name).toBe('image (DZI)')
    expect(urls[1]).toBe(
      `https://example.org/a/image_files/10/0_0.jpg?v=1&t=x?y`,
    )
  })
})
