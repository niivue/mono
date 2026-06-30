import { describe, expect, test } from 'bun:test'

import { buildDziManifest, parseDziDescriptor } from './dziSource'

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
        expect(t.width).toBeGreaterThan(0)
        expect(t.width).toBeLessThanOrEqual(256)
        expect(t.height).toBeLessThanOrEqual(256)
      }
    }
  })
})
