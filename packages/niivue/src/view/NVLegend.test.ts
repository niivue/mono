import { describe, expect, test } from 'bun:test'
import type { NVImage } from '@/NVTypes'
import {
  collectLegendEntries,
  type LegendLayout,
  legendHitTest,
} from './NVLegend'

describe('legendHitTest', () => {
  const layout: LegendLayout = {
    entries: [
      { label: 'a', color: [1, 2, 3, 255] },
      { label: 'b', color: [1, 2, 3, 255] },
    ],
    x: 100,
    y: 50,
    width: 200,
    boxSize: 10,
    gap: 8,
    fontScale: 1,
    textPadding: 8,
    margin: 20,
  }

  test('distinguishesColourBoxFromName', () => {
    // box spans x 120..130; rows are 12 px tall with an 8 px gap
    expect(legendHitTest(125, 55, layout)).toEqual({
      entry: layout.entries[0],
      isOnBox: true,
    })
    expect(legendHitTest(150, 55, layout)?.isOnBox).toBe(false)
    expect(legendHitTest(125, 75, layout)).toEqual({
      entry: layout.entries[1],
      isOnBox: true,
    })
  })

  test('missesOutsideTheLegend', () => {
    expect(legendHitTest(50, 55, layout)).toBeNull()
    expect(legendHitTest(125, 65, layout)).toBeNull() // gap between rows
    expect(legendHitTest(125, 55, null)).toBeNull()
  })
})

describe('collectLegendEntries', () => {
  test('tagsVolumeEntriesAndKeepsHiddenLabelsListed', () => {
    const rgba = new Uint8ClampedArray([0, 0, 0, 0, 9, 9, 9, 255, 8, 8, 8, 255])
    const vol = {
      colormapLabel: { lut: rgba, min: 5, labels: ['bg', 'x', 'y'] },
      hiddenLabels: [7],
    } as unknown as NVImage
    const entries = collectLegendEntries([], [{} as NVImage, vol])
    expect(
      entries.map((e) => [e.label, e.volumeIndex, e.labelValue, e.isHidden]),
    ).toEqual([
      ['x', 1, 6, false],
      ['y', 1, 7, true],
    ])
  })
})
