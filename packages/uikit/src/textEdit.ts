// Pure single-line text editing model shared by UIKit's text-entry widgets
// (number inputs, text inputs and, by row, text areas): a string with a caret and a
// selection anchor, the edits a key press makes to it, the mapping from a
// pointer x to a caret, and the whole-glyph horizontal scrolling that keeps
// the caret in view (through the shared scroll model, so an overflowing field
// draws only the glyphs that fit and needs no GPU scissor). No GPU and no DOM
// here. Caret indices are UTF-16 code unit offsets into `text`, always on a
// grapheme cluster boundary so an emoji, flag or accented letter edits as one.

import type { UIKitKeyEvent } from './controls'
import { revealRow, type ScrollWindow, scrollWindow } from './scroll'
import type { UIKitFontMetrics } from './text/font'
import { measureWidth } from './text/layout'

const segmenter =
  typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('und', { granularity: 'grapheme' })
    : null

/** The grapheme clusters of `text` (code points where Intl.Segmenter is missing). */
function clusters(text: string): Iterable<string> {
  return segmenter
    ? Array.from(segmenter.segment(text), (g) => g.segment)
    : text
}

/** [start, end) of the cluster holding code unit `i` (0 <= i < text.length). */
// ponytail: linear scan per lookup, fine for field-sized text. Not
// Segments.containing(): Bun's returns a merged segment for a fresh Segments.
function clusterAt(text: string, i: number): [number, number] {
  let start = 0
  for (const c of clusters(text)) {
    const end = start + c.length
    if (end > i) return [start, end]
    start = end
  }
  return [start, start]
}

/** The cluster boundary before `i`. */
export function prevBoundary(text: string, i: number): number {
  return i <= 0 ? 0 : clusterAt(text, Math.min(i, text.length) - 1)[0]
}

/** The cluster boundary after `i`. */
export function nextBoundary(text: string, i: number): number {
  return i >= text.length ? text.length : clusterAt(text, Math.max(0, i))[1]
}

/** `i` moved to the start (or with `up`, the end) of the cluster it splits. */
export function snapToBoundary(text: string, i: number, up = false): number {
  if (i <= 0 || i >= text.length) return i
  const [start, end] = clusterAt(text, i)
  return start === i ? i : up ? end : start
}

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
  return snapToBoundary(text, Math.max(0, Math.min(text.length, Math.floor(i))))
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
  const caret = snapToBoundary(text, a + str.length, true)
  return { text, caret, anchor: caret }
}

/** Delete the selection, or the character before the caret. */
export function deleteBackward(s: TextEditState): TextEditState {
  if (hasSelection(s)) return insertText(s, '')
  if (s.caret === 0) return s
  return insertText({ ...s, anchor: prevBoundary(s.text, s.caret) }, '')
}

/** Delete the selection, or the character after the caret. */
export function deleteForward(s: TextEditState): TextEditState {
  if (hasSelection(s)) return insertText(s, '')
  if (s.caret >= s.text.length) return s
  return insertText({ ...s, anchor: nextBoundary(s.text, s.caret) }, '')
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
      return setCaret(s, prevBoundary(s.text, s.caret), e.shiftKey)
    }
    case 'ArrowRight': {
      if (jump) return setCaret(s, s.text.length, e.shiftKey)
      if (hasSelection(s) && !e.shiftKey) return setCaret(s, selectionOf(s)[1])
      return setCaret(s, nextBoundary(s.text, s.caret), e.shiftKey)
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
  // AltGr arrives as Ctrl plus Alt on Windows: with it, a character is
  // typed (@, {, [, \ or ~ on a German or French keyboard), not a shortcut.
  const altGr = e.ctrlKey && e.altKey && !e.metaKey && e.key.length === 1
  if (jump && !altGr) {
    if (e.key === 'a' || e.key === 'A') return selectAll(s)
    return null
  }
  if (e.key.length !== 1) return null
  return accept(e.key) ? insertText(s, e.key) : s
}

/** The selected text, empty when nothing is selected. */
export function selectedText(s: TextEditState): string {
  const [a, b] = selectionOf(s)
  return s.text.slice(a, b)
}

/** The clipboard action a key asks for: Meta or Ctrl plus C, X or V. */
export function clipboardKey(
  e: UIKitKeyEvent,
): 'copy' | 'cut' | 'paste' | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null
  switch (e.key) {
    case 'c':
    case 'C':
      return 'copy'
    case 'x':
    case 'X':
      return 'cut'
    case 'v':
    case 'V':
      return 'paste'
    default:
      return null
  }
}

/**
 * A usable `maxLength`: a non-negative finite count, else undefined (no
 * limit), so a NaN or negative option neither empties the field nor blocks
 * every key.
 */
export function maxLengthOf(maxLength: number | undefined): number | undefined {
  return maxLength !== undefined && Number.isFinite(maxLength) && maxLength >= 0
    ? Math.floor(maxLength)
    : undefined
}

/** `text` cut to `maxLength` (see `maxLengthOf`); the same string when it fits. */
export function truncateText(
  text: string,
  maxLength: number | undefined,
): string {
  const max = maxLengthOf(maxLength)
  return max === undefined ? text : text.slice(0, snapToBoundary(text, max))
}

/**
 * An edit carried across a `maxLength` change: the text cut to the limit with
 * the caret and anchor still inside it. The same state when nothing changes.
 */
export function truncateEdit(
  s: TextEditState,
  maxLength: number | undefined,
): TextEditState {
  const text = truncateText(s.text, maxLength)
  if (text === s.text) return s
  return {
    text,
    caret: Math.min(s.caret, text.length),
    anchor: Math.min(s.anchor, text.length),
  }
}

/**
 * Replace the selection with the characters of `str` that `accept` allows,
 * as many as keep the text within `maxLength` (pasting into a full field
 * inserts nothing).
 */
export function pasteText(
  s: TextEditState,
  str: string,
  accept: (ch: string) => boolean = () => true,
  maxLength?: number,
): TextEditState {
  let kept = [...str].filter(accept).join('')
  maxLength = maxLengthOf(maxLength)
  if (maxLength !== undefined) {
    const [a, b] = selectionOf(s)
    const room = Math.max(0, maxLength - (s.text.length - (b - a)))
    kept = kept.slice(0, snapToBoundary(kept, room))
  }
  return kept === '' && !hasSelection(s) ? s : insertText(s, kept)
}

/**
 * The advance of each code unit of `text` at `sizePx`: a cluster's whole
 * width (its code points' glyphs, as layoutText draws them; 0 for glyphs the
 * font lacks) on its first unit and 0 on the rest, so scrolling and wrapping
 * by advance never stop inside a cluster.
 */
export function glyphAdvances(
  metrics: UIKitFontMetrics,
  text: string,
  sizePx: number,
): number[] {
  const out: number[] = []
  for (const c of clusters(text)) {
    out.push(measureWidth(metrics, c, sizePx))
    for (let k = 1; k < c.length; k++) out.push(0)
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
  text: string,
  advances: readonly number[],
  first: number,
  px: number,
): number {
  let x = 0
  for (let i = Math.max(0, first); i < advances.length; i++) {
    // A cluster's trailing units are zero-width: reaching one means past its middle.
    if (px < x + advances[i] / 2) return snapToBoundary(text, i, true)
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
  text: string,
  advances: readonly number[],
  viewport: number,
  first: number,
  caret: number,
): ScrollWindow {
  // Skipping a cluster's zero-width trailing units changes no width, so only
  // `first` moves; `end` already stops at a cluster start.
  const fit = (f: number): ScrollWindow => {
    const w = scrollWindow(advances, viewport, snapToBoundary(text, f, true))
    return { ...w, first: snapToBoundary(text, w.first, true) }
  }
  const w = fit(first)
  if (caret < w.first) return fit(caret)
  if (caret > w.end) return fit(revealRow(advances, viewport, w, caret - 1))
  return w
}
