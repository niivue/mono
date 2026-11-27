import { describe, expect, it } from 'bun:test'
import { UIKitSegmentedOverlay } from './segmentedOverlay'
import type { UIKitFont, UIKitFontMetrics } from './text/font'

// Selection, pointer tracking and keyboard stepping never touch the GPU, so
// the overlay is exercised headlessly with a stub font.
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

// Control 'g' at (100,50): segments 38 wide ('Hi' is 14px + 24 padding) from
// x=102, 24 high from y=52; track 118x28. Segment centres: 121, 159, 197.
const SEG = { a: 121, b: 159, c: 197 }

function make() {
  const changes: string[] = []
  let redraws = 0
  const overlay = new UIKitSegmentedOverlay(FONT, {
    requestRedraw: () => redraws++,
  })
  overlay.addSegmented({
    id: 'g',
    x: 100,
    y: 50,
    segments: [
      { value: 'a', label: 'Hi' },
      { value: 'b', label: 'Hi' },
      { value: 'c', label: 'Hi', enabled: false },
    ],
    value: 'a',
    onChange: (value, id) => changes.push(`${id}:${value}`),
  })
  const click = (x: number, y: number) => {
    overlay.pointerDown(x, y)
    overlay.pointerUp(x, y)
  }
  return { overlay, changes, click, redraws: () => redraws }
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

describe('UIKitSegmentedOverlay', () => {
  it('lays out the track and hit-tests it', () => {
    const { overlay } = make()
    const l = overlay.getLayout('g')
    expect(l).toMatchObject({ x: 100, y: 50, width: 118, height: 28 })
    expect(l?.segments[1]).toEqual({
      index: 1,
      x: 140,
      y: 52,
      width: 38,
      height: 24,
    })
    expect(overlay.hitTest(100, 50)).toBe(true)
    expect(overlay.hitTest(218, 60)).toBe(false)
    expect(overlay.getValue('g')).toBe('a')
    expect(overlay.ids).toEqual(['g'])
  })

  it('selects the pressed segment on release over it and fires onChange once', () => {
    const { overlay, changes, click, redraws } = make()
    const before = redraws()
    expect(overlay.pointerDown(SEG.b, 60)).toBe(true)
    expect(overlay.focusedSegmented).toBe('g')
    expect(redraws()).toBeGreaterThan(before)
    // Releasing over another segment abandons the press.
    expect(overlay.pointerUp(SEG.a, 60)).toBe(true)
    expect(changes).toEqual([])
    expect(overlay.getValue('g')).toBe('a')
    click(SEG.b, 60)
    expect(changes).toEqual(['g:b'])
    expect(overlay.getValue('g')).toBe('b')
    // The current segment again, and a disabled one, are silent.
    click(SEG.b, 60)
    click(SEG.c, 60)
    expect(changes).toEqual(['g:b'])
    expect(overlay.pointerUp(0, 0)).toBe(false)
  })

  it('tracks hover and a pressed pointer leaving and returning', () => {
    const { overlay, redraws } = make()
    expect(overlay.pointerMove(SEG.a, 60)).toBe(false)
    const n = redraws()
    overlay.pointerMove(SEG.a + 1, 60) // same segment: no redraw
    expect(redraws()).toBe(n)
    overlay.pointerMove(SEG.b, 60)
    expect(redraws()).toBe(n + 1)
    overlay.pointerMove(-1, -1)
    expect(redraws()).toBe(n + 2)
    overlay.pointerDown(SEG.b, 60)
    expect(overlay.pointerMove(500, 500)).toBe(true) // held: consumed
    const m = redraws()
    overlay.pointerMove(SEG.b, 60)
    expect(redraws()).toBe(m + 1)
    overlay.pointerCancel()
    expect(overlay.pointerUp(SEG.b, 60)).toBe(false)
    expect(overlay.getValue('g')).toBe('a')
  })

  it('moves the selection with the keyboard while focused, wrapping', () => {
    const { overlay, changes } = make()
    expect(overlay.keyDown(key('ArrowRight'))).toBe(false)
    overlay.focus('g')
    expect(overlay.keyDown(key('ArrowRight'))).toBe(true)
    expect(overlay.getValue('g')).toBe('b')
    overlay.keyDown(key('ArrowRight')) // skips disabled 'c', wraps to 'a'
    expect(overlay.getValue('g')).toBe('a')
    overlay.keyDown(key('ArrowLeft'))
    expect(overlay.getValue('g')).toBe('b')
    overlay.keyDown(key('Home'))
    expect(overlay.getValue('g')).toBe('a')
    overlay.keyDown(key('End'))
    expect(overlay.getValue('g')).toBe('b')
    expect(changes).toEqual(['g:b', 'g:a', 'g:b', 'g:a', 'g:b'])
    expect(overlay.keyDown(key('Enter'))).toBe(false)
    overlay.blur()
    expect(overlay.focusedSegmented).toBeNull()
    expect(overlay.keyDown(key('ArrowRight'))).toBe(false)
  })

  it('sets values silently, drops stale values and refuses when disabled', () => {
    const { overlay, changes, click } = make()
    overlay.setValue('g', 'b')
    expect(overlay.getValue('g')).toBe('b')
    overlay.setValue('g', 'zz')
    expect(overlay.getValue('g')).toBeNull()
    overlay.setValue('g', 'c') // disabled segments can still be set from code
    expect(overlay.getValue('g')).toBe('c')
    overlay.setSegments('g', [{ value: 'x', label: 'Hi' }])
    expect(overlay.getValue('g')).toBeNull()
    expect(overlay.getSegments('g')).toHaveLength(1)
    overlay.select('g', 'x')
    expect(changes).toEqual(['g:x'])
    overlay.setEnabled('g', false)
    expect(overlay.hitTest(110, 60)).toBe(false)
    expect(overlay.pointerDown(110, 60)).toBe(false)
    overlay.focus('g')
    expect(overlay.focusedSegmented).toBeNull()
    overlay.select('g', 'x')
    click(110, 60)
    expect(changes).toEqual(['g:x'])
    overlay.updateSegmented('g', { enabled: true, value: null })
    click(110, 60)
    expect(changes).toEqual(['g:x', 'g:x'])
    overlay.removeSegmented('g')
    expect(overlay.ids).toEqual([])
    expect(overlay.getLayout('g')).toBeNull()
  })
})
