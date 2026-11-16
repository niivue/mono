import { describe, expect, test } from 'bun:test'
import { drawOpacities, labelStats, panelColormap } from './segPanel'

describe('segPanel', () => {
  test('labelStats_countsAndCentroidsPerLabel', () => {
    // 2x2x2: label 3 at (1,0,0) and (1,1,1); label 7 at (0,1,0).
    const bitmap = new Uint8Array([0, 3, 7, 0, 0, 0, 0, 3])
    const stats = labelStats(bitmap, [2, 2, 2])
    expect(stats.get(3)).toEqual({ count: 2, centroid: [1, 0.5, 0.5] })
    expect(stats.get(7)).toEqual({ count: 1, centroid: [0, 1, 0] })
    expect(stats.size).toBe(2)
  })

  test('drawOpacities_mapsFillOutlineModes', () => {
    expect(drawOpacities({ fillAlpha: 0.3, outlineOpacity: 0.8 })).toEqual({
      fill: 0.3,
      rim: 0.8,
    })
    expect(drawOpacities({ renderOutline: false, fillAlpha: 0.3 })).toEqual({
      fill: 0.3,
      rim: -1,
    })
    // Outline only: a nonzero fill keeps the shader drawing the rim.
    expect(drawOpacities({ renderFill: false })).toEqual({
      fill: 1 / 255,
      rim: 1,
    })
    expect(drawOpacities({ renderFill: false, renderOutline: false })).toEqual({
      fill: 0,
      rim: -1,
    })
  })

  test('panelColormap_hiddenSegmentIsTransparent', () => {
    const cmap = panelColormap([
      { value: 2, label: 'A', color: [1, 2, 3, 200], visible: true },
      { value: 5, label: 'B', color: [4, 5, 6, 255], visible: false },
    ])
    expect(cmap).toEqual({
      R: [0, 1, 4],
      G: [0, 2, 5],
      B: [0, 3, 6],
      A: [0, 200, 0],
      I: [0, 2, 5],
      labels: ['', 'A', 'B'],
    })
  })
})
