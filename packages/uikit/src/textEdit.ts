// Pure single-line text editing model shared by UIKit's text-entry widgets
// (number inputs today, text inputs later): a string with a caret and a
// selection anchor, the edits a key press makes to it, the mapping from a
// pointer x to a caret, and the whole-glyph horizontal scrolling that keeps
// the caret in view (through the shared scroll model, so an overflowing field
// draws only the glyphs that fit and needs no GPU scissor). No GPU and no DOM
// here. Caret indices are UTF-16 code unit offsets into `text`.

import type { UIKitKeyEvent } from './controls'
import { revealRow, type ScrollWindow, scrollWindow } from './scroll'
import type { UIKitFontMetrics } from './text/font'

export interface TextEditState {
  text: string
  /** Caret position, 0 to `text.length`. */
  caret: number
  /** The other end of the selection; equals `caret` when nothing is selected. */
  anchor: number
}

/** A state with the caret at `caret` (default: the end) and no selection. */
export function textEditState(
  text: string,
  caret = text.length,
  anchor = caret,
): TextEditState {
  const c = clampIndex(caret, text)
  return { text, caret: c, anchor: clampIndex(anchor, text) }
}

function clampIndex(i: number, text: string): number {
  return Math.max(0, Math.min(text.length, Math.floor(i)))
}

/** The selected span as [start, end) (empty when start equals end). */
export function selectionOf(s: TextEditState): [number, number] {
  return [Math.min(s.caret, s.anchor), Math.max(s.caret, s.anchor)]
}

export function hasSelection(s: TextEditState): boolean {
  return s.caret !== s.anchor
}

export function selectAll(s: TextEditState): TextEditState {
  return { text: s.text, caret: s.text.length, anchor: 0 }
}

/** Move the caret to `index`; with `extend`, the anchor stays and the selection grows. */
export function setCaret(
  s: TextEditState,
  index: number,
  extend = false,
): TextEditState {
  const caret = clampIndex(index, s.text)
  return { text: s.text, caret, anchor: extend ? s.anchor : caret }
}

/** Replace the selection (or insert at the caret) with `str`. */
export function insertText(s: TextEditState, str: string): TextEditState {
  const [a, b] = selectionOf(s)
  const text = s.text.slice(0, a) + str + s.text.slice(b)
  const caret = a + str.length
  return { text, caret, anchor: caret }
}

/** Delete the selection, or the character before the caret. */
export function deleteBackward(s: TextEditState): TextEditState {
  if (hasSelection(s)) return insertText(s, '')
  if (s.caret === 0) return s
  const text = s.text.slice(0, s.caret - 1) + s.text.slice(s.caret)
  return { text, caret: s.caret - 1, anchor: s.caret - 1 }
}

/** Delete the selection, or the character after the caret. */
export function deleteForward(s: TextEditState): TextEditState {
  if (hasSelection(s)) return insertText(s, '')
  if (s.caret >= s.text.length) return s
  const text = s.text.slice(0, s.caret) + s.text.slice(s.caret + 1)
  return { text, caret: s.caret, anchor: s.caret }
}

/**
 * The state after an editing key: caret moves (arrows, Home, End, with Shift
 * extending the selection and Meta or Ctrl jumping to the ends), Backspace,
 * Delete, select-all (Meta or Ctrl plus A) and typed characters. A typed
 * character that `accept` rejects leaves the state as it is but still counts
 * as handled, so a number field swallows letters. Returns null for keys that
 * are not edits (Enter, Escape, Tab, ArrowUp, ...), which the widget decides.
 */
export function editKey(
  s: TextEditState,
  e: UIKitKeyEvent,
  accept: (ch: string) => boolean = () => true,
): TextEditState | null {
  const jump = e.metaKey || e.ctrlKey
  switch (e.key) {
    case 'ArrowLeft': {
      if (jump) return setCaret(s, 0, e.shiftKey)
      if (hasSelection(s) && !e.shiftKey) return setCaret(s, selectionOf(s)[0])
      return setCaret(s, s.caret - 1, e.shiftKey)
    }
    case 'ArrowRight': {
      if (jump) return setCaret(s, s.text.length, e.shiftKey)
      if (hasSelection(s) && !e.shiftKey) return setCaret(s, selectionOf(s)[1])
      return setCaret(s, s.caret + 1, e.shiftKey)
    }
    case 'Home':
      return setCaret(s, 0, e.shiftKey)
    case 'End':
      return setCaret(s, s.text.length, e.shiftKey)
    case 'Backspace':
      return deleteBackward(s)
    case 'Delete':
      return deleteForward(s)
    default:
      break
  }
  if (jump) {
    if (e.key === 'a' || e.key === 'A') return selectAll(s)
    return null
  }
  if (e.key.length !== 1) return null
  return accept(e.key) ? insertText(s, e.key) : s
}

/** The advance of each code unit of `text` at `sizePx` (0 for a glyph the font lacks). */
export function glyphAdvances(
  metrics: UIKitFontMetrics,
  text: string,
  sizePx: number,
): number[] {
  const out: number[] = []
  for (let i = 0; i < text.length; i++) {
    const g = metrics.glyphs.get(text[i])
    out.push(g ? g.xadv * sizePx : 0)
  }
  return out
}

/** Width of the glyphs from index `from` up to (not including) `to`. */
export function advanceBetween(
  advances: readonly number[],
  from: number,
  to: number,
): number {
  let w = 0
  for (let i = Math.max(0, from); i < Math.min(advances.length, to); i++) {
    w += advances[i]
  }
  return w
}

/**
 * The caret index nearest to `px`, measured from the left edge of the glyph
 * at `first`: a point past the middle of a glyph lands after it.
 */
export function caretIndexAt(
  advances: readonly number[],
  first: number,
  px: number,
): number {
  let x = 0
  for (let i = Math.max(0, first); i < advances.length; i++) {
    if (px < x + advances[i] / 2) return i
    x += advances[i]
  }
  return advances.length
}

/**
 * The run of whole glyphs a field of `viewport` width shows, starting at
 * `first` but scrolled the least distance that keeps the caret in view: the
 * caret's glyph becomes the first shown when the caret lies before the run,
 * and the glyph before the caret becomes the last shown when it lies after.
 */
export function textWindow(
  advances: readonly number[],
  viewport: number,
  first: number,
  caret: number,
): ScrollWindow {
  const w = scrollWindow(advances, viewport, first)
  if (caret < w.first) return scrollWindow(advances, viewport, caret)
  if (caret > w.end) {
    return scrollWindow(
      advances,
      viewport,
      revealRow(advances, viewport, w, caret - 1),
    )
  }
  return w
}
