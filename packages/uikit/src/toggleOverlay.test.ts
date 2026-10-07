import { describe, expect, it } from 'bun:test'
import { UIKitControls } from './controls'
import type { UIKitFont, UIKitFontMetrics } from './text/font'
import { UIKitToggleOverlay } from './toggleOverlay'

// State and input handling never touch the GPU, so the overlay is exercised
// headlessly with a stub font (the atlas image is never read).
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

function make() {
  const changes: [string, boolean][] = []
  let redraws = 0
  const overlay = new UIKitToggleOverlay(FONT, {
    requestRedraw: () => redraws++,
  })
  // Two 42x18 toggles: 'a' at (100,50), 'b' at (100,100) starting checked.
  overlay.addToggle({
    id: 'a',
    label: 'Hi',
    x: 100,
    y: 50,
    onChange: (checked, id) => changes.push([id, checked]),
  })
  overlay.addToggle({
    id: 'b',
    label: 'Hi',
    x: 100,
    y: 100,
    checked: true,
    onChange: (checked, id) => changes.push([id, checked]),
  })
  return { overlay, changes, redraws: () => redraws }
}

describe('UIKitToggleOverlay', () => {
  it('lays out and hit-tests toggles by their box plus label', () => {
    const { overlay } = make()
    expect(overlay.ids).toEqual(['a', 'b'])
    expect(overlay.getLayout('a')).toEqual({
      x: 100,
      y: 50,
      width: 42,
      height: 18,
      box: { x: 100, y: 50, size: 18 },
    })
    expect(overlay.hitTest(99, 60)).toBe(false)
    expect(overlay.hitTest(100, 60)).toBe(true)
    expect(overlay.hitTest(141, 67)).toBe(true)
    expect(overlay.hitTest(120, 68)).toBe(false)
  })

  it('flips on release inside the pressed toggle and fires onChange', () => {
    const { overlay, changes } = make()
    expect(overlay.isChecked('a')).toBe(false)
    expect(overlay.pointerDown(110, 60)).toBe(true)
    expect(overlay.pointerMove(112, 61)).toBe(true)
    expect(overlay.pointerUp(112, 61)).toBe(true)
    expect(overlay.isChecked('a')).toBe(true)
    expect(changes).toEqual([['a', true]])
    overlay.pointerDown(110, 60)
    overlay.pointerUp(110, 60)
    expect(overlay.isChecked('a')).toBe(false)
    expect(changes).toEqual([
      ['a', true],
      ['a', false],
    ])
  })

  it('does not flip when released off the toggle, or on cancel', () => {
    const { overlay, changes } = make()
    overlay.pointerDown(110, 60)
    overlay.pointerMove(110, 110) // over 'b', but 'a' owns the press
    expect(overlay.pointerUp(110, 110)).toBe(true)
    expect(overlay.isChecked('a')).toBe(false)
    expect(overlay.isChecked('b')).toBe(true)
    overlay.pointerDown(110, 60)
    overlay.pointerCancel()
    expect(overlay.pointerUp(110, 60)).toBe(false)
    expect(changes).toEqual([])
  })

  it('takes focus on press and flips on Space or Enter', () => {
    const { overlay, changes } = make()
    expect(overlay.focusedToggle).toBeNull()
    expect(overlay.keyDown(key(' '))).toBe(false)
    overlay.pointerDown(110, 110)
    overlay.pointerUp(110, 110)
    expect(overlay.focusedToggle).toBe('b')
    expect(overlay.isChecked('b')).toBe(false)
    expect(overlay.keyDown(key(' '))).toBe(true)
    expect(overlay.isChecked('b')).toBe(true)
    expect(overlay.keyDown(key('Enter'))).toBe(true)
    expect(overlay.isChecked('b')).toBe(false)
    expect(overlay.keyDown(key('a'))).toBe(false)
    expect(changes.length).toBe(3)
    overlay.blur()
    expect(overlay.focusedToggle).toBeNull()
    expect(overlay.keyDown(key(' '))).toBe(false)
  })

  it('ignores a disabled toggle for pointer, keyboard and toggle()', () => {
    const { overlay, changes } = make()
    overlay.focus('a')
    overlay.setEnabled('a', false)
    expect(overlay.focusedToggle).toBeNull()
    expect(overlay.hitTest(110, 60)).toBe(false)
    expect(overlay.pointerDown(110, 60)).toBe(false)
    overlay.focus('a') // refused while disabled
    expect(overlay.focusedToggle).toBeNull()
    expect(overlay.keyDown(key(' '))).toBe(false)
    overlay.toggle('a')
    expect(overlay.isChecked('a')).toBe(false)
    expect(changes).toEqual([])
    overlay.setEnabled('a', true)
    expect(overlay.pointerDown(110, 60)).toBe(true)
  })

  it('setChecked changes state silently; toggle() fires the callback', () => {
    const { overlay, changes, redraws } = make()
    const before = redraws()
    overlay.setChecked('a', true)
    expect(overlay.isChecked('a')).toBe(true)
    expect(changes).toEqual([])
    expect(redraws()).toBe(before + 1)
    overlay.setChecked('a', true)
    expect(redraws()).toBe(before + 1)
    overlay.toggle('a')
    expect(changes).toEqual([['a', false]])
  })

  it('keeps state across a spec update unless the patch sets checked', () => {
    const { overlay } = make()
    overlay.updateToggle('b', { label: 'HH' })
    expect(overlay.isChecked('b')).toBe(true)
    expect(overlay.getLayout('b')?.width).toBe(42)
    overlay.updateToggle('b', { checked: false })
    expect(overlay.isChecked('b')).toBe(false)
  })

  it('hovers only the topmost toggle under the pointer', () => {
    const { overlay, redraws } = make()
    expect(overlay.pointerMove(110, 60)).toBe(false)
    const n = redraws()
    overlay.pointerMove(111, 60) // same toggle: no redraw
    expect(redraws()).toBe(n)
    overlay.pointerMove(-1, -1)
    expect(redraws()).toBe(n + 1)
  })

  it('replaces the set with setToggles and drops stale focus', () => {
    const { overlay } = make()
    overlay.focus('a')
    overlay.setToggles([{ id: 'b', label: 'Hi', x: 0, y: 0 }])
    expect(overlay.ids).toEqual(['b'])
    expect(overlay.focusedToggle).toBeNull()
    expect(overlay.isChecked('b')).toBe(true)
  })
})

function key(k: string) {
  return {
    key: k,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
  }
}

describe('UIKitToggleOverlay in a control layer', () => {
  it("takes the layer's keys when focused from code", () => {
    const { overlay, changes } = make()
    const other = new UIKitToggleOverlay(FONT)
    other.addToggle({ id: 'o', label: 'Hi', x: 100, y: 200 })
    const layer = new UIKitControls().add(other).add(overlay)
    other.focus('o')
    expect(layer.focusedWidget).toBe(other)
    overlay.focus('a')
    expect(layer.focusedWidget).toBe(overlay)
    expect(layer.keyDown(key(' '))).toBe(true)
    expect(changes).toEqual([['a', true]])
    expect(other.isChecked('o')).toBe(false)
  })
})
