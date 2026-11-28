import { describe, expect, test } from 'bun:test'
import { parseFont, UBUNTU_FONT_METRICS as ubuntu } from '@niivue/uikit'
import {
  buildTextLayout,
  emptyBatch,
  FLOATS_PER_PANEL,
  packPanels,
} from './NVFont'

describe('packPanels', () => {
  test('packs only batches with a visible backing panel', () => {
    const hidden = emptyBatch()
    const shown = {
      ...emptyBatch(),
      backColor: [1, 0, 0, 0.5],
      backRect: [1, 2, 3, 4],
      backRadius: 5,
      backBorder: 2,
    }
    const panels = packPanels([hidden, shown])
    expect(panels?.length).toBe(FLOATS_PER_PANEL)
    expect(Array.from(panels ?? []).slice(0, 10)).toEqual([
      1, 2, 3, 4, 1, 0, 0, 0.5, 5, 2,
    ])
  })

  test('returns null when no batch has a panel', () => {
    expect(packPanels([emptyBatch()])).toBeNull()
  })
})

// uikit tests the fallback glyph; this checks core's layout draws it.
test('an ASCII-only font lays out ² (the fallback glyph), not nothing', () => {
  const ascii = ubuntu.glyphs.filter((g) => g.unicode < 127)
  const mets = parseFont({ ...ubuntu, glyphs: ascii })
  const layout = (s: string) =>
    buildTextLayout(s, 0, 0, 10, 1, mets, [1, 1, 1, 1], 0, 0, [0, 0, 0, 0])
  expect(layout('mm²').count).toBe(3)
})
