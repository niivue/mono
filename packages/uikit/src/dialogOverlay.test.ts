import { describe, expect, it } from 'bun:test'
import type { UIKitOverlayFrame } from '@niivue/niivue'
import type { UIKitInteractive, UIKitKeyEvent } from './controls'
import { DEFAULT_DIALOG_STYLE, type DialogBoxes } from './dialog'
import { UIKitDialogOverlay } from './dialogOverlay'
import type { UIKitFont, UIKitFontMetrics } from './text/font'

// Opening, routing and closing never touch the GPU, so the overlay is driven
// headlessly: `setBounds` stands in for the frame the draw hook would bring.
const GLYPH = {
  plane: [0.05, 0, 0.4, 0.7] as [number, number, number, number],
  uv: [0, 0, 1, 1] as [number, number, number, number],
  xadv: 0.5,
}
const METRICS: UIKitFontMetrics = {
  distanceRange: 2,
  size: 50,
  textureSize: [64, 64],
  glyphs: new Map(
    [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ .,'].map((ch) => [
      ch,
      GLYPH,
    ]),
  ),
}
const FONT: UIKitFont = { metrics: METRICS, image: {} as ImageBitmap }
const STYLE = DEFAULT_DIALOG_STYLE

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

/** A hosted widget stub: a box that takes presses, focus and keys. */
class Child implements UIKitInteractive {
  readonly log: string[] = []
  modal = false
  constructor(
    private readonly box: { x: number; y: number; w: number; h: number },
  ) {}
  hitTest(x: number, y: number): boolean {
    const b = this.box
    return x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h
  }
  pointerDown(x: number, y: number): boolean {
    if (!this.hitTest(x, y)) return false
    this.log.push('down')
    return true
  }
  pointerMove(x: number, _y: number): boolean {
    this.log.push(x < 0 ? 'leave' : 'move')
    return true
  }
  pointerUp(): boolean {
    this.log.push('up')
    return true
  }
  pointerCancel(): void {
    this.log.push('cancel')
  }
  /**
   * Takes 'x', Enter (a field committing) and, while modal, Escape and Enter
   * (a popup closing or choosing), like a select.
   */
  keyDown(e: UIKitKeyEvent): boolean {
    this.log.push(`key:${e.key}`)
    if (e.key === 'Escape' && this.modal) {
      this.modal = false
      return true
    }
    return e.key === 'x' || e.key === 'Enter'
  }
  wheel(): boolean {
    this.log.push('wheel')
    return true
  }
  blur(): void {
    this.log.push('blur')
  }
  isModal(): boolean {
    return this.modal
  }
  dismiss(): void {
    this.log.push('dismiss')
    this.modal = false
  }
  drawOverlay(_frame: UIKitOverlayFrame): void {}
}

function make() {
  const closed: (string | null)[] = []
  const layouts: DialogBoxes[] = []
  let redraws = 0
  const overlay = new UIKitDialogOverlay(FONT, {
    requestRedraw: () => redraws++,
    now: () => 0,
  })
  overlay.setBounds({ width: 800, height: 600 })
  overlay.addDialog({
    id: 'd',
    title: 'Title',
    message: 'Body',
    contentHeight: 40,
    buttons: [
      { id: 'cancel', label: 'Cancel', role: 'cancel' },
      { id: 'ok', label: 'OK', role: 'default' },
    ],
    onLayout: (boxes) => layouts.push(boxes),
    onClose: (result) => closed.push(result),
  })
  return { overlay, closed, layouts, redraws: () => redraws }
}

describe('UIKitDialogOverlay', () => {
  it('is modal only while open and reports its boxes once per placement', () => {
    const { overlay, layouts } = make()
    expect(overlay.isModal()).toBe(false)
    expect(overlay.hitTest(1, 1)).toBe(false)
    overlay.open('d')
    expect(overlay.isModal()).toBe(true)
    expect(overlay.hitTest(1, 1)).toBe(true)
    const boxes = overlay.getBoxes('d')
    expect(boxes).not.toBeNull()
    expect(boxes?.panel.width).toBe(STYLE.width)
    expect(boxes?.content.height).toBe(40)
    overlay.getBoxes('d')
    expect(layouts).toHaveLength(1)
    // A resize moves the centered panel and reports again.
    overlay.setBounds({ width: 1000, height: 600 })
    overlay.getBoxes('d')
    expect(layouts).toHaveLength(2)
    expect(layouts[1].panel.x).toBe(layouts[0].panel.x + 100)
  })

  it('closes with a button id on a press, Enter and Escape', () => {
    const { overlay, closed } = make()
    overlay.open('d')
    const boxes = overlay.getBoxes('d')
    if (!boxes) throw new Error('no layout')
    // The default button is the rightmost: 44 wide, 28 tall at the bottom right.
    const right = boxes.panel.x + boxes.panel.width - STYLE.padding
    const bottom = boxes.panel.y + boxes.panel.height - STYLE.padding
    expect(overlay.pointerDown(right - 10, bottom - 10)).toBe(true)
    expect(overlay.pointerUp(right - 10, bottom - 10)).toBe(true)
    expect(closed).toEqual(['ok'])
    expect(overlay.isModal()).toBe(false)

    overlay.open('d')
    expect(overlay.keyDown(key('Enter'))).toBe(true)
    expect(closed).toEqual(['ok', 'ok'])
    overlay.open('d')
    expect(overlay.keyDown(key('Escape'))).toBe(true)
    expect(closed).toEqual(['ok', 'ok', 'cancel'])
  })

  it('Escape closes with null without a cancel button, Enter does nothing without a default', () => {
    const { overlay, closed } = make()
    overlay.updateDialog('d', { buttons: [{ id: 'later', label: 'Later' }] })
    overlay.open('d')
    expect(overlay.keyDown(key('Enter'))).toBe(true)
    expect(closed).toEqual([])
    expect(overlay.isModal()).toBe(true)
    expect(overlay.keyDown(key('Escape'))).toBe(true)
    expect(closed).toEqual([null])
  })

  it('swallows presses on the panel and scrim, closing on the scrim only when allowed', () => {
    const { overlay, closed } = make()
    overlay.open('d')
    const boxes = overlay.getBoxes('d')
    if (!boxes) throw new Error('no layout')
    expect(overlay.pointerDown(boxes.panel.x + 2, boxes.panel.y + 2)).toBe(true)
    expect(overlay.pointerUp(boxes.panel.x + 2, boxes.panel.y + 2)).toBe(true)
    expect(overlay.pointerDown(1, 1)).toBe(true)
    overlay.pointerUp(1, 1)
    expect(overlay.isModal()).toBe(true)
    expect(closed).toEqual([])
    expect(overlay.keyDown(key('a'))).toBe(true)
    expect(overlay.wheel(1, 1, 0, 10)).toBe(true)

    overlay.updateDialog('d', { closeOnScrim: true })
    overlay.open('d')
    overlay.pointerDown(1, 1)
    expect(closed).toEqual([null])
  })

  it('routes the pointer, focus and keys to hosted children', () => {
    const { overlay, closed } = make()
    const a = new Child({ x: 300, y: 300, w: 50, h: 20 })
    const b = new Child({ x: 400, y: 300, w: 50, h: 20 })
    overlay.addChild('d', a)
    overlay.addChild('d', b)
    overlay.open('d')
    expect(overlay.pointerDown(310, 310)).toBe(true)
    expect(a.log).toEqual(['down'])
    overlay.pointerMove(320, 310)
    overlay.pointerUp(320, 310)
    expect(a.log.slice(1)).toEqual(['move', 'up', 'move'])
    // The focused child sees keys first; what it declines falls to the dialog.
    expect(overlay.keyDown(key('x'))).toBe(true)
    expect(a.log.at(-1)).toBe('key:x')
    expect(overlay.keyDown(key('q'))).toBe(true)
    expect(overlay.isModal()).toBe(true)
    // Enter in a focused field commits it and still submits the dialog.
    expect(overlay.keyDown(key('Enter'))).toBe(true)
    expect(a.log.at(-2)).toBe('key:Enter')
    expect(closed).toEqual(['ok'])
    overlay.open('d')
    overlay.pointerDown(310, 310)
    overlay.pointerUp(310, 310)
    // A press on another child moves focus; a press on the panel drops it.
    overlay.pointerDown(410, 310)
    expect(a.log.at(-1)).toBe('blur')
    expect(b.log.at(-1)).toBe('down')
    overlay.pointerUp(410, 310)
    overlay.pointerDown(250, 250)
    expect(b.log.at(-1)).toBe('blur')
    expect(overlay.hoverCursor).toBe('default')
  })

  it('gives a modal child every event first and dismisses it on close', () => {
    const { overlay, closed } = make()
    const a = new Child({ x: 300, y: 300, w: 50, h: 20 })
    const b = new Child({ x: 400, y: 300, w: 50, h: 20 })
    overlay.addChild('d', a)
    overlay.addChild('d', b)
    overlay.open('d')
    a.modal = true
    expect(overlay.pointerDown(410, 310)).toBe(true)
    expect(b.log).toEqual([])
    // A modal child keeps Enter: choosing an option is not submitting.
    expect(overlay.keyDown(key('Enter'))).toBe(true)
    expect(closed).toEqual([])
    expect(overlay.keyDown(key('Escape'))).toBe(true)
    expect(a.log.at(-1)).toBe('key:Escape')
    expect(closed).toEqual([])
    expect(a.modal).toBe(false)
    a.modal = true
    overlay.wheel(410, 310, 0, 5)
    expect(a.log.at(-1)).toBe('wheel')
    overlay.close('ok')
    expect(a.log.at(-1)).toBe('dismiss')
    expect(closed).toEqual(['ok'])
  })

  it('dismiss and blur only blur the children; the dialog stays open', () => {
    const { overlay, closed } = make()
    const a = new Child({ x: 300, y: 300, w: 50, h: 20 })
    overlay.addChild('d', a)
    overlay.open('d')
    overlay.pointerDown(310, 310)
    overlay.pointerUp(310, 310)
    overlay.dismiss()
    expect(a.log.at(-1)).toBe('blur')
    expect(overlay.isModal()).toBe(true)
    expect(closed).toEqual([])
  })

  it('opens one dialog at a time and removes an open dialog by closing it', () => {
    const { overlay, closed } = make()
    overlay.addDialog({ id: 'e', title: 'Other' })
    overlay.open('d')
    overlay.open('e')
    expect(closed).toEqual([null])
    expect(overlay.openDialog).toBe('e')
    overlay.removeDialog('e')
    expect(overlay.openDialog).toBeNull()
    expect(overlay.ids).toEqual(['d'])
  })

  it('clicks a button from code and ignores a disabled one', () => {
    const { overlay, closed } = make()
    overlay.updateDialog('d', {
      buttons: [
        { id: 'no', label: 'No', enabled: false },
        { id: 'ok', label: 'OK', role: 'default' },
      ],
    })
    overlay.open('d')
    overlay.click('no')
    expect(closed).toEqual([])
    overlay.click('ok')
    expect(closed).toEqual(['ok'])
  })
})
