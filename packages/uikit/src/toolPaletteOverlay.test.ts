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

const key = (k: string) => ({
  key: k,
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
})

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
  })

  it('drops a press whose item an update replaced', () => {
    const chosen: string[] = []
    const palette = new UIKitToolPaletteOverlay(FONT)
    palette.show({
      x: 20,
      y: 300,
      tools: [{ id: 'pen', label: 'Pen', look: 'pen' }],
      tool: 'pen',
      onTool: (id) => chosen.push(id),
    })
    const pen = palette.getLayout()?.items[0]
    if (!pen) throw new Error('hidden')
    const at: [number, number] = [pen.x + pen.width / 2, pen.y + pen.height / 2]
    palette.pointerDown(...at)
    palette.update({
      tools: [{ id: 'eraser', label: 'Erase', look: 'eraser' }],
    })
    palette.pointerUp(...at)
    expect(chosen).toEqual([])
  })

  it('takes focus on a press, then steps over disabled items and chooses with Enter', () => {
    const chosen: string[] = []
    const palette = new UIKitToolPaletteOverlay(FONT)
    palette.show({
      x: 20,
      y: 300,
      actions: [
        { id: 'undo', label: 'Undo', icon: 'undo', enabled: false },
        { id: 'redo', label: 'Redo', icon: 'undo' },
      ],
      tools: [{ id: 'pen', label: 'Pen', look: 'pen' }],
      tool: 'pen',
      onTool: (id) => chosen.push(`tool ${id}`),
      onAction: (id) => chosen.push(`action ${id}`),
    })
    expect(palette.keyDown(key('ArrowRight'))).toBe(false)
    // Press the pen and lift off it: focus without a choice.
    const pen = palette.getLayout()?.items[2]
    if (!pen) throw new Error('no pen')
    palette.pointerDown(pen.x + pen.width / 2, pen.y + pen.height / 2)
    palette.pointerUp(0, 0)
    palette.keyDown(key('ArrowRight'))
    palette.keyDown(key('Enter'))
    palette.keyDown(key('ArrowDown'))
    palette.keyDown(key(' '))
    palette.keyDown(key('ArrowLeft'))
    palette.keyDown(key('ArrowLeft'))
    palette.keyDown(key('Enter'))
    expect(chosen).toEqual(['action redo', 'tool pen', 'tool pen'])
    palette.blur()
    expect(palette.keyDown(key('Enter'))).toBe(false)
  })

  it('never chooses an action that an update disabled', () => {
    const chosen: string[] = []
    const palette = new UIKitToolPaletteOverlay(FONT)
    palette.show({
      x: 20,
      y: 300,
      actions: [{ id: 'undo', label: 'Undo', icon: 'undo' }],
      tools: [],
      tool: '',
      onAction: (id) => chosen.push(id),
    })
    const undo = palette.getLayout()?.items[0]
    if (!undo) throw new Error('no undo')
    const [x, y] = [undo.x + undo.width / 2, undo.y + undo.height / 2]
    palette.pointerMove(x, y)
    palette.pointerDown(x, y)
    palette.pointerUp(x, y)
    palette.update({
      actions: [{ id: 'undo', label: 'Undo', icon: 'undo', enabled: false }],
    })
    const enter = palette.keyDown(key('Enter'))
    expect(enter).toBe(false)
    expect(chosen).toEqual(['undo'])
  })

  it('keeps the highlight on its item when an update moves it', () => {
    const chosen: string[] = []
    const palette = new UIKitToolPaletteOverlay(FONT)
    palette.show({
      x: 20,
      y: 300,
      tools: [{ id: 'pen', label: 'Pen', look: 'pen' }],
      tool: 'pen',
      onTool: (id) => chosen.push(`tool ${id}`),
      onAction: (id) => chosen.push(`action ${id}`),
    })
    const pen = palette.getLayout()?.items[0]
    if (!pen) throw new Error('no pen')
    const [x, y] = [pen.x + pen.width / 2, pen.y + pen.height / 2]
    palette.pointerMove(x, y)
    palette.pointerDown(x, y)
    palette.pointerUp(x, y)
    palette.update({ actions: [{ id: 'undo', label: 'Undo', icon: 'undo' }] })
    palette.keyDown(key('Enter'))
    expect(chosen).toEqual(['tool pen', 'tool pen'])
  })
})
