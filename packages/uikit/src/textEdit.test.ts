import { describe, expect, it } from 'bun:test'
import type { UIKitKeyEvent } from './controls'
import type { UIKitFontMetrics } from './text/font'
import {
  advanceBetween,
  caretIndexAt,
  clipboardKey,
  deleteBackward,
  deleteForward,
  editKey,
  glyphAdvances,
  hasSelection,
  insertText,
  maxLengthOf,
  pasteText,
  selectAll,
  selectedText,
  selectionOf,
  setCaret,
  textEditState,
  textWindow,
} from './textEdit'

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

describe('TextEditState', () => {
  it('starts with the caret at the end and clamps indices', () => {
    expect(textEditState('abc')).toEqual({ text: 'abc', caret: 3, anchor: 3 })
    expect(textEditState('abc', 9, -2)).toEqual({
      text: 'abc',
      caret: 3,
      anchor: 0,
    })
    expect(setCaret(textEditState('abc'), 1)).toEqual({
      text: 'abc',
      caret: 1,
      anchor: 1,
    })
    expect(setCaret(textEditState('abc'), 1, true)).toEqual({
      text: 'abc',
      caret: 1,
      anchor: 3,
    })
  })

  it('reports the selection as an ordered span', () => {
    const s = textEditState('abcd', 1, 3)
    expect(hasSelection(s)).toBe(true)
    expect(selectionOf(s)).toEqual([1, 3])
    expect(selectionOf(selectAll(s))).toEqual([0, 4])
    expect(hasSelection(textEditState('abcd'))).toBe(false)
  })

  it('inserts at the caret or over the selection', () => {
    expect(insertText(textEditState('ab', 1), 'X')).toEqual({
      text: 'aXb',
      caret: 2,
      anchor: 2,
    })
    expect(insertText(textEditState('abcd', 3, 1), 'X')).toEqual({
      text: 'aXd',
      caret: 2,
      anchor: 2,
    })
  })

  it('deletes a character or the selection in either direction', () => {
    expect(deleteBackward(textEditState('abc', 2))).toEqual({
      text: 'ac',
      caret: 1,
      anchor: 1,
    })
    expect(deleteBackward(textEditState('abc', 0))).toEqual({
      text: 'abc',
      caret: 0,
      anchor: 0,
    })
    expect(deleteForward(textEditState('abc', 1))).toEqual({
      text: 'ac',
      caret: 1,
      anchor: 1,
    })
    expect(deleteForward(textEditState('abc', 3))).toEqual({
      text: 'abc',
      caret: 3,
      anchor: 3,
    })
    expect(deleteForward(textEditState('abc', 0, 2))).toEqual({
      text: 'c',
      caret: 0,
      anchor: 0,
    })
  })
})

describe('editKey', () => {
  it('moves the caret, extends with Shift and jumps with Meta or Ctrl', () => {
    const s = textEditState('abc', 1)
    expect(editKey(s, key('ArrowLeft'))?.caret).toBe(0)
    expect(editKey(s, key('ArrowRight'))?.caret).toBe(2)
    expect(editKey(s, key('ArrowRight', { shiftKey: true }))).toEqual({
      text: 'abc',
      caret: 2,
      anchor: 1,
    })
    expect(editKey(s, key('ArrowRight', { metaKey: true }))?.caret).toBe(3)
    expect(editKey(s, key('ArrowLeft', { ctrlKey: true }))?.caret).toBe(0)
    expect(editKey(s, key('End'))?.caret).toBe(3)
    expect(editKey(s, key('Home', { shiftKey: true }))).toEqual({
      text: 'abc',
      caret: 0,
      anchor: 1,
    })
  })

  it('collapses a selection to its ends with a plain arrow', () => {
    const s = textEditState('abcd', 3, 1)
    expect(editKey(s, key('ArrowLeft'))).toEqual({
      text: 'abcd',
      caret: 1,
      anchor: 1,
    })
    expect(editKey(s, key('ArrowRight'))).toEqual({
      text: 'abcd',
      caret: 3,
      anchor: 3,
    })
  })

  it('edits with Backspace, Delete, select-all and typed characters', () => {
    const s = textEditState('abc', 2)
    expect(editKey(s, key('Backspace'))?.text).toBe('ac')
    expect(editKey(s, key('Delete'))?.text).toBe('ab')
    expect(editKey(s, key('a', { metaKey: true }))).toEqual({
      text: 'abc',
      caret: 3,
      anchor: 0,
    })
    expect(editKey(s, key('X'))).toEqual({ text: 'abXc', caret: 3, anchor: 3 })
    expect(editKey(s, key(' '))?.text).toBe('ab c')
  })

  it('swallows a rejected character and passes other keys back', () => {
    const s = textEditState('12', 2)
    const digits = (ch: string) => /[0-9]/.test(ch)
    expect(editKey(s, key('x'), digits)).toBe(s)
    expect(editKey(s, key('3'), digits)?.text).toBe('123')
    expect(editKey(s, key('Enter'))).toBeNull()
    expect(editKey(s, key('Escape'))).toBeNull()
    expect(editKey(s, key('ArrowUp'))).toBeNull()
    expect(editKey(s, key('Tab'))).toBeNull()
    expect(editKey(s, key('s', { metaKey: true }))).toBeNull()
  })
})

describe('clipboard helpers', () => {
  it('recognizes Meta or Ctrl plus C, X and V in either case', () => {
    expect(clipboardKey(key('c', { metaKey: true }))).toBe('copy')
    expect(clipboardKey(key('X', { ctrlKey: true }))).toBe('cut')
    expect(clipboardKey(key('v', { ctrlKey: true }))).toBe('paste')
    expect(clipboardKey(key('v'))).toBeNull()
    expect(clipboardKey(key('v', { metaKey: true, altKey: true }))).toBeNull()
    expect(clipboardKey(key('a', { metaKey: true }))).toBeNull()
  })

  it('reads the selection and pastes over it within accept and maxLength', () => {
    const s = textEditState('abcdef', 4, 1)
    expect(selectedText(s)).toBe('bcd')
    expect(selectedText(textEditState('abc', 1))).toBe('')
    expect(pasteText(s, 'XY')).toMatchObject({ text: 'aXYef', caret: 3 })
    // 'abcdef' minus the three selected leaves three; a limit of five keeps two.
    expect(pasteText(s, 'WXYZ', undefined, 5).text).toBe('aWXef')
    expect(pasteText(s, 'W1X2', (ch) => /[A-Z]/.test(ch)).text).toBe('aWXef')
    // Nothing allowed and nothing selected: the state is untouched.
    const plain = textEditState('abc', 3)
    expect(pasteText(plain, '12', (ch) => /[a-z]/.test(ch))).toBe(plain)
    expect(pasteText(plain, 'xyz', undefined, 3)).toBe(plain)
  })
})

describe('maxLengthOf', () => {
  it('keeps a usable count and drops NaN, infinite or negative ones', () => {
    expect(maxLengthOf(3)).toBe(3)
    expect(maxLengthOf(2.7)).toBe(2)
    expect(maxLengthOf(0)).toBe(0)
    expect(maxLengthOf(undefined)).toBeUndefined()
    expect(maxLengthOf(Number.NaN)).toBeUndefined()
    expect(maxLengthOf(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(maxLengthOf(-1)).toBeUndefined()
    // pasteText goes through it: a NaN limit pastes everything.
    const s = textEditState('ab')
    expect(pasteText(s, 'cd', undefined, Number.NaN).text).toBe('abcd')
  })
})

describe('glyph arithmetic', () => {
  const METRICS: UIKitFontMetrics = {
    distanceRange: 2,
    size: 50,
    textureSize: [64, 64],
    glyphs: new Map([
      ['a', { plane: [0, 0, 0.5, 0.7], uv: [0, 0, 1, 1], xadv: 0.5 }],
      ['w', { plane: [0, 0, 1, 0.7], uv: [0, 0, 1, 1], xadv: 1 }],
    ]),
  }

  it('measures each code unit, with 0 for a glyph the font lacks', () => {
    expect(glyphAdvances(METRICS, 'awa?', 10)).toEqual([5, 10, 5, 0])
    expect(advanceBetween([5, 10, 5], 1, 3)).toBe(15)
    expect(advanceBetween([5, 10, 5], -1, 9)).toBe(20)
  })

  it('puts the caret on the nearer side of a glyph', () => {
    const adv = [5, 10, 5]
    expect(caretIndexAt(adv, 0, 0)).toBe(0)
    expect(caretIndexAt(adv, 0, 2.4)).toBe(0)
    expect(caretIndexAt(adv, 0, 2.5)).toBe(1)
    expect(caretIndexAt(adv, 0, 9)).toBe(1)
    expect(caretIndexAt(adv, 0, 11)).toBe(2)
    expect(caretIndexAt(adv, 0, 99)).toBe(3)
    // Measured from the first shown glyph when the text is scrolled.
    expect(caretIndexAt(adv, 1, 6)).toBe(2)
  })

  it('scrolls whole glyphs the least distance that keeps the caret in view', () => {
    const adv = [5, 5, 5, 5, 5, 5] // six glyphs, a 12 px field shows two
    expect(textWindow(adv, 12, 0, 0)).toMatchObject({ first: 0, end: 2 })
    expect(textWindow(adv, 12, 0, 2)).toMatchObject({ first: 0, end: 2 }) // caret at the right edge
    expect(textWindow(adv, 12, 0, 3)).toMatchObject({ first: 1, end: 3 })
    expect(textWindow(adv, 12, 0, 6)).toMatchObject({ first: 4, end: 6 })
    expect(textWindow(adv, 12, 4, 1)).toMatchObject({ first: 1, end: 3 })
    expect(textWindow(adv, 12, 4, 4)).toMatchObject({ first: 4, end: 6 })
    expect(textWindow(adv, 99, 3, 0)).toMatchObject({ first: 0, end: 6 })
  })
})
