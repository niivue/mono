import { describe, expect, it } from 'bun:test'
import type { MenuItemSpec } from './menu'
import { UIKitMenuOverlay } from './menuOverlay'
import type { UIKitFont, UIKitFontMetrics } from './text/font'

// Open/close state, item activation and keyboard navigation never touch the
// GPU, so the overlay is exercised headlessly with a stub font.
const METRICS: UIKitFontMetrics = {
  distanceRange: 2,
  size: 50,
  textureSize: [64, 64],
  glyphs: new Map([
    ['H', { plane: [0.05, 0, 0.4, 0.7], uv: [0, 0, 1, 1], xadv: 0.5 }],
    ['i', { plane: [0.05, 0, 0.1, 0.7], uv: [0, 0, 1, 1], xadv: 0.5 }],
  ]),
}
const FONT: UIKitFont = { metrics: METRICS, image: {} as ImageBitmap }

// Popup rows for menu 'm' (button 100,50 60x28; popup 100,82 120x157):
//   0 'a' action 86..114 | 1 'b' check 114..142 | 2 separator 142..151
//   3 'r1' radio 151..179 | 4 'r2' radio 179..207 | 5 'd' disabled 207..235
const ROW = { a: 100, b: 128, sep: 146, r1: 165, r2: 193, d: 220 }

function make() {
  const selects: string[] = []
  const changes: [string, boolean][] = []
  const itemSelects: string[] = []
  let redraws = 0
  const overlay = new UIKitMenuOverlay(FONT, { requestRedraw: () => redraws++ })
  const items: MenuItemSpec[] = [
    { id: 'a', label: 'Hi', onSelect: (id) => itemSelects.push(id) },
    { id: 'b', label: 'Hi', kind: 'check', shortcut: 'H' },
    { id: 'sep', kind: 'separator' },
    { id: 'r1', label: 'Hi', kind: 'radio', checked: true },
    { id: 'r2', label: 'Hi', kind: 'radio' },
    { id: 'd', label: 'Hi', enabled: false },
  ]
  overlay.addMenu({
    id: 'm',
    label: 'Hi',
    x: 100,
    y: 50,
    items,
    onSelect: (id, menu) => selects.push(`${menu}:${id}`),
    onChange: (id, checked) => changes.push([id, checked]),
  })
  overlay.addMenu({
    id: 'n',
    label: 'Hi',
    x: 200,
    y: 50,
    items: [{ id: 'x', label: 'Hi' }],
    onSelect: (id, menu) => selects.push(`${menu}:${id}`),
  })
  const openByClick = (x = 110, y = 60) => {
    overlay.pointerDown(x, y)
    overlay.pointerUp(x, y)
  }
  return {
    overlay,
    selects,
    changes,
    itemSelects,
    openByClick,
    redraws: () => redraws,
  }
}

function key(k: string) {
  return {
    key: k,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
  }
}

describe('UIKitMenuOverlay', () => {
  it('lays out buttons and hit-tests them, plus the popup while open', () => {
    const { overlay, openByClick } = make()
    expect(overlay.ids).toEqual(['m', 'n'])
    expect(overlay.getLayout('m')).toEqual({
      x: 100,
      y: 50,
      width: 60,
      height: 28,
    })
    expect(overlay.hitTest(110, 60)).toBe(true)
    expect(overlay.hitTest(110, ROW.a)).toBe(false)
    expect(overlay.isModal()).toBe(false)
    openByClick()
    expect(overlay.isModal()).toBe(true)
    expect(overlay.hitTest(110, ROW.a)).toBe(true)
    expect(overlay.hitTest(10, 10)).toBe(false)
    expect(overlay.getPopupLayout()).toMatchObject({
      x: 100,
      y: 82,
      width: 120,
      height: 157,
    })
  })

  it('opens on press, stays open when released over the button, and focuses', () => {
    const { overlay, selects } = make()
    expect(overlay.pointerDown(110, 60)).toBe(true)
    expect(overlay.openMenu).toBe('m')
    expect(overlay.pointerMove(112, 61)).toBe(true)
    expect(overlay.pointerUp(112, 61)).toBe(true)
    expect(overlay.openMenu).toBe('m')
    expect(overlay.focusedMenu).toBe('m')
    expect(overlay.highlightedIndex).toBe(-1)
    expect(selects).toEqual([])
  })

  it('activates an action by press, drag and release', () => {
    const { overlay, selects, itemSelects } = make()
    overlay.pointerDown(110, 60)
    overlay.pointerMove(110, ROW.a)
    expect(overlay.highlightedIndex).toBe(0)
    overlay.pointerUp(110, ROW.a)
    expect(overlay.openMenu).toBeNull()
    expect(itemSelects).toEqual(['a'])
    expect(selects).toEqual(['m:a'])
  })

  it('flips a check item on click and reports it', () => {
    const { overlay, selects, changes, openByClick } = make()
    openByClick()
    expect(overlay.pointerDown(110, ROW.b)).toBe(true)
    expect(overlay.pointerUp(110, ROW.b)).toBe(true)
    expect(overlay.isItemChecked('m', 'b')).toBe(true)
    expect(changes).toEqual([['b', true]])
    expect(selects).toEqual(['m:b'])
    expect(overlay.openMenu).toBeNull()
    openByClick()
    overlay.pointerDown(110, ROW.b)
    overlay.pointerUp(110, ROW.b)
    expect(overlay.isItemChecked('m', 'b')).toBe(false)
    expect(changes).toEqual([
      ['b', true],
      ['b', false],
    ])
  })

  it('moves the radio selection within the group, reporting both ends', () => {
    const { overlay, changes, openByClick } = make()
    openByClick()
    overlay.pointerDown(110, ROW.r2)
    overlay.pointerUp(110, ROW.r2)
    expect(overlay.isItemChecked('m', 'r1')).toBe(false)
    expect(overlay.isItemChecked('m', 'r2')).toBe(true)
    expect(changes).toEqual([
      ['r2', true],
      ['r1', false],
    ])
    openByClick()
    overlay.pointerDown(110, ROW.r2)
    overlay.pointerUp(110, ROW.r2)
    expect(changes.length).toBe(2) // already checked: nothing changes
  })

  it('ignores disabled items and separators, leaving the menu open', () => {
    const { overlay, selects, openByClick } = make()
    openByClick()
    overlay.pointerMove(110, ROW.d)
    expect(overlay.highlightedIndex).toBe(-1)
    overlay.pointerDown(110, ROW.d)
    overlay.pointerUp(110, ROW.d)
    expect(overlay.openMenu).toBe('m')
    overlay.pointerDown(110, ROW.sep)
    overlay.pointerUp(110, ROW.sep)
    expect(overlay.openMenu).toBe('m')
    expect(selects).toEqual([])
  })

  it('closes on an outside press and consumes it, and on a press on its own button', () => {
    const { overlay, selects, openByClick } = make()
    openByClick()
    expect(overlay.pointerDown(10, 10)).toBe(true)
    expect(overlay.openMenu).toBeNull()
    overlay.pointerUp(10, 10)
    expect(selects).toEqual([])
    openByClick()
    expect(overlay.pointerDown(110, 60)).toBe(true)
    expect(overlay.openMenu).toBeNull()
    overlay.pointerUp(110, 60)
    expect(overlay.openMenu).toBeNull()
  })

  it('switches to another menu pressed while one is open', () => {
    const { overlay, openByClick } = make()
    openByClick()
    expect(overlay.pointerDown(210, 60)).toBe(true)
    expect(overlay.openMenu).toBe('n')
    overlay.pointerUp(210, 60)
    expect(overlay.openMenu).toBe('n')
    expect(overlay.getPopupLayout()?.x).toBe(200)
  })

  it('navigates and activates with the keyboard', () => {
    const { overlay, selects } = make()
    expect(overlay.keyDown(key('Enter'))).toBe(false)
    overlay.focus('m')
    expect(overlay.keyDown(key('Enter'))).toBe(true)
    expect(overlay.openMenu).toBe('m')
    expect(overlay.highlightedIndex).toBe(0)
    overlay.keyDown(key('ArrowDown'))
    expect(overlay.highlightedIndex).toBe(1)
    overlay.keyDown(key('ArrowDown'))
    expect(overlay.highlightedIndex).toBe(3) // skips the separator
    overlay.keyDown(key('ArrowUp'))
    expect(overlay.highlightedIndex).toBe(1)
    overlay.keyDown(key('End'))
    expect(overlay.highlightedIndex).toBe(4) // skips the disabled last item
    overlay.keyDown(key('ArrowDown'))
    expect(overlay.highlightedIndex).toBe(0) // wraps
    overlay.keyDown(key('Home'))
    expect(overlay.highlightedIndex).toBe(0)
    expect(overlay.keyDown(key('x'))).toBe(true) // swallowed while open
    overlay.keyDown(key(' '))
    expect(overlay.openMenu).toBeNull()
    expect(selects).toEqual(['m:a'])
    expect(overlay.keyDown(key('ArrowUp'))).toBe(true)
    expect(overlay.highlightedIndex).toBe(4)
    expect(overlay.keyDown(key('Escape'))).toBe(true)
    expect(overlay.openMenu).toBeNull()
    expect(overlay.highlightedIndex).toBe(-1)
    expect(overlay.keyDown(key('x'))).toBe(false)
  })

  it('keeps the pointer highlight in step with the keyboard', () => {
    const { overlay, openByClick } = make()
    openByClick()
    overlay.pointerMove(110, ROW.r1)
    expect(overlay.highlightedIndex).toBe(3)
    overlay.keyDown(key('ArrowDown'))
    expect(overlay.highlightedIndex).toBe(4)
    overlay.pointerMove(10, 10) // leaving the rows keeps the highlight
    expect(overlay.highlightedIndex).toBe(4)
    overlay.keyDown(key('Enter'))
    expect(overlay.isItemChecked('m', 'r2')).toBe(true)
  })

  it('refuses a disabled menu for pointer, keyboard, open() and focus', () => {
    const { overlay } = make()
    overlay.focus('m')
    overlay.setEnabled('m', false)
    expect(overlay.focusedMenu).toBeNull()
    expect(overlay.hitTest(110, 60)).toBe(false)
    expect(overlay.pointerDown(110, 60)).toBe(false)
    overlay.open('m')
    expect(overlay.openMenu).toBeNull()
    overlay.focus('m')
    expect(overlay.keyDown(key('Enter'))).toBe(false)
    overlay.setEnabled('m', true)
    expect(overlay.pointerDown(110, 60)).toBe(true)
  })

  it('setItemChecked is silent and keeps radio groups exclusive', () => {
    const { overlay, changes, selects } = make()
    overlay.setItemChecked('m', 'r2', true)
    expect(overlay.isItemChecked('m', 'r1')).toBe(false)
    expect(overlay.isItemChecked('m', 'r2')).toBe(true)
    overlay.setItemChecked('m', 'b', true)
    expect(overlay.isItemChecked('m', 'b')).toBe(true)
    overlay.setItemChecked('m', 'a', true) // actions have no state
    expect(overlay.isItemChecked('m', 'a')).toBe(false)
    expect(changes).toEqual([])
    expect(selects).toEqual([])
  })

  it('keeps item state across a spec patch, and replaces it with setItems', () => {
    const { overlay, openByClick } = make()
    overlay.setItemChecked('m', 'b', true)
    openByClick()
    overlay.updateMenu('m', { x: 120 })
    expect(overlay.openMenu).toBeNull() // a replaced open menu closes
    expect(overlay.getLayout('m')?.x).toBe(120)
    expect(overlay.isItemChecked('m', 'b')).toBe(true)
    overlay.setItems('m', [{ id: 'z', label: 'Hi', kind: 'check' }])
    expect(overlay.getItems('m').map((i) => i.id)).toEqual(['z'])
    expect(overlay.isItemChecked('m', 'b')).toBe(false)
  })

  it('places the popup inside the bounds it is given', () => {
    const { overlay, openByClick } = make()
    overlay.setBounds({ x: 0, y: 0, width: 400, height: 150 })
    openByClick()
    expect(overlay.getPopupLayout()?.above).toBe(false) // no room above either
    overlay.close()
    overlay.updateMenu('m', { y: 300 })
    overlay.setBounds({ x: 0, y: 0, width: 400, height: 400 })
    overlay.open('m')
    expect(overlay.getPopupLayout()?.above).toBe(true)
    expect(overlay.getPopupLayout()?.y).toBe(300 - 4 - 157)
  })

  it('removes a menu, closing it and dropping its focus', () => {
    const { overlay, openByClick } = make()
    openByClick()
    overlay.removeMenu('m')
    expect(overlay.openMenu).toBeNull()
    expect(overlay.focusedMenu).toBeNull()
    expect(overlay.ids).toEqual(['n'])
    overlay.setMenus([])
    expect(overlay.ids).toEqual([])
  })

  it('hovers only the button under the pointer and redraws on change', () => {
    const { overlay, redraws } = make()
    expect(overlay.pointerMove(110, 60)).toBe(false)
    const n = redraws()
    overlay.pointerMove(111, 60)
    expect(redraws()).toBe(n)
    overlay.pointerMove(-1, -1)
    expect(redraws()).toBe(n + 1)
  })
})
