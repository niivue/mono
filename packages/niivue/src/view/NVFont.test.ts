import { describe, expect, test } from 'bun:test'
import ubuntu from '../assets/fonts/Ubuntu.json'
import {
  buildTextLayout,
  emptyBatch,
  FLOATS_PER_PANEL,
  packPanels,
  parseFontMetrics,
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

test('an ASCII-only font draws ² as a small raised 2, not nothing', () => {
  const mets = parseFontMetrics(ubuntu)
  const two = mets.mets[0x32]
  const sup = mets.mets[0xb2]
  expect(sup?.uv_lbwh).toEqual(two?.uv_lbwh)
  expect(sup?.xadv).toBeCloseTo((two?.xadv ?? 0) * 0.6)
  expect(sup?.lbwh[1]).toBeGreaterThan(two?.lbwh[1] ?? 0)
  const layout = (s: string) =>
    buildTextLayout(s, 0, 0, 10, 1, mets, [1, 1, 1, 1], 0, 0, [0, 0, 0, 0])
  expect(layout('mm²').count).toBe(3)
})
