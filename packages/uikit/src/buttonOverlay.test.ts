import { describe, expect, it } from 'bun:test'
import { UIKitButtonOverlay } from './buttonOverlay'
import type { UIKitFont, UIKitFontMetrics } from './text/font'

// Pointer handling and the press animation never touch the GPU, so the overlay
// is exercised here headlessly with a stub font (the atlas image is never read)
// and a hand-driven clock.
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
  let t = 1000
  const redraws: number[] = []
  const clicks: string[] = []
  const overlay = new UIKitButtonOverlay(FONT, {
    now: () => t,
    requestRedraw: () => redraws.push(t),
    style: { textSizePx: 20, paddingX: 10, paddingY: 5 },
  })
  // Two 40x24 buttons: 'a' at (100,50), 'b' at (200,50).
  overlay.addButton({
    id: 'a',
    label: 'Hi',
    x: 100,
    y: 50,
    onClick: (id) => clicks.push(id),
  })
  overlay.addButton({
    id: 'b',
    label: 'Hi',
    x: 200,
    y: 50,
    onClick: (id) => clicks.push(id),
  })
  // Drive one overlay frame without a GPU: the private tick is what drawOverlay
  // calls before drawing, so step the clock and call it through the public
  // surface of a frame whose draws are no-ops (no entries would skip them, so
  // the stub frame is given a backend the rect/text overlays refuse to touch).
  const advance = (ms: number) => {
    t += ms
    return overlay.tickForTest()
  }
  return { overlay, redraws, clicks, advance, clock: () => t }
}

describe('UIKitButtonOverlay pointer handling', () => {
  it('lays out and hit-tests buttons by their resting box', () => {
    const { overlay } = make()
    expect(overlay.ids).toEqual(['a', 'b'])
    expect(overlay.getLayout('a')).toEqual({
      x: 100,
      y: 50,
      width: 40,
      height: 24,
    })
    expect(overlay.pointerDown(99, 60)).toBe(false)
    expect(overlay.pointerDown(100, 60)).toBe(true)
    overlay.pointerCancel()
  })

  it('fires a click on up inside the button that was pressed', () => {
    const { overlay, clicks } = make()
    expect(overlay.pointerDown(110, 60)).toBe(true)
    expect(overlay.pointerMove(115, 62)).toBe(true) // held: consumed
    expect(overlay.pointerUp(115, 62)).toBe(true)
    expect(clicks).toEqual(['a'])
  })

  it('does not click when the pointer is released off the button', () => {
    const { overlay, clicks } = make()
    overlay.pointerDown(110, 60)
    overlay.pointerMove(210, 60) // over 'b', but 'a' owns the press
    overlay.pointerUp(210, 60)
    expect(clicks).toEqual([])
    // ...and 'b' never became pressed; a fresh down on it still works.
    expect(overlay.pointerDown(210, 60)).toBe(true)
    overlay.pointerUp(210, 60)
    expect(clicks).toEqual(['b'])
  })

  it('tracks hover only while no press is held', () => {
    const { overlay, redraws } = make()
    const before = redraws.length
    expect(overlay.pointerMove(110, 60)).toBe(false)
    expect(overlay.hovering).toBe(true)
    expect(redraws.length).toBe(before + 1) // hover change asks for a frame
    overlay.pointerMove(110, 60)
    expect(redraws.length).toBe(before + 1) // same state: no extra frame
    overlay.pointerMove(-1, -1)
    expect(overlay.hovering).toBe(false)
  })

  it('ignores disabled buttons for the pointer', () => {
    const { overlay, clicks } = make()
    overlay.setEnabled('a', false)
    expect(overlay.pointerDown(110, 60)).toBe(false)
    overlay.pointerMove(110, 60)
    expect(overlay.hovering).toBe(false)
    overlay.click('a')
    expect(clicks).toEqual([])
  })

  it('picks the topmost (last added) of overlapping buttons', () => {
    const { overlay, clicks } = make()
    overlay.addButton({
      id: 'c',
      label: 'Hi',
      x: 100,
      y: 50,
      onClick: (id) => clicks.push(id),
    })
    overlay.pointerDown(110, 60)
    overlay.pointerUp(110, 60)
    expect(clicks).toEqual(['c'])
  })

  it('removes and replaces buttons', () => {
    const { overlay } = make()
    overlay.removeButton('a')
    expect(overlay.ids).toEqual(['b'])
    overlay.setButtons([{ id: 'z', label: 'Hi', x: 0, y: 0 }])
    expect(overlay.ids).toEqual(['z'])
    overlay.updateButton('z', { x: 300 })
    expect(overlay.getLayout('z')?.x).toBe(300)
  })
})

describe('UIKitButtonOverlay press animation', () => {
  it('runs the press up on down and back down on up, asking for frames', () => {
    const { overlay, advance } = make()
    overlay.pointerDown(110, 60)
    // Default pressMs is 90: after 45 ms the press is half way.
    expect(advance(45)).toBe(true)
    expect(overlay.pressOf('a')).toBeCloseTo(0.5)
    expect(advance(100)).toBe(false) // reached 1: nothing left to animate
    expect(overlay.pressOf('a')).toBe(1)
    overlay.pointerUp(110, 60)
    // Default releaseMs is 160: after 80 ms, half way back.
    expect(advance(80)).toBe(true)
    expect(overlay.pressOf('a')).toBeCloseTo(0.5)
    expect(advance(80)).toBe(false)
    expect(overlay.pressOf('a')).toBe(0)
  })

  it('releases the face while the pointer strays off a held button', () => {
    const { overlay, advance } = make()
    overlay.pointerDown(110, 60)
    advance(200)
    expect(overlay.pressOf('a')).toBe(1)
    overlay.pointerMove(500, 500)
    advance(200)
    expect(overlay.pressOf('a')).toBe(0)
    overlay.pointerMove(110, 60)
    advance(200)
    expect(overlay.pressOf('a')).toBe(1)
    overlay.pointerCancel()
    advance(200)
    expect(overlay.pressOf('a')).toBe(0)
  })

  it('plays a full press-and-release pulse for a programmatic click', () => {
    const { overlay, clicks, advance } = make()
    overlay.click('b')
    expect(clicks).toEqual(['b'])
    expect(advance(90)).toBe(true)
    expect(overlay.pressOf('b')).toBe(1)
    // The next frame flips the pulse to release and keeps animating.
    expect(advance(80)).toBe(true)
    expect(overlay.pressOf('b')).toBeCloseTo(0.5)
    expect(advance(80)).toBe(false)
    expect(overlay.pressOf('b')).toBe(0)
  })

  it('does not jump when a frame arrives long after the last one', () => {
    const { overlay, advance } = make()
    overlay.pointerDown(110, 60)
    advance(200) // settles at 1 and clears the clock
    overlay.pointerUp(110, 60)
    advance(1) // press and release durations are measured from the up, not before
    expect(overlay.pressOf('a')).toBeGreaterThan(0.99)
  })
})
