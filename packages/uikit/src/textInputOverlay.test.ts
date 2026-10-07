import { describe, expect, it } from 'bun:test'
import type { UIKitKeyEvent } from './controls'
import type { ClipboardBridge } from './host'
import type { UIKitFont, UIKitFontMetrics } from './text/font'
import { UIKitTextInputOverlay } from './textInputOverlay'

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
  glyphs: new Map([...'Hiabcdefgh xyz'].map((ch) => [ch, GLYPH])),
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

function type(overlay: UIKitTextInputOverlay, text: string): void {
  for (const ch of text) overlay.keyDown(key(ch))
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

function make(now = { t: 0 }, clipboard?: ClipboardBridge) {
  const inputs: string[] = []
  const changes: string[] = []
  const submits: string[] = []
  let redraws = 0
  const overlay = new UIKitTextInputOverlay(FONT, {
    requestRedraw: () => redraws++,
    now: () => now.t,
    clipboard,
  })
  // Label 'Hi' then a 60x20 field at (122,50): text from x 128, 7 px per glyph.
  overlay.addTextInput({
    id: 't',
    label: 'Hi',
    x: 100,
    y: 50,
    width: 60,
    value: 'abc',
    onInput: (v) => inputs.push(v),
    onChange: (v) => changes.push(v),
    onSubmit: (v) => submits.push(v),
  })
  return { overlay, inputs, changes, submits, redraws: () => redraws }
}

describe('UIKitTextInputOverlay', () => {
  it('reports hits on the field only and a text cursor', () => {
    const { overlay } = make()
    expect(overlay.hitTest(150, 60)).toBe(true)
    expect(overlay.hitTest(105, 60)).toBe(false)
    expect(overlay.hoverCursor).toBe('text')
    expect(overlay.getLayout('t')?.field).toEqual({
      x: 122,
      y: 50,
      width: 60,
      height: 20,
    })
  })

  it('focuses on a press with the caret at the pointer, and selects all on a double press', () => {
    const now = { t: 0 }
    const { overlay } = make(now)
    expect(overlay.pointerDown(132, 60)).toBe(true)
    overlay.pointerUp(132, 60)
    expect(overlay.focusedInput).toBe('t')
    type(overlay, 'x')
    expect(overlay.getText('t')).toBe('axbc')
    now.t = 200
    overlay.pointerDown(132, 60)
    overlay.pointerUp(132, 60)
    type(overlay, 'y')
    expect(overlay.getText('t')).toBe('y')
  })

  it('drags a selection and replaces it when typing', () => {
    const { overlay } = make()
    overlay.pointerDown(128, 60)
    overlay.pointerMove(142, 60)
    overlay.pointerUp(142, 60)
    type(overlay, 'z')
    expect(overlay.getText('t')).toBe('zc')
  })

  it('fires onInput per keystroke, onChange and onSubmit on Enter', () => {
    const { overlay, inputs, changes, submits } = make()
    overlay.focus('t')
    expect(overlay.getValue('t')).toBe('abc')
    type(overlay, 'xy')
    expect(inputs).toEqual(['x', 'xy'])
    expect(changes).toEqual([])
    expect(overlay.keyDown(key('Enter'))).toBe(true)
    expect(changes).toEqual(['xy'])
    expect(submits).toEqual(['xy'])
    expect(overlay.getValue('t')).toBe('xy')
    expect(overlay.focusedInput).toBe('t')
    // Enter on unchanged text submits again without a change.
    overlay.keyDown(key('Enter'))
    expect(changes).toEqual(['xy'])
    expect(submits).toEqual(['xy', 'xy'])
  })

  it('commits on blur and reverts on Escape', () => {
    const { overlay, changes } = make()
    overlay.focus('t')
    type(overlay, 'x')
    overlay.keyDown(key('Escape'))
    expect(overlay.getText('t')).toBe('abc')
    type(overlay, 'y')
    overlay.blur()
    expect(overlay.focusedInput).toBeNull()
    expect(overlay.getValue('t')).toBe('y')
    expect(changes).toEqual(['y'])
  })

  it('stops typing at maxLength and refuses rejected characters', () => {
    const { overlay, inputs } = make()
    overlay.updateTextInput('t', {
      value: '',
      maxLength: 3,
      accept: (ch) => ch !== ' ',
    })
    overlay.focus('t')
    type(overlay, 'ab cde')
    expect(overlay.getText('t')).toBe('abc')
    expect(inputs).toEqual(['a', 'ab', 'abc'])
    // Deleting makes room again.
    overlay.keyDown(key('Backspace'))
    type(overlay, 'd')
    expect(overlay.getText('t')).toBe('abd')
  })

  it('leaves non-editing keys to the host and ignores keys without focus', () => {
    const { overlay } = make()
    expect(overlay.keyDown(key('a'))).toBe(false)
    overlay.focus('t')
    expect(overlay.keyDown(key('Tab'))).toBe(false)
    expect(overlay.keyDown(key('ArrowUp'))).toBe(false)
    expect(overlay.keyDown(key('F1'))).toBe(false)
    expect(overlay.keyDown(key('a', { metaKey: true }))).toBe(true)
    expect(overlay.keyDown(key('k', { metaKey: true }))).toBe(false)
  })

  it('setValue is silent and reselects a focused field', () => {
    const { overlay, inputs, changes } = make()
    overlay.focus('t')
    overlay.setValue('t', 'xyz')
    expect(overlay.getText('t')).toBe('xyz')
    type(overlay, 'a')
    expect(overlay.getText('t')).toBe('a')
    expect(inputs).toEqual(['a'])
    expect(changes).toEqual([])
  })

  it('refuses a disabled input and drops its focus when disabled', () => {
    const { overlay } = make()
    overlay.focus('t')
    overlay.setEnabled('t', false)
    expect(overlay.focusedInput).toBeNull()
    expect(overlay.hitTest(150, 60)).toBe(false)
    overlay.focus('t')
    expect(overlay.focusedInput).toBeNull()
  })

  it('copies and cuts the selection through the clipboard bridge', () => {
    const { clipboard, written } = fakeClipboard()
    const { overlay, inputs } = make(undefined, clipboard)
    overlay.focus('t')
    overlay.keyDown(key('c', { metaKey: true }))
    expect(written).toEqual(['abc'])
    overlay.keyDown(key('ArrowLeft'))
    overlay.keyDown(key('ArrowRight', { shiftKey: true }))
    expect(overlay.keyDown(key('x', { ctrlKey: true }))).toBe(true)
    expect(written).toEqual(['abc', 'a'])
    expect(overlay.getText('t')).toBe('bc')
    expect(inputs).toEqual(['bc'])
    // Nothing selected: the key is consumed but the clipboard untouched.
    overlay.keyDown(key('c', { metaKey: true }))
    expect(written).toHaveLength(2)
  })

  it('pastes over the selection, dropping line breaks and honoring maxLength', async () => {
    const { clipboard } = fakeClipboard('x\r\ny\nz')
    const { overlay, inputs } = make(undefined, clipboard)
    overlay.updateTextInput('t', { maxLength: 4 })
    overlay.focus('t')
    expect(overlay.keyDown(key('v', { metaKey: true }))).toBe(true)
    await Promise.resolve()
    expect(overlay.getText('t')).toBe('xyz')
    expect(inputs).toEqual(['xyz'])
    overlay.keyDown(key('End'))
    expect(overlay.paste('abc')).toBe(true)
    expect(overlay.getText('t')).toBe('xyza')
  })

  it('drops a paste that arrives after the field lost focus', async () => {
    const { clipboard } = fakeClipboard('late')
    const { overlay, inputs } = make(undefined, clipboard)
    overlay.focus('t')
    overlay.keyDown(key('v', { metaKey: true }))
    overlay.blur()
    await Promise.resolve()
    expect(overlay.getText('t')).toBe('abc')
    expect(inputs).toEqual([])
    expect(overlay.paste('x')).toBe(false)
  })

  it('keeps an edit in progress across a patch that leaves the value alone', () => {
    const { overlay, changes } = make()
    overlay.focus('t')
    overlay.keyDown(key('End'))
    type(overlay, 'x')
    overlay.updateTextInput('t', { x: 10 })
    expect(overlay.getText('t')).toBe('abcx')
    expect(overlay.focusedInput).toBe('t')
    // A new value replaces the edit; a shorter maxLength trims it and the caret.
    overlay.updateTextInput('t', { maxLength: 2 })
    expect(overlay.getText('t')).toBe('ab')
    type(overlay, 'y')
    expect(overlay.getText('t')).toBe('ab')
    overlay.updateTextInput('t', { value: 'new', maxLength: undefined })
    expect(overlay.getText('t')).toBe('new')
    expect(changes).toEqual([])
  })

  it('treats a non-finite or negative maxLength as no limit', () => {
    const { overlay } = make()
    overlay.updateTextInput('t', { maxLength: Number.NaN })
    expect(overlay.getText('t')).toBe('abc')
    overlay.focus('t')
    overlay.keyDown(key('End'))
    type(overlay, 'd')
    expect(overlay.getText('t')).toBe('abcd')
    overlay.updateTextInput('t', { maxLength: -1 })
    expect(overlay.getText('t')).toBe('abcd')
    type(overlay, 'e')
    expect(overlay.getText('t')).toBe('abcde')
  })

  it('drops a paste that arrives after a blur and refocus', async () => {
    const { clipboard } = fakeClipboard('late')
    const { overlay, inputs } = make(undefined, clipboard)
    overlay.focus('t')
    overlay.keyDown(key('v', { metaKey: true }))
    overlay.blur()
    overlay.focus('t') // a new session with everything selected
    await Promise.resolve()
    await Promise.resolve()
    expect(overlay.getText('t')).toBe('abc')
    expect(inputs).toEqual([])
  })

  it('places the caret where an unfocused overflowing field was pressed', () => {
    const { overlay } = make()
    overlay.setValue('t', 'abcdefghijklmnop')
    // Unfocused, the field shows its start. Focusing on the press selects
    // all with the caret at the end, which must not scroll the window the
    // pointer is mapped against.
    overlay.pointerDown(132, 60) // over 'a'
    overlay.pointerUp(132, 60)
    type(overlay, 'z')
    expect(overlay.getText('t')).toBe('azbcdefghijklmnop')
  })

  it('pulls hidden glyphs into a selection dragged past the left edge', () => {
    const { overlay } = make()
    overlay.setValue('t', 'abcdefghijkl')
    overlay.focus('t')
    overlay.keyDown(key('End')) // scrolls the start out of view
    // Press at the left edge of the text (caret before the first shown
    // glyph), then drag left of it: one hidden glyph joins the selection.
    overlay.pointerDown(122, 60)
    overlay.pointerMove(100, 60)
    overlay.pointerUp(100, 60)
    type(overlay, 'z')
    const text = overlay.getText('t')
    expect(text).toHaveLength(12)
    expect(text).toMatch(/^[a-l]+z[a-l]+$/)
  })

  it('requests a redraw for edits and counts entries', () => {
    const { overlay, redraws } = make()
    const before = redraws()
    overlay.focus('t')
    type(overlay, 'q')
    expect(redraws()).toBeGreaterThan(before)
    expect(overlay.ids).toEqual(['t'])
    overlay.removeTextInput('t')
    expect(overlay.ids).toEqual([])
    expect(overlay.focusedInput).toBeNull()
  })

  it('claims the layer keyboard when focused from code', () => {
    const { overlay } = make()
    const claimed: unknown[] = []
    overlay.bindLayer({
      requestRedraw: () => {},
      focus: (child) => claimed.push(child),
    })
    overlay.focus('t')
    expect(claimed).toEqual([overlay])
    overlay.blur()
    overlay.focus('missing')
    expect(claimed).toEqual([overlay])
  })
})
