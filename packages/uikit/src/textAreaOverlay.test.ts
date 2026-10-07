import { describe, expect, it } from 'bun:test'
import type { UIKitKeyEvent } from './controls'
import type { ClipboardBridge } from './host'
import type { UIKitFont, UIKitFontMetrics } from './text/font'
import { UIKitTextAreaOverlay } from './textAreaOverlay'

// Editing and input handling never touch the GPU, so the overlay is exercised
// headlessly with a stub font where every glyph is half an em wide.
const GLYPH = {
  plane: [0.05, 0, 0.4, 0.7] as [number, number, number, number],
  uv: [0, 0, 1, 1] as [number, number, number, number],
  xadv: 0.5,
}
const METRICS: UIKitFontMetrics = {
  distanceRange: 2,
  size: 50,
  textureSize: [64, 64],
  glyphs: new Map([...'Hiabcdefghijxyz '].map((ch) => [ch, GLYPH])),
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

function type(overlay: UIKitTextAreaOverlay, text: string): void {
  for (const ch of text) overlay.keyDown(key(ch === '\n' ? 'Enter' : ch))
}

/** A clipboard that remembers what was written and hands back `held` on read. */
function fakeClipboard(held = '') {
  const written: string[] = []
  const clipboard: ClipboardBridge = {
    write: (text) => {
      written.push(text)
    },
    read: () => Promise.resolve(held),
  }
  return { clipboard, written }
}

function make(
  now = { t: 0 },
  value = 'abc def ghij',
  clipboard?: ClipboardBridge,
) {
  const inputs: string[] = []
  const changes: string[] = []
  const submits: string[] = []
  let redraws = 0
  const overlay = new UIKitTextAreaOverlay(FONT, {
    requestRedraw: () => redraws++,
    now: () => now.t,
    clipboard,
  })
  // Label 'Hi' over a 60x48 two-row field at (100,66): rows 20 px tall from
  // y 70, text from x 106 at 7 px per glyph, five glyphs per row.
  overlay.addTextArea({
    id: 'a',
    label: 'Hi',
    x: 100,
    y: 50,
    width: 60,
    rows: 2,
    value,
    onInput: (v) => inputs.push(v),
    onChange: (v) => changes.push(v),
    onSubmit: (v) => submits.push(v),
  })
  return { overlay, inputs, changes, submits, redraws: () => redraws }
}

describe('UIKitTextAreaOverlay', () => {
  it('reports hits on the field only and a text cursor', () => {
    const { overlay } = make()
    expect(overlay.hitTest(130, 80)).toBe(true)
    expect(overlay.hitTest(105, 55)).toBe(false)
    expect(overlay.hoverCursor).toBe('text')
    expect(overlay.getLayout('a')?.field).toEqual({
      x: 100,
      y: 66,
      width: 60,
      height: 48,
    })
  })

  it('focuses on a press with the caret at the pointer, and selects all on a double press', () => {
    const now = { t: 0 }
    const { overlay, inputs } = make(now)
    expect(overlay.pointerDown(116, 75)).toBe(true)
    overlay.pointerUp(116, 75)
    expect(overlay.focusedArea).toBe('a')
    type(overlay, 'x')
    expect(overlay.getText('a')).toBe('axbc def ghij')
    expect(inputs).toEqual(['axbc def ghij'])
    now.t = 200
    overlay.pointerDown(116, 75)
    overlay.pointerUp(116, 75)
    type(overlay, 'y')
    expect(overlay.getText('a')).toBe('y')
  })

  it('drags a selection across rows', () => {
    const { overlay } = make()
    overlay.pointerDown(120, 75)
    overlay.pointerMove(113, 95)
    overlay.pointerUp(113, 95)
    type(overlay, 'z')
    expect(overlay.getText('a')).toBe('abzef ghij')
  })

  it('inserts newlines on Enter and commits on Meta plus Enter, Escape reverting', () => {
    const { overlay, changes, submits } = make({ t: 0 }, 'ab')
    overlay.focus('a')
    overlay.keyDown(key('End', { metaKey: true }))
    type(overlay, '\ncd')
    expect(overlay.getText('a')).toBe('ab\ncd')
    expect(overlay.getValue('a')).toBe('ab')
    overlay.keyDown(key('Escape'))
    expect(overlay.getText('a')).toBe('ab')
    type(overlay, 'xy')
    expect(overlay.keyDown(key('Enter', { ctrlKey: true }))).toBe(true)
    expect(changes).toEqual(['xy'])
    expect(submits).toEqual(['xy'])
    expect(overlay.focusedArea).toBe('a')
    overlay.keyDown(key('Enter', { metaKey: true }))
    expect(changes).toEqual(['xy'])
    expect(submits).toEqual(['xy', 'xy'])
  })

  it('commits on blur and keeps unchanged text silent', () => {
    const { overlay, changes } = make()
    overlay.focus('a')
    overlay.blur()
    expect(changes).toEqual([])
    overlay.pointerDown(159, 95)
    overlay.pointerUp(159, 95)
    type(overlay, 'x')
    overlay.blur()
    expect(changes).toEqual(['abc defx ghij'])
    expect(overlay.focusedArea).toBeNull()
  })

  it('moves the caret by rows with the arrows, keeping the goal column', () => {
    const { overlay } = make({ t: 0 }, 'abcd\nx\nefgh')
    overlay.pointerDown(127, 75)
    overlay.pointerUp(127, 75)
    overlay.keyDown(key('ArrowDown'))
    overlay.keyDown(key('ArrowDown'))
    type(overlay, 'z')
    expect(overlay.getText('a')).toBe('abcd\nx\nefgzh')
  })

  it('scrolls a hovered area by whole rows on the wheel', () => {
    const { overlay } = make({ t: 0 }, 'a\nb\nc\nd\ne')
    expect(overlay.wheel(300, 300, 0, 20)).toBe(false)
    expect(overlay.wheel(130, 80, 0, 15)).toBe(true)
    expect(overlay.getFirstRow('a')).toBe(0)
    overlay.wheel(130, 80, 0, 5)
    expect(overlay.getFirstRow('a')).toBe(1)
    overlay.wheel(130, 80, 0, 200)
    expect(overlay.getFirstRow('a')).toBe(3)
    overlay.wheel(130, 80, 0, -200)
    expect(overlay.getFirstRow('a')).toBe(0)
  })

  it('drags an overflowing scrollbar thumb by whole rows without moving the caret', () => {
    const { overlay } = make({ t: 0 }, 'a\nb\nc\nd\ne')
    // The two-row viewport's thumb starts at y=70 and ends at y=86.
    overlay.pointerMove(150, 75) // gutter beside the 4 px visible thumb
    expect(overlay.hoverCursor).toBe('ns-resize')
    expect(overlay.pointerDown(150, 75)).toBe(true)
    expect(overlay.focusedArea).toBeNull()
    overlay.pointerMove(153, 99)
    overlay.pointerUp(153, 99)
    expect(overlay.getFirstRow('a')).toBe(3)
  })

  it('places the caret on the scrolled row under the pointer', () => {
    const { overlay } = make({ t: 0 }, 'a\nb\nc\nd\ne')
    overlay.wheel(130, 80, 0, 40)
    expect(overlay.getFirstRow('a')).toBe(2)
    overlay.pointerDown(159, 95)
    overlay.pointerUp(159, 95)
    type(overlay, 'z')
    expect(overlay.getText('a')).toBe('a\nb\nc\ndz\ne')
  })

  it('stops typing at maxLength and refuses rejected characters', () => {
    const { overlay } = make()
    overlay.updateTextArea('a', { maxLength: 13, accept: (ch) => ch !== 'y' })
    overlay.focus('a')
    overlay.keyDown(key('End', { metaKey: true }))
    type(overlay, 'xyx')
    expect(overlay.getText('a')).toBe('abc def ghijx')
  })

  it('ignores a disabled area and drops its focus when disabled', () => {
    const { overlay } = make()
    overlay.focus('a')
    overlay.setEnabled('a', false)
    expect(overlay.focusedArea).toBeNull()
    expect(overlay.pointerDown(130, 80)).toBe(false)
    expect(overlay.keyDown(key('x'))).toBe(false)
    overlay.setEnabled('a', true)
    expect(overlay.pointerDown(130, 80)).toBe(true)
  })

  it('copies, cuts and pastes multi-line text through the clipboard bridge', async () => {
    const { clipboard, written } = fakeClipboard('one\r\ntwo')
    const { overlay, inputs } = make(undefined, 'abc def ghij', clipboard)
    overlay.focus('a')
    overlay.keyDown(key('c', { metaKey: true }))
    expect(written).toEqual(['abc def ghij'])
    overlay.keyDown(key('Home', { metaKey: true }))
    overlay.keyDown(key('ArrowDown', { shiftKey: true }))
    overlay.keyDown(key('x', { ctrlKey: true }))
    expect(written[1]).toBe('abc ')
    expect(overlay.getText('a')).toBe('def ghij')
    expect(overlay.keyDown(key('v', { metaKey: true }))).toBe(true)
    await Promise.resolve()
    expect(overlay.getText('a')).toBe('one\ntwodef ghij')
    expect(inputs).toEqual(['def ghij', 'one\ntwodef ghij'])
    overlay.blur()
    expect(overlay.paste('x')).toBe(false)
  })

  it('sets a value silently and reports it', () => {
    const { overlay, inputs, changes, redraws } = make()
    const before = redraws()
    overlay.setValue('a', 'new')
    expect(overlay.getValue('a')).toBe('new')
    expect(inputs).toEqual([])
    expect(changes).toEqual([])
    expect(redraws()).toBe(before + 1)
    overlay.removeTextArea('a')
    expect(overlay.ids).toEqual([])
    expect(overlay.getValue('a')).toBeUndefined()
  })
})
