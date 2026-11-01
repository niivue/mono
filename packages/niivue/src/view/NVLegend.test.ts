import { describe, expect, test } from 'bun:test'
import type { NVImage, NVMesh } from '@/NVTypes'
import {
  buildLegendLabels,
  collectLegendEntries,
  computeLegendLayout,
  isInLegend,
  isSameLegendSource,
  type LegendLayout,
  legendHitTest,
  legendScrollHit,
  legendSources,
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
    columns: 1,
    columnWidth: 160,
    rows: 2,
    visibleRows: 2,
    scrollRow: 0,
    rowHeight: 12,
    pitch: 20,
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

const visibleH = (l: LegendLayout) => l.visibleRows * l.pitch - l.gap

describe('large atlases', () => {
  const entries = Array.from({ length: 117 }, (_, i) => ({
    label: `structure_${i}`,
    color: [1, 2, 3, 255] as [number, number, number, number],
  }))

  test('wrapsIntoColumnsAtAFixedFontSize', () => {
    const few = computeLegendLayout(entries.slice(0, 3), 1600, 1000, 0)
    const many = computeLegendLayout(entries, 1600, 1000, 0)
    // The old layout shrank text to fit every entry.
    expect(many?.boxSize).toBe(few?.boxSize)
    expect(many?.columns).toBeGreaterThan(1)
    expect(many?.width).toBeLessThanOrEqual(1600 * 0.4)
  })

  test('scrollsWhenColumnsRunOut', () => {
    const layout = computeLegendLayout(entries, 800, 400, 0, 1e9)
    if (!layout) throw new Error('no layout')
    expect(layout.rows).toBeGreaterThan(layout.visibleRows)
    // Clamped to the last page.
    expect(layout.scrollRow).toBe(layout.rows - layout.visibleRows)
    // The top visible row of column 0 is the entry at scrollRow.
    const top = legendHitTest(
      layout.x + layout.margin + 1,
      layout.y + 1,
      layout,
    )
    expect(top?.entry).toBe(entries[layout.scrollRow])
    // The scrollbar pages up from below the top; elsewhere it is no hit.
    const barX = layout.x + layout.width - layout.margin / 2
    expect(legendScrollHit(barX, layout.y + 1, layout)).toBe(-1)
    expect(
      legendScrollHit(layout.x + layout.margin, layout.y + 1, layout),
    ).toBeNull()
    // On the thumb: consumed (0), so a drag there never reaches the camera.
    const thumbY =
      layout.y + (visibleH(layout) * layout.scrollRow) / layout.rows + 1
    expect(legendScrollHit(barX, thumbY, layout)).toBe(0)
    expect(isInLegend(barX, layout.y + 1, layout)).toBe(true)
    expect(isInLegend(layout.x - 5, layout.y + 1, layout)).toBe(false)
  })

  test('noScrollbarWhenEverythingFits', () => {
    const layout = computeLegendLayout(entries.slice(0, 3), 1600, 1000, 0, 5)
    expect(layout?.scrollRow).toBe(0)
    expect(legendScrollHit(0, 0, layout)).toBeNull()
  })
})

describe('scrolled and multi-column hits', () => {
  const entries = Array.from({ length: 100 }, (_, i) => ({
    label: `s${i}`,
    color: [1, 2, 3, 255] as [number, number, number, number],
  }))
  const noText = () => ({
    data: new Float32Array(0),
    count: 0,
    backColor: [0, 0, 0, 0],
    backRect: [],
    backRadius: 0,
  })

  test('noEmptyCappedColumn', () => {
    // Short canvas: the column cap binds; every reserved column holds entries.
    const l = computeLegendLayout(entries, 1600, 120, 0)
    if (!l) throw new Error('no layout')
    expect((l.columns - 1) * l.rows).toBeLessThan(entries.length)
  })

  test('hitsLaterColumnsAndPagesDown', () => {
    const l = computeLegendLayout(entries, 1000, 200, 0, 2)
    if (!l) throw new Error('no layout')
    expect(l.columns).toBeGreaterThan(1)
    expect(l.scrollRow).toBe(2)
    const x = l.x + l.margin + l.columnWidth + 1
    expect(legendHitTest(x, l.y + 1, l)?.entry).toBe(entries[l.rows + 2])
    // Below the thumb pages down.
    const barX = l.x + l.width - l.margin / 2
    expect(legendScrollHit(barX, l.y + visibleH(l) - 1, l)).toBe(1)
  })

  test('drawsOnlyVisibleEntries', () => {
    const l = computeLegendLayout(entries, 1000, 200, 0)
    if (!l) throw new Error('no layout')
    expect(l.rows).toBeGreaterThan(l.visibleRows) // scrolls: track and thumb
    const batches = buildLegendLabels(l, noText, [0, 0, 0, 1])
    // Backing, track and thumb, then box margin, box and text per entry.
    const shown = Math.min(entries.length, l.columns * l.visibleRows)
    expect(batches.length).toBe(3 + 3 * shown)
  })
})

describe('legend source, which resets the scroll position', () => {
  const atlas = (colormap: string): NVImage =>
    ({
      colormap,
      colormapLabel: {
        lut: new Uint8ClampedArray([9, 9, 9, 255]),
        labels: ['x'],
      },
    }) as unknown as NVImage
  const of = (...volumes: NVImage[]) => legendSources([], volumes)

  test('unchangedByARedrawOrALabelToggle', () => {
    const vol = atlas('a')
    const before = of(vol)
    expect(isSameLegendSource(before, of(vol))).toBe(true)
    vol.hiddenLabels = [0]
    expect(isSameLegendSource(before, of(vol))).toBe(true)
  })

  test('unchangedByAStreamedLabelTableGrowing', () => {
    const vol = atlas('a')
    const before = of(vol)
    vol.colormapLabel = {
      lut: new Uint8ClampedArray(8),
      labels: ['x', 'y'],
    } as NVImage['colormapLabel']
    expect(isSameLegendSource(before, of(vol))).toBe(true)
  })

  test('changedWhenAVolumeLoadsOrGoes', () => {
    const [a, b] = [atlas('a'), atlas('b')]
    expect(isSameLegendSource(of(a), of(a, b))).toBe(false)
    expect(isSameLegendSource(of(a, b), of(a))).toBe(false)
    expect(isSameLegendSource(of(a, b), of(b, a))).toBe(false)
    // A document or reload brings a new volume with an identical table.
    expect(isSameLegendSource(of(a), of(atlas('a')))).toBe(false)
  })

  test('changedWhenTheColormapChanges', () => {
    const vol = atlas('a')
    const before = of(vol)
    vol.colormap = 'b'
    expect(isSameLegendSource(before, of(vol))).toBe(false)
  })

  test('skipsWhatTheLegendSkips', () => {
    const shown = atlas('a')
    const plain = { colormap: 'gray' } as NVImage
    const off = { ...atlas('b'), isLegendVisible: false } as NVImage
    expect(of(shown, plain, off)).toEqual([shown, 'a#0'])
    const lut = { lut: new Uint8ClampedArray(4), labels: ['m'] }
    const layer = { colormapLabel: lut }
    const mesh = { layers: [layer, {}] } as unknown as NVMesh
    expect(legendSources([mesh], [])).toEqual([mesh, layer, lut])
  })
})

describe('layout uses the font it draws with', () => {
  const entries = Array.from({ length: 116 }, (_, i) => ({
    label: i === 40 ? 'a longer structure' : `s${i}`,
    color: [1, 2, 3, 255] as [number, number, number, number],
  }))
  // An estimate of 13 * (1400 * 800 / 480000)^0.4 = 18 px; drawn much larger.
  const fontPx = 40
  const measure = (label: string, scale: number) =>
    label.length * fontPx * scale * 0.5
  const font = { fontPx, measure }

  test('boxesAndRowsFollowTheRealFontSize', () => {
    const l = computeLegendLayout(entries, 1400, 800, 0, 0, font)
    expect(l?.boxSize).toBe(fontPx * 0.8)
    expect(l?.rowHeight).toBeCloseTo(fontPx * 0.8 * 1.2)
    expect(l?.fontScale).toBe(0.8)
  })

  test('aColumnHoldsItsWidestLabel', () => {
    const narrow = {
      fontPx: 22,
      measure: (label: string, scale: number) =>
        label.length * 22 * scale * 0.5,
    }
    const l = computeLegendLayout(entries, 1400, 800, 0, 0, narrow)
    if (!l) throw new Error('no layout')
    expect(l.columns).toBeGreaterThan(1)
    const widest = narrow.measure('a longer structure', 0.8)
    expect(l.columnWidth).toBeGreaterThanOrEqual(
      l.boxSize + l.textPadding + widest,
    )
    // Hit testing reads the same grid: a point past the widest label is the
    // next column's colour box.
    const secondBox = l.margin + l.columnWidth + 1
    const hit = legendHitTest(secondBox, l.y + 1, l)
    expect(hit?.entry).toBe(entries[l.rows])
    expect(hit?.isOnBox).toBe(true)
  })

  test('columnWidthIsMeasuredNotEstimatedFromCharacters', () => {
    const tiny = { fontPx: 18, measure: () => 10 }
    const l = computeLegendLayout(entries, 1400, 800, 0, 0, tiny)
    expect(l?.columnWidth).toBeCloseTo(18 * 0.8 + 8 + 10 + 20)
  })
})
