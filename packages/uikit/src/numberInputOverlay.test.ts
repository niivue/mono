import { describe, expect, it } from 'bun:test'
import type { ClipboardBridge } from './host'
import { UIKitNumberInputOverlay } from './numberInputOverlay'
import type { UIKitFont, UIKitFontMetrics } from './text/font'

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
  glyphs: new Map([...'Hi0123456789.-e'].map((ch) => [ch, GLYPH])),
}
const FONT: UIKitFont = { metrics: METRICS, image: {} as ImageBitmap }

function make(clipboard?: ClipboardBridge) {
  const inputs: number[] = []
  const changes: number[] = []
  let redraws = 0
  const overlay = new UIKitNumberInputOverlay(FONT, {
    requestRedraw: () => redraws++,
    clipboard,
  })
  // Label 'Hi' then an 80x20 field at (122,50): text from x 128, spinner at x 185.
  overlay.addNumberInput({
    id: 'n',
    label: 'Hi',
    x: 100,
    y: 50,
    min: 0,
    max: 10,
    step: 1,
    value: 5,
    onInput: (v) => inputs.push(v),
    onChange: (v) => changes.push(v),
  })
  return { overlay, inputs, changes, redraws: () => redraws }
}

function key(k: string, shiftKey = false) {
  return { key: k, shiftKey, ctrlKey: false, altKey: false, metaKey: false }
}

function cmd(k: string) {
  return { ...key(k), metaKey: true }
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

function type(overlay: UIKitNumberInputOverlay, chars: string): void {
  for (const ch of chars) overlay.keyDown(key(ch))
}

describe('UIKitNumberInputOverlay', () => {
  it('snaps the initial value, shows it as text and hit-tests the field', () => {
    const { overlay } = make()
    expect(overlay.ids).toEqual(['n'])
    expect(overlay.getValue('n')).toBe(5)
    expect(overlay.getText('n')).toBe('5')
    expect(overlay.getLayout('n')?.field).toEqual({
      x: 122,
      y: 50,
      width: 80,
      height: 20,
    })
    expect(overlay.hitTest(105, 60)).toBe(false)
    expect(overlay.hitTest(130, 60)).toBe(true)
    overlay.addNumberInput({
      id: 'm',
      x: 0,
      y: 0,
      min: 0,
      max: 1,
      step: 0.25,
      value: 0.4,
    })
    expect(overlay.getValue('m')).toBe(0.5)
    expect(overlay.getText('m')).toBe('0.50')
  })

  it('focuses on press with the number selected, so typing replaces it', () => {
    const { overlay, inputs, changes } = make()
    expect(overlay.pointerDown(130, 60)).toBe(true)
    expect(overlay.pointerUp(130, 60)).toBe(true)
    expect(overlay.focusedInput).toBe('n')
    type(overlay, '7')
    expect(overlay.getText('n')).toBe('7')
    expect(overlay.getValue('n')).toBe(5) // not committed yet
    expect(inputs).toEqual([7])
    expect(overlay.keyDown(key('Enter'))).toBe(true)
    expect(overlay.getValue('n')).toBe(7)
    expect(changes).toEqual([7])
    expect(overlay.focusedInput).toBe('n')
    // Enter re-selects the number: more typing replaces it again.
    type(overlay, '3')
    expect(overlay.getText('n')).toBe('3')
  })

  it('reports onInput once per distinct valid number while typing', () => {
    const { overlay, inputs } = make()
    overlay.focus('n')
    type(overlay, '1.')
    expect(inputs).toEqual([1])
    type(overlay, '5') // 1.5 snaps to 2
    expect(inputs).toEqual([1, 2])
    overlay.keyDown(key('Backspace'))
    expect(inputs).toEqual([1, 2, 1]) // back to '1.': the number changed again
    overlay.keyDown(key('Backspace'))
    expect(inputs).toEqual([1, 2, 1]) // '1' is still 1: no repeat
    overlay.keyDown(key('Backspace'))
    expect(overlay.getText('n')).toBe('')
    expect(inputs).toEqual([1, 2, 1]) // empty is not a number
  })

  it('swallows letters and keeps invalid text until it is committed, then reverts', () => {
    const { overlay, inputs, changes } = make()
    overlay.focus('n')
    expect(overlay.keyDown(key('a'))).toBe(true)
    expect(overlay.getText('n')).toBe('5')
    type(overlay, 'e')
    expect(overlay.getText('n')).toBe('e')
    expect(inputs).toEqual([])
    overlay.keyDown(key('Enter'))
    expect(overlay.getText('n')).toBe('5')
    expect(overlay.getValue('n')).toBe(5)
    expect(changes).toEqual([])
  })

  it('reverts on Escape and commits on blur', () => {
    const { overlay, changes } = make()
    overlay.focus('n')
    type(overlay, '9')
    expect(overlay.keyDown(key('Escape'))).toBe(true)
    expect(overlay.getText('n')).toBe('5')
    type(overlay, '3')
    overlay.blur()
    expect(overlay.focusedInput).toBeNull()
    expect(overlay.getValue('n')).toBe(3)
    expect(overlay.getText('n')).toBe('3')
    expect(changes).toEqual([3])
    expect(overlay.keyDown(key('1'))).toBe(false)
  })

  it('clamps and snaps a committed value', () => {
    const { overlay, inputs, changes } = make()
    overlay.focus('n')
    type(overlay, '52')
    expect(inputs).toEqual([10])
    overlay.keyDown(key('Enter'))
    expect(overlay.getValue('n')).toBe(10)
    expect(overlay.getText('n')).toBe('10')
    expect(changes).toEqual([10])
  })

  it('steps and commits with the arrow keys, Shift, PageUp and PageDown', () => {
    const { overlay, inputs, changes } = make()
    overlay.focus('n')
    expect(overlay.keyDown(key('ArrowUp'))).toBe(true)
    expect(overlay.getValue('n')).toBe(6)
    expect(overlay.getText('n')).toBe('6')
    overlay.keyDown(key('ArrowUp', true))
    expect(overlay.getValue('n')).toBe(10)
    overlay.keyDown(key('PageDown'))
    expect(overlay.getValue('n')).toBe(0)
    overlay.keyDown(key('ArrowDown')) // at min: consumed, no change
    overlay.keyDown(key('PageUp'))
    expect(inputs).toEqual([6, 10, 0, 10])
    expect(changes).toEqual(inputs)
  })

  it('steps from the typed number, not the committed one', () => {
    const { overlay, changes } = make()
    overlay.focus('n')
    type(overlay, '8')
    overlay.keyDown(key('ArrowUp'))
    expect(overlay.getValue('n')).toBe(9)
    expect(changes).toEqual([9])
  })

  it('steps on a spinner press and shows the pressed half until release', () => {
    const { overlay, changes } = make()
    expect(overlay.pointerDown(190, 55)).toBe(true) // up half
    expect(overlay.getValue('n')).toBe(6)
    expect(overlay.focusedInput).toBe('n')
    expect(overlay.pointerMove(300, 300)).toBe(true) // held: still ours
    expect(overlay.pointerUp(300, 300)).toBe(true)
    overlay.pointerDown(190, 65) // down half
    overlay.pointerUp(190, 65)
    expect(overlay.getValue('n')).toBe(5)
    expect(changes).toEqual([6, 5])
    expect(overlay.hoverCursor).toBe('pointer')
  })

  it('places the caret on a second press and selects by dragging', () => {
    const { overlay } = make()
    overlay.pointerDown(130, 60)
    overlay.pointerUp(130, 60)
    type(overlay, '12')
    expect(overlay.getText('n')).toBe('12')
    // Glyphs are 7 px wide from x 128: x 136 lands between '1' and '2'.
    overlay.pointerDown(136, 60)
    overlay.pointerUp(136, 60)
    type(overlay, '0')
    expect(overlay.getText('n')).toBe('102')
    overlay.pointerDown(128, 60)
    overlay.pointerMove(143, 60) // drag over '10'
    overlay.pointerUp(143, 60)
    type(overlay, '9')
    expect(overlay.getText('n')).toBe('92')
    expect(overlay.hoverCursor).toBe('text')
  })

  it('starts a drag where an unfocused overflowing field was pressed', () => {
    const overlay = new UIKitNumberInputOverlay(FONT, {
      requestRedraw: () => {},
    })
    overlay.addNumberInput({
      id: 'n',
      label: 'Hi',
      x: 100,
      y: 50,
      min: 0,
      max: 1e15,
      step: 1,
      value: 123456789012,
    })
    // Unfocused, the field shows its start. The press focuses (select all,
    // caret at the end) and must not scroll the window the drag is mapped
    // against: the drag from '1' to '3' selects '12'.
    overlay.pointerDown(130, 60)
    overlay.pointerMove(143, 60)
    overlay.pointerUp(143, 60)
    type(overlay, '9')
    expect(overlay.getText('n')).toBe('93456789012')
  })

  it('steps on the wheel only while focused and over the field', () => {
    const { overlay, changes } = make()
    expect(overlay.wheel(130, 60, 0, -40)).toBe(false)
    overlay.focus('n')
    expect(overlay.wheel(130, 60, 0, -40)).toBe(true)
    expect(overlay.getValue('n')).toBe(6)
    expect(overlay.wheel(130, 60, 0, 20)).toBe(true) // half a step: carried
    expect(overlay.wheel(130, 60, 0, 20)).toBe(true)
    expect(overlay.getValue('n')).toBe(5)
    expect(overlay.wheel(300, 300, 0, -40)).toBe(false)
    expect(changes).toEqual([6, 5])
  })

  it('ignores a disabled input for pointer, keyboard and focus', () => {
    const { overlay, inputs } = make()
    overlay.focus('n')
    overlay.setEnabled('n', false)
    expect(overlay.focusedInput).toBeNull()
    expect(overlay.hitTest(130, 60)).toBe(false)
    expect(overlay.pointerDown(130, 60)).toBe(false)
    overlay.focus('n')
    expect(overlay.keyDown(key('ArrowUp'))).toBe(false)
    expect(inputs).toEqual([])
    overlay.setEnabled('n', true)
    expect(overlay.pointerDown(130, 60)).toBe(true)
  })

  it('setValue is silent and replaces an edit in progress; updates keep the value', () => {
    const { overlay, inputs, changes, redraws } = make()
    const n = redraws()
    overlay.setValue('n', 7.4)
    expect(overlay.getValue('n')).toBe(7)
    expect(overlay.getText('n')).toBe('7')
    expect(redraws()).toBe(n + 1)
    overlay.setValue('n', 7)
    expect(redraws()).toBe(n + 1)
    overlay.focus('n')
    type(overlay, '9')
    overlay.setValue('n', 2)
    expect(overlay.getText('n')).toBe('2')
    overlay.blur()
    overlay.updateNumberInput('n', { max: 1 })
    expect(overlay.getValue('n')).toBe(1)
    overlay.updateNumberInput('n', { value: 0 })
    expect(overlay.getValue('n')).toBe(0)
    expect(inputs).toEqual([9]) // only the typed digit was reported
    expect(changes).toEqual([])
  })

  it('moving focus between inputs commits the one left', () => {
    const { overlay, changes } = make()
    overlay.addNumberInput({
      id: 'm',
      x: 0,
      y: 0,
      min: 0,
      max: 1,
      step: 0.25,
      value: 0,
    })
    overlay.focus('n')
    type(overlay, '4')
    overlay.focus('m')
    expect(overlay.getValue('n')).toBe(4)
    expect(changes).toEqual([4])
    expect(overlay.getText('m')).toBe('0.00')
  })

  it('hovers and un-hovers with a redraw each way', () => {
    const { overlay, redraws } = make()
    expect(overlay.pointerMove(130, 60)).toBe(false)
    const n = redraws()
    overlay.pointerMove(131, 60)
    expect(redraws()).toBe(n)
    overlay.pointerMove(190, 55) // onto the spinner: a redraw for its tint
    expect(redraws()).toBe(n + 1)
    overlay.pointerMove(-1, -1)
    expect(redraws()).toBe(n + 2)
  })

  it('replaces the set with setNumberInputs and drops stale focus', () => {
    const { overlay } = make()
    overlay.focus('n')
    overlay.setNumberInputs([{ id: 'u', x: 0, y: 0, value: 0 }])
    expect(overlay.ids).toEqual(['u'])
    expect(overlay.focusedInput).toBeNull()
  })

  it('copies and cuts the selection through the clipboard bridge', () => {
    const { clipboard, written } = fakeClipboard()
    const { overlay, inputs } = make(clipboard)
    overlay.setValue('n', 7)
    overlay.focus('n')
    overlay.keyDown(cmd('c'))
    expect(written).toEqual(['7'])
    expect(overlay.keyDown({ ...key('x'), ctrlKey: true })).toBe(true)
    expect(written).toEqual(['7', '7'])
    expect(overlay.getText('n')).toBe('')
    expect(inputs).toEqual([])
    // Nothing selected: the key is consumed but the clipboard untouched.
    overlay.keyDown(cmd('c'))
    expect(written).toHaveLength(2)
  })

  it('pastes a trimmed number', async () => {
    const { clipboard } = fakeClipboard(' 8\n')
    const { overlay, inputs, changes } = make(clipboard)
    overlay.focus('n')
    expect(overlay.keyDown(cmd('v'))).toBe(true)
    await Promise.resolve()
    expect(overlay.getText('n')).toBe('8')
    expect(inputs).toEqual([8])
    overlay.keyDown(key('Enter'))
    expect(changes).toEqual([8])
    expect(overlay.paste('-1e0')).toBe(true)
    expect(overlay.getText('n')).toBe('-1e0')
  })

  it('lands a pending paste across a layout patch and an unrelated set change', async () => {
    const { clipboard } = fakeClipboard('8')
    const { overlay } = make(clipboard)
    overlay.focus('n')
    overlay.keyDown(cmd('v'))
    overlay.updateNumberInput('n', { x: 101 })
    const spec = { id: 'n', x: 101, y: 50, min: 0, max: 10, step: 1, value: 5 }
    overlay.setNumberInputs([spec, { id: 'm', x: 0, y: 0, value: 0 }])
    overlay.setNumberInputs([{ ...spec, value: 5.2 }])
    expect(overlay.ids).toEqual(['n'])
    await Promise.resolve()
    expect(overlay.getText('n')).toBe('8')
    expect(overlay.focusedInput).toBe('n')
  })

  it('keeps onInput history across retained updates', () => {
    const { overlay, inputs } = make()
    const spec = {
      id: 'n',
      x: 100,
      y: 50,
      min: 0,
      max: 10,
      step: 1,
      value: 5,
      onInput: (v: number) => inputs.push(v),
    }
    for (const update of [
      () => overlay.setNumberInputs([{ ...spec, x: 101 }]),
      () => overlay.updateNumberInput('n', { x: 102 }),
    ]) {
      inputs.length = 0
      overlay.focus('n')
      type(overlay, '6')
      update()
      overlay.keyDown(cmd('a'))
      type(overlay, '5')
      overlay.blur()
      expect(overlay.getValue('n')).toBe(5)
      expect(inputs).toEqual([6, 5])
    }
  })

  it('formats a replaced focused input with the new spec', () => {
    const { overlay } = make()
    overlay.focus('n')
    overlay.updateNumberInput('n', { step: 0.1, value: 2.5 })
    expect(overlay.getText('n')).toBe('2.5')
  })

  it('drops a pending paste when the input gets a new value', async () => {
    const { clipboard } = fakeClipboard('8')
    const { overlay } = make(clipboard)
    overlay.focus('n')
    overlay.keyDown(cmd('v'))
    overlay.setNumberInputs([{ id: 'n', x: 100, y: 50, max: 10, value: 3 }])
    await Promise.resolve()
    expect(overlay.getText('n')).toBe('3')
  })

  it('ignores a paste that is not a number instead of filtering it', () => {
    const { overlay, inputs } = make()
    overlay.focus('n')
    for (const text of ['', '   ', '1,5', '12.5 meters', 'abc']) {
      expect(overlay.paste(text)).toBe(true)
      expect(overlay.getText('n')).toBe('5')
    }
    expect(inputs).toEqual([])
    // A Unicode minus (U+2212) is a minus sign.
    overlay.paste('\u22123')
    expect(overlay.getText('n')).toBe('-3')
    expect(inputs).toHaveLength(1) // reported clamped to this field's min
  })

  it('keeps the field when the clipboard read is refused or rejects', async () => {
    const { clipboard } = fakeClipboard('')
    const { overlay, inputs } = make(clipboard)
    overlay.focus('n')
    expect(overlay.keyDown({ ...key('v'), ctrlKey: true })).toBe(true)
    await Promise.resolve()
    expect(overlay.getText('n')).toBe('5')
    clipboard.read = () => Promise.reject(new Error('denied'))
    overlay.keyDown(cmd('v'))
    await Promise.resolve()
    await Promise.resolve()
    expect(overlay.getText('n')).toBe('5')
    expect(inputs).toEqual([])
  })

  it('drops a paste that arrives after the field lost focus or was refocused', async () => {
    const { clipboard } = fakeClipboard('3')
    const { overlay, inputs } = make(clipboard)
    overlay.focus('n')
    overlay.keyDown(cmd('v'))
    overlay.blur()
    await Promise.resolve()
    expect(overlay.getText('n')).toBe('5')
    expect(overlay.paste('3')).toBe(false)
    overlay.focus('n')
    overlay.keyDown(cmd('v'))
    overlay.blur()
    overlay.focus('n') // a new session with everything selected
    await Promise.resolve()
    expect(overlay.getText('n')).toBe('5')
    expect(inputs).toEqual([])
  })

  it('drops a paste that arrives after the overlay was destroyed', async () => {
    const { clipboard } = fakeClipboard('3')
    const { overlay, inputs } = make(clipboard)
    overlay.focus('n')
    overlay.keyDown(cmd('v'))
    overlay.destroy()
    await Promise.resolve()
    expect(overlay.getText('n')).toBe('5')
    expect(inputs).toEqual([])
  })
})
