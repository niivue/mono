import { describe, expect, it } from 'bun:test'
import type { UIKitKeyEvent } from './controls'
import type { RadialMenuItem } from './radialMenu'
import { UIKitRadialMenuOverlay } from './radialMenuOverlay'
import type { UIKitFont } from './text/font'

// Choosing, dismissing and the keyboard never touch the GPU.
const FONT: UIKitFont = {
  metrics: {
    distanceRange: 2,
    size: 50,
    textureSize: [64, 64],
    glyphs: new Map(),
  },
  image: {} as ImageBitmap,
}
const key = (k: string): UIKitKeyEvent => ({
  key: k,
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
})

function make() {
  const chosen: string[] = []
  const menu = new UIKitRadialMenuOverlay(FONT)
  const items: RadialMenuItem[] = [
    { id: 'pen', label: 'Pen', selected: true },
    { id: 'off', label: 'Off', enabled: false },
    { id: 'eraser', label: 'Eraser' },
  ]
  menu.open({ x: 300, y: 300, items, onSelect: (id) => chosen.push(id) })
  const at = (i: number): [number, number] => {
    const f = menu.getLayout()?.items[i]
    if (!f) throw new Error('closed')
    return [f.x + f.width / 2, f.y + f.height / 2]
  }
  return { menu, chosen, at }
}

describe('UIKitRadialMenuOverlay', () => {
  it('chooses the item pressed and lifted on, then closes', () => {
    const { menu, chosen, at } = make()
    expect(menu.isModal()).toBe(true)
    menu.pointerMove(...at(2))
    expect(menu.highlightedIndex).toBe(2)
    expect(menu.pointerDown(...at(2))).toBe(true)
    expect(menu.pointerUp(...at(2))).toBe(true)
    expect(chosen).toEqual(['eraser'])
    expect(menu.isOpen).toBe(false)
  })

  it('ignores a press dragged to another item and a disabled one', () => {
    const { menu, chosen, at } = make()
    menu.pointerDown(...at(0))
    menu.pointerUp(...at(2))
    menu.pointerDown(...at(1))
    menu.pointerUp(...at(1))
    expect(chosen).toEqual([])
    expect(menu.isOpen).toBe(true)
  })

  it('spends a press outside on closing', () => {
    const { menu, chosen } = make()
    expect(menu.pointerDown(300, 300)).toBe(true)
    expect(menu.isOpen).toBe(true)
    expect(menu.pointerDown(5, 5)).toBe(true)
    expect(menu.isOpen).toBe(false)
    expect(menu.pointerDown(5, 5)).toBe(false)
    expect(chosen).toEqual([])
  })

  it('steps over disabled items with the arrows and chooses with Enter', () => {
    const { menu, chosen } = make()
    menu.keyDown(key('ArrowRight'))
    menu.keyDown(key('ArrowRight'))
    expect(menu.highlightedIndex).toBe(2)
    menu.keyDown(key('Enter'))
    expect(chosen).toEqual(['eraser'])
  })

  it('closes on Escape without choosing', () => {
    const { menu, chosen } = make()
    expect(menu.keyDown(key('Escape'))).toBe(true)
    expect(menu.isOpen).toBe(false)
    expect(chosen).toEqual([])
  })
})
