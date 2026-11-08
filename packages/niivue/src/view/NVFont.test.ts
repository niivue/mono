import { describe, expect, test } from 'bun:test'
import { emptyBatch, FLOATS_PER_PANEL, packPanels } from './NVFont'

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
