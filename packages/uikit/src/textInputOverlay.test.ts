import { describe, expect, it } from 'bun:test'
import type { UIKitKeyEvent } from './controls'
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

function make(now = { t: 0 }) {
  const inputs: string[] = []
  const changes: string[] = []
  const submits: string[] = []
  let redraws = 0
  const overlay = new UIKitTextInputOverlay(FONT, {
    requestRedraw: () => redraws++,
    now: () => now.t,
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
})
