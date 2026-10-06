import { describe, expect, it } from 'bun:test'
import { UIKitSliderOverlay } from './sliderOverlay'
import type { UIKitFont, UIKitFontMetrics } from './text/font'

// Value tracking and input handling never touch the GPU, so the overlay is
// exercised headlessly with a stub font (the atlas image is never read).
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
  const inputs: number[] = []
  const changes: number[] = []
  let redraws = 0
  const overlay = new UIKitSliderOverlay(FONT, {
    requestRedraw: () => redraws++,
  })
  // One 200x34 slider at (100,50): rail 109..291, 0..10 by 1, starting at 2.
  overlay.addSlider({
    id: 's',
    label: 'Hi',
    x: 100,
    y: 50,
    width: 200,
    min: 0,
    max: 10,
    step: 1,
    value: 2,
    onInput: (v) => inputs.push(v),
    onChange: (v) => changes.push(v),
  })
  return { overlay, inputs, changes, redraws: () => redraws }
}

function key(k: string, shiftKey = false) {
  return { key: k, shiftKey, ctrlKey: false, altKey: false, metaKey: false }
}

describe('UIKitSliderOverlay', () => {
  it('snaps the initial value and hit-tests the control box', () => {
    const { overlay } = make()
    expect(overlay.ids).toEqual(['s'])
    expect(overlay.getValue('s')).toBe(2)
    expect(overlay.getLayout('s')?.rail).toEqual({ x0: 109, x1: 291, cy: 74.8 })
    expect(overlay.hitTest(100, 50)).toBe(true)
    expect(overlay.hitTest(299, 83)).toBe(true)
    expect(overlay.hitTest(300, 60)).toBe(false)
    expect(overlay.hitTest(200, 84)).toBe(false)
    overlay.addSlider({
      id: 't',
      x: 0,
      y: 0,
      width: 50,
      min: 0,
      max: 1,
      step: 0.25,
      value: 0.4,
    })
    expect(overlay.getValue('t')).toBe(0.5)
  })

  it('jumps to the press, tracks the drag with onInput, and commits on release', () => {
    const { overlay, inputs, changes } = make()
    expect(overlay.pointerDown(200, 70)).toBe(true)
    expect(overlay.isDragging).toBe(true)
    expect(overlay.getValue('s')).toBe(5)
    expect(overlay.pointerMove(250, 200)).toBe(true) // far below: still dragging
    expect(overlay.getValue('s')).toBe(8)
    expect(overlay.pointerMove(252, 200)).toBe(true) // same step: no input
    expect(overlay.pointerUp(400, 200)).toBe(true)
    expect(overlay.isDragging).toBe(false)
    expect(overlay.getValue('s')).toBe(10)
    expect(inputs).toEqual([5, 8, 10])
    expect(changes).toEqual([10])
  })

  it('fires no onChange when a click leaves the value where it was', () => {
    const { overlay, inputs, changes } = make()
    const x = 109 + 0.2 * 182 // the thumb centre for value 2
    overlay.pointerDown(x, 70)
    overlay.pointerUp(x, 70)
    expect(inputs).toEqual([])
    expect(changes).toEqual([])
  })

  it('ends a cancelled drag where it is and commits any change', () => {
    const { overlay, changes } = make()
    overlay.pointerDown(200, 70)
    overlay.pointerCancel()
    expect(overlay.isDragging).toBe(false)
    expect(overlay.pointerUp(200, 70)).toBe(false)
    expect(changes).toEqual([5])
  })

  it('steps with the keyboard once focused, committing each key', () => {
    const { overlay, inputs, changes } = make()
    expect(overlay.keyDown(key('ArrowRight'))).toBe(false)
    overlay.focus('s')
    expect(overlay.focusedSlider).toBe('s')
    expect(overlay.keyDown(key('ArrowRight'))).toBe(true)
    expect(overlay.getValue('s')).toBe(3)
    expect(overlay.keyDown(key('ArrowUp', true))).toBe(true)
    expect(overlay.getValue('s')).toBe(10)
    expect(overlay.keyDown(key('ArrowLeft'))).toBe(true)
    expect(overlay.getValue('s')).toBe(9)
    expect(overlay.keyDown(key('PageDown'))).toBe(true)
    expect(overlay.getValue('s')).toBe(0)
    expect(overlay.keyDown(key('ArrowDown'))).toBe(true) // at min: consumed, no change
    expect(overlay.keyDown(key('End'))).toBe(true)
    expect(overlay.getValue('s')).toBe(10)
    expect(overlay.keyDown(key('Home'))).toBe(true)
    expect(overlay.getValue('s')).toBe(0)
    expect(overlay.keyDown(key('PageUp'))).toBe(true)
    expect(overlay.getValue('s')).toBe(10)
    expect(overlay.keyDown(key('a'))).toBe(false)
    expect(inputs).toEqual([3, 10, 9, 0, 10, 0, 10])
    expect(changes).toEqual(inputs)
    overlay.blur()
    expect(overlay.keyDown(key('ArrowLeft'))).toBe(false)
  })

  it('takes focus on press', () => {
    const { overlay } = make()
    overlay.pointerDown(200, 70)
    overlay.pointerUp(200, 70)
    expect(overlay.focusedSlider).toBe('s')
  })

  it('ignores a disabled slider for pointer, keyboard and focus', () => {
    const { overlay, inputs } = make()
    overlay.focus('s')
    overlay.setEnabled('s', false)
    expect(overlay.focusedSlider).toBeNull()
    expect(overlay.hitTest(200, 70)).toBe(false)
    expect(overlay.pointerDown(200, 70)).toBe(false)
    overlay.focus('s')
    expect(overlay.keyDown(key('ArrowRight'))).toBe(false)
    expect(inputs).toEqual([])
    overlay.setEnabled('s', true)
    expect(overlay.pointerDown(200, 70)).toBe(true)
  })

  it('setValue is silent and snapped; updateSlider re-snaps a kept value', () => {
    const { overlay, inputs, changes, redraws } = make()
    const n = redraws()
    overlay.setValue('s', 7.4)
    expect(overlay.getValue('s')).toBe(7)
    expect(redraws()).toBe(n + 1)
    overlay.setValue('s', 7)
    expect(redraws()).toBe(n + 1)
    overlay.updateSlider('s', { max: 5 })
    expect(overlay.getValue('s')).toBe(5)
    overlay.updateSlider('s', { value: 1 })
    expect(overlay.getValue('s')).toBe(1)
    expect(inputs).toEqual([])
    expect(changes).toEqual([])
  })

  it('hovers and un-hovers with a redraw each way', () => {
    const { overlay, redraws } = make()
    expect(overlay.pointerMove(200, 70)).toBe(false)
    const n = redraws()
    overlay.pointerMove(201, 70)
    expect(redraws()).toBe(n)
    overlay.pointerMove(-1, -1)
    expect(redraws()).toBe(n + 1)
  })

  it('replaces the set with setSliders and drops stale focus', () => {
    const { overlay } = make()
    overlay.focus('s')
    overlay.setSliders([
      { id: 'u', x: 0, y: 0, width: 50, min: 0, max: 1, value: 0 },
    ])
    expect(overlay.ids).toEqual(['u'])
    expect(overlay.focusedSlider).toBeNull()
  })
})
