import { describe, expect, it } from 'bun:test'
import type { UIKitFont } from './text/font'
import { UIKitToolPaletteOverlay } from './toolPaletteOverlay'

const FONT: UIKitFont = {
  metrics: {
    distanceRange: 2,
    size: 50,
    textureSize: [64, 64],
    glyphs: new Map(),
  },
  image: {} as ImageBitmap,
}

describe('UIKitToolPaletteOverlay', () => {
  it('chooses what was pressed and lifted on, and holds presses on the tray', () => {
    const chosen: string[] = []
    const palette = new UIKitToolPaletteOverlay(FONT)
    palette.show({
      x: 20,
      y: 300,
      actions: [{ id: 'undo', label: 'Undo', icon: 'undo' }],
      tools: [
        { id: 'pen', label: 'Pen', look: 'pen' },
        { id: 'eraser', label: 'Erase', look: 'eraser' },
      ],
      tool: 'pen',
      colors: [{ id: 'red', label: 'Red', color: [1, 0, 0, 1] }],
      color: 'red',
      onTool: (id) => chosen.push(`tool ${id}`),
      onColor: (id) => chosen.push(`color ${id}`),
      onAction: (id) => chosen.push(`action ${id}`),
    })
    const items = palette.getLayout()?.items ?? []
    const at = (i: number): [number, number] => [
      items[i].x + items[i].width / 2,
      items[i].y + items[i].height / 2,
    ]
    for (const i of [0, 2, 3]) {
      expect(palette.pointerDown(...at(i))).toBe(true)
      palette.pointerUp(...at(i))
    }
    // Pressed on one item and lifted on another chooses nothing.
    palette.pointerDown(...at(1))
    palette.pointerUp(...at(2))
    expect(chosen).toEqual(['action undo', 'tool eraser', 'color red'])
    expect(palette.pointerDown(0, 0)).toBe(false)
    const size = palette.measure()
    expect(size?.height).toBe(56)
    expect(size?.reach).toBeGreaterThan(0)
    palette.update({ tool: 'eraser' })
    expect(palette.isShown).toBe(true)
    palette.hide()
    expect(palette.hitTest(...at(1))).toBe(false)
  })
})
