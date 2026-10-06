import { describe, expect, it } from 'bun:test'
import { UIKitColorControlOverlay } from './colorControlOverlay'
import type { UIKitKeyEvent } from './controls'
import type { UIKitFont, UIKitFontMetrics } from './text/font'
import type { RGBA } from './text/layout'

// Input handling never touches the GPU, so the overlay is exercised headlessly.
const GLYPH = {
  plane: [0.05, 0, 0.4, 0.7] as [number, number, number, number],
  uv: [0, 0, 1, 1] as [number, number, number, number],
  xadv: 0.5,
}
const METRICS: UIKitFontMetrics = {
  distanceRange: 2,
  size: 50,
  textureSize: [64, 64],
  glyphs: new Map([...'RGBAW'].map((ch) => [ch, GLYPH])),
}
const FONT: UIKitFont = { metrics: METRICS, image: {} as ImageBitmap }

function key(k: string, mods: Partial<UIKitKeyEvent> = {}): UIKitKeyEvent {
  return {
    key: k,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    ...mods,
  }
}

function make() {
  const inputs: RGBA[] = []
  const changes: RGBA[] = []
  let redraws = 0
  const overlay = new UIKitColorControlOverlay(FONT, {
    requestRedraw: () => redraws++,
  })
  // At (0, 0), 220 wide: the R slider's rail runs from x 81 to 214 at y 6,
  // the palette row starts at y 56.
  overlay.addColorControl({
    id: 'c',
    x: 0,
    y: 0,
    width: 220,
    value: [1, 0, 0, 1],
    palette: [
      { name: 'red', color: [1, 0, 0, 1] },
      { name: 'green', color: [0, 1, 0, 1] },
    ],
    onInput: (c) => inputs.push(c),
    onChange: (c) => changes.push(c),
  })
  return { overlay, inputs, changes, redraws: () => redraws }
}

const RAIL = { x0: 81, x1: 214, cy: 6 }
const railX = (t: number) => RAIL.x0 + (RAIL.x1 - RAIL.x0) * t

describe('UIKitColorControlOverlay', () => {
  it('lays the sliders out beside the preview and hit-tests them and the swatches', () => {
    const { overlay } = make()
    const l = overlay.getLayout('c')
    expect(l?.channels[0].slider).toEqual({
      x: 75,
      y: 0,
      width: 145,
      height: 12,
    })
    expect(overlay.hitTest(railX(0.5), RAIL.cy)).toBe(true)
    expect(overlay.hitTest(9, 65)).toBe(true)
    expect(overlay.hitTest(30, 30)).toBe(false)
    expect(overlay.hitTest(500, 500)).toBe(false)
  })

  it('drags a channel slider: onInput per move, onChange on release', () => {
    const { overlay, inputs, changes } = make()
    expect(overlay.pointerDown(railX(0.5), RAIL.cy)).toBe(true)
    expect(inputs).toEqual([[0.5, 0, 0, 1]])
    expect(overlay.focusedControl).toBe('c')
    overlay.pointerMove(railX(0), RAIL.cy)
    expect(inputs.at(-1)).toEqual([0, 0, 0, 1])
    expect(changes).toEqual([])
    expect(overlay.pointerUp(railX(0), RAIL.cy)).toBe(true)
    expect(changes).toEqual([[0, 0, 0, 1]])
    expect(overlay.getValue('c')).toEqual([0, 0, 0, 1])
  })

  it('steps the focused channel with the arrow keys', () => {
    const { overlay, inputs, changes } = make()
    // Press the G slider (second row at y 14..26) at its left end.
    overlay.pointerDown(railX(0), 20)
    overlay.pointerUp(railX(0), 20)
    expect(overlay.keyDown(key('ArrowRight'))).toBe(true)
    expect(inputs.at(-1)).toEqual([1, 0.01, 0, 1])
    expect(changes.at(-1)).toEqual([1, 0.01, 0, 1])
    overlay.keyDown(key('End'))
    expect(overlay.getValue('c')).toEqual([1, 1, 0, 1])
    overlay.blur()
    expect(overlay.focusedControl).toBeNull()
    expect(overlay.keyDown(key('ArrowRight'))).toBe(false)
  })

  it('sets the whole color from a swatch, once, and tracks the hovered swatch', () => {
    const { overlay, inputs, changes, redraws } = make()
    const before = redraws()
    overlay.pointerMove(31, 65)
    expect(redraws()).toBe(before + 1)
    overlay.pointerMove(31, 65)
    expect(redraws()).toBe(before + 1)
    expect(overlay.pointerDown(31, 65)).toBe(true)
    expect(inputs).toEqual([[0, 1, 0, 1]])
    expect(changes).toEqual([[0, 1, 0, 1]])
    // The same swatch again changes nothing.
    overlay.pointerDown(31, 65)
    expect(changes).toHaveLength(1)
    // The sliders follow the swatch.
    overlay.pointerDown(railX(1), 20)
    expect(inputs.at(-1)).toEqual([0, 1, 0, 1])
  })

  it('setValue is silent and feeds the sliders; a disabled control ignores input', () => {
    const { overlay, inputs } = make()
    overlay.setValue('c', [0, 0, 1, 1])
    expect(inputs).toEqual([])
    expect(overlay.getValue('c')).toEqual([0, 0, 1, 1])
    overlay.setEnabled('c', false)
    expect(overlay.hitTest(9, 65)).toBe(false)
    expect(overlay.pointerDown(9, 65)).toBe(false)
    expect(overlay.pointerDown(railX(0.5), RAIL.cy)).toBe(false)
    expect(inputs).toEqual([])
  })

  it('adds and drops the alpha row with the spec, and removes its sliders', () => {
    const { overlay } = make()
    overlay.updateColorControl('c', { alpha: true })
    expect(overlay.getLayout('c')?.channels).toHaveLength(4)
    // The A row is the fourth: y 42..54.
    expect(overlay.hitTest(railX(0.5), 48)).toBe(true)
    overlay.updateColorControl('c', { alpha: false })
    expect(overlay.hitTest(railX(0.5), 48)).toBe(false)
    overlay.removeColorControl('c')
    expect(overlay.ids).toEqual([])
    expect(overlay.hitTest(railX(0.5), RAIL.cy)).toBe(false)
  })
})
