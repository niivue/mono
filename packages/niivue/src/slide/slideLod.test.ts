import { describe, expect, test } from 'bun:test'
import type { NVSlideLevelManifest } from './NVSlide'
import { pickLevel } from './slideLod'

const level = (index: number, downsample: number): NVSlideLevelManifest => ({
  index,
  width: 1024 / downsample,
  height: 1024 / downsample,
  downsample,
  columns: 1,
  rows: 1,
  tiles: [null],
})

describe('pickLevel', () => {
  test('hysteresis holds a level from a replaced manifest by its index', () => {
    const levels = [level(0, 1), level(1, 2)]
    // A plane switch replaces the level objects; the held level is an old copy.
    const held = level(0, 1)
    expect(pickLevel(levels, 0.95, 1, null)).toBe(levels[1])
    expect(pickLevel(levels, 0.95, 1, held)).toBe(levels[0])
  })
})
