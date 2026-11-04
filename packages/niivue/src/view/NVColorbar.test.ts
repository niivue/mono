import { describe, expect, test } from 'bun:test'
import { type ColorbarLayout, colorbarGridLayout } from './NVColorbar'

describe('colorbarGridLayout', () => {
  test('anOriginShiftsTheBarsIntoTheInsetArea', () => {
    const layout: ColorbarLayout = {
      margin: 20,
      heightRatio: 1.2,
      gap: 8,
      canvasWidth: 600,
      canvasHeight: 400,
      borderColor: [0, 0, 0, 1],
      fontPx: 0,
    }
    const bars = [{ colormapName: 'gray', min: 0, max: 100 }]
    const [plain] = colorbarGridLayout(bars, layout).rects
    const [moved] = colorbarGridLayout(bars, {
      ...layout,
      originX: 200,
      originY: 30,
    }).rects
    expect(moved).toEqual({ ...plain, x: plain.x + 200, y: plain.y + 30 })
  })
})
