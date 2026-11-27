// A UIKit overlay of multi-line text areas drawn into the scene through the
// niivue overlay hook: a bordered field of a fixed number of rows with an
// optional label above it. Text soft-wraps at the field's width and scrolls
// by whole rows (the wheel scrolls a hovered area; the caret is kept in view
// while editing), with a scrollbar once the rows overflow. A press on the
// field takes keyboard focus and places the caret at the pointer (a second
// press within the double-click interval selects all; dragging selects);
// typing then edits the text, with Enter inserting a newline, the arrows,
// Home, End, PageUp and PageDown moving the caret (Shift extends the
// selection, Meta or Ctrl jumps to the text's ends), and Backspace, Delete
// and select-all from the shared text-edit model. Meta or Ctrl plus Enter
// commits (firing `onChange` when the text changed, then `onSubmit`), Escape
// reverts to the committed text, and losing focus commits. `onInput` fires on
// every keystroke that changes the text. Meta or Ctrl plus C, X and V copy,
// cut and paste through a clipboard bridge (the browser's async clipboard
// unless the host supplies one). There is no IME composition, since no DOM
// element backs the field. Add it
// to a `UIKitControls` layer with the other widgets, or feed the pointer,
// keyboard and wheel entry points from any host.

import type { UIKitKeyEvent } from './controls'
import { UIKitFieldOverlay } from './fieldOverlay'
import type { ClipboardBridge } from './host'
import type { UIKitGeometry } from './overlayParts'
import { type UIKitBox, unscaleBox } from './rect'
import { scrollWindow, WheelAccumulator } from './scroll'
import type { UIKitFont } from './text/font'
import {
  buildTextArea,
  DEFAULT_TEXT_AREA_STYLE,
  layoutTextArea,
  scaleTextArea,
  type TextAreaLayout,
  type TextAreaSpec,
  type TextAreaStyle,
  type TextAreaVisual,
  textAreaCaretAt,
  textAreaContains,
  textAreaKey,
  textAreaRows,
  textAreaScrollbar,
  textAreaWindow,
} from './textArea'
import {
  glyphAdvances,
  maxLengthOf,
  pasteText,
  selectAll,
  setCaret,
  type TextEditState,
  truncateEdit,
  truncateText,
} from './textEdit'

export interface UIKitTextAreaOverlayOptions {
  /** Called whenever the overlay needs another frame. A control layer fills it in. */
  requestRedraw?: () => void
  /** Default style for every area; a spec's `style` overrides per key. */
  style?: Partial<TextAreaStyle>
  /**
   * Interpret spec positions and style lengths as CSS pixels and scale them by
   * the frame's device pixel ratio, instead of canvas pixels.
   */
  cssUnits?: boolean
  /** Two presses on a focused field within this many ms select all. Default 400. */
  doubleClickMs?: number
  /** Clock for the double-click interval. Default `performance.now`. */
  now?: () => number
  /** Where copy, cut and paste go. Default: the browser's async clipboard. */
  clipboard?: ClipboardBridge
}

interface TextAreaEntry {
  spec: TextAreaSpec
  style: TextAreaStyle
  layout: TextAreaLayout | null
  /** The committed text. */
  value: string
  /** The edit in progress while focused, else null. */
  edit: TextEditState | null
  /** Bumped whenever an edit starts, so a slow paste read knows its session is over. */
  session: number
  firstRow: number
  /** The x a run of vertical caret moves aims for, else null. */
  goalX: number | null
  /** The caret at a soft break shows at the end of the upper row. */
  upstream: boolean
  hover: boolean
  wheelCarry: WheelAccumulator | null
  /** A wheel or thumb drag intentionally moved the viewport away from the caret. */
  manualScroll: boolean
}

// The visible thumb is intentionally slim. Its pointer target reaches into
// the empty gutter beside the text so it remains usable at normal DPR.
const SCROLLBAR_HIT_PADDING = 8

const MODEL = {
  defaultStyle: DEFAULT_TEXT_AREA_STYLE,
  scale: scaleTextArea,
  layout: layoutTextArea,
  contains: textAreaContains,
}

export class UIKitTextAreaOverlay extends UIKitFieldOverlay<
  string,
  TextAreaSpec,
  TextAreaStyle,
  TextAreaLayout,
  TextAreaEntry
> {
  private readonly doubleClickMs: number
  private readonly now: () => number
  private hoverScrollbarId: string | null = null
  /** The held scrollbar thumb and the pointer's offset from its top edge. */
  private scrollDrag: { id: string; offsetY: number } | null = null
  private lastDownId: string | null = null
  private lastDownAt = Number.NEGATIVE_INFINITY

  constructor(font: UIKitFont, options: UIKitTextAreaOverlayOptions = {}) {
    super(font, MODEL, options)
    this.doubleClickMs = options.doubleClickMs ?? 400
    this.now = options.now ?? (() => performance.now())
  }

  /** CSS cursor while a field is hovered: resize over a scrollbar thumb. */
  get hoverCursor(): string {
    return this.scrollDrag || this.hoverScrollbarId !== null
      ? 'ns-resize'
      : 'text'
  }

  /**
   * Add an area, or replace the one with the same id. A replacement takes
   * the new spec's text and ends any edit in progress.
   */
  addTextArea(spec: TextAreaSpec): void {
    this.add(spec)
  }

  /**
   * Replace the whole area set. A kept id whose spec leaves the committed
   * text alone (no `value`, or the same one) keeps any edit in progress, as
   * `updateTextArea` does; a different `value` replaces it as `addTextArea`
   * does.
   */
  setTextAreas(specs: readonly TextAreaSpec[]): void {
    this.setAll(specs)
  }

  removeTextArea(id: string): void {
    this.remove(id)
  }

  /**
   * Patch one area's spec (label, position, rows, placeholder, enabled, ...).
   * The committed text is kept unless the patch sets `value`.
   */
  updateTextArea(id: string, patch: Partial<Omit<TextAreaSpec, 'id'>>): void {
    this.update(id, patch)
  }

  setEnabled(id: string, enabled: boolean): void {
    this.updateTextArea(id, { enabled })
  }

  /** An area's boxes in spec units (canvas pixels, or CSS pixels with `cssUnits`). */
  getLayout(id: string): TextAreaLayout | null {
    const entry = this.entries.get(id)
    if (!entry) return null
    const l = this.entries.layoutOf(entry)
    const k = this.entries.scale
    if (k === 1) return l
    const box = (b: UIKitBox) => unscaleBox(b, k)
    return {
      ...box(l),
      field: box(l.field),
      textArea: box(l.textArea),
      labelBaseline: l.labelBaseline / k,
      rowHeight: l.rowHeight / k,
      rows: l.rows,
    }
  }

  /** Index of the first row an area shows. */
  getFirstRow(id: string): number | undefined {
    return this.entries.get(id)?.firstRow
  }

  /** The area with keyboard focus (being edited), if any. */
  get focusedArea(): string | null {
    return this.focusedId
  }

  /**
   * Focuses the field and places the caret at the pointer, starting a drag
   * selection; a second press within the double-click interval selects all.
   */
  pointerDown(x: number, y: number): boolean {
    const entry = this.hitEntry(x, y)
    if (!entry) return false
    const scrollbar = this.scrollbarOf(entry)
    if (scrollbar && this.thumbContains(scrollbar, x, y)) {
      this.scrollDrag = { id: entry.spec.id, offsetY: y - scrollbar.thumb.y }
      this.hoverScrollbarId = entry.spec.id
      entry.manualScroll = true
      this.invalidate()
      return true
    }
    const id = entry.spec.id
    const t = this.now()
    const twice =
      this.lastDownId === id && t - this.lastDownAt <= this.doubleClickMs
    this.lastDownId = id
    this.lastDownAt = t
    this.pressId = id
    // Focusing selects all and rewinds the scroll; a press keeps the rows
    // the user is looking at so the caret lands where they pressed.
    const firstRow = entry.firstRow
    this.focus(id)
    entry.firstRow = firstRow
    if (entry.edit) {
      entry.manualScroll = false
      const hit = this.caretAt(entry, x, y)
      entry.edit = twice
        ? selectAll(entry.edit)
        : setCaret(entry.edit, hit.caret)
      entry.goalX = null
      entry.upstream = !twice && hit.upstream
    }
    this.invalidate()
    return true
  }

  pointerMove(x: number, y: number): boolean {
    if (this.scrollDrag) {
      const entry = this.entries.get(this.scrollDrag.id)
      if (entry) this.setScrollFromThumb(entry, y - this.scrollDrag.offsetY)
      return true
    }
    if (this.pressId !== null) {
      const entry = this.entries.get(this.pressId)
      if (entry?.edit) {
        const hit = this.caretAt(entry, x, y)
        const next = setCaret(entry.edit, hit.caret, true)
        if (
          next.caret !== entry.edit.caret ||
          hit.upstream !== entry.upstream
        ) {
          entry.edit = next
          entry.goalX = null
          entry.upstream = hit.upstream
          this.invalidate()
        }
      }
      return true
    }
    const hit = this.hitEntry(x, y)
    const id = hit ? hit.spec.id : null
    const overScrollbar =
      hit && this.thumbContains(this.scrollbarOf(hit), x, y)
        ? hit.spec.id
        : null
    if (id !== this.hoverId) {
      const prev = this.hoverId ? this.entries.get(this.hoverId) : null
      if (prev) {
        prev.hover = false
        prev.wheelCarry?.reset()
      }
      if (hit) hit.hover = true
      this.hoverId = id
      this.invalidate()
    }
    if (overScrollbar !== this.hoverScrollbarId) {
      this.hoverScrollbarId = overScrollbar
      this.invalidate()
    }
    return false
  }

  pointerUp(x: number, y: number): boolean {
    if (this.scrollDrag) {
      const drag = this.scrollDrag
      this.scrollDrag = null
      const entry = this.entries.get(drag.id)
      if (entry) this.setScrollFromThumb(entry, y - drag.offsetY)
      this.pointerMove(x, y)
      return true
    }
    if (this.pressId === null) return false
    this.pressId = null
    this.pointerMove(x, y)
    return true
  }

  override pointerCancel(): void {
    if (this.scrollDrag) {
      this.scrollDrag = null
      this.invalidate()
      return
    }
    super.pointerCancel()
  }

  /** Scrolls the area under the pointer by whole rows. True when one is there. */
  wheel(x: number, y: number, _deltaX: number, deltaY: number): boolean {
    const entry = this.hitEntry(x, y)
    if (!entry) return false
    const layout = this.entries.layoutOf(entry)
    entry.wheelCarry ??= new WheelAccumulator(layout.rowHeight)
    const steps = entry.wheelCarry.add(deltaY)
    if (steps !== 0) {
      const rows = this.rowsOf(entry)
      const heights = rows.map(() => layout.rowHeight)
      const next = scrollWindow(
        heights,
        layout.textArea.height,
        entry.firstRow + steps,
      ).first
      if (next !== entry.firstRow) {
        entry.firstRow = next
        entry.manualScroll = true
        this.invalidate()
      }
    }
    return true
  }

  /** Meta or Ctrl plus Enter submits a dialog; a plain Enter is a new line. */
  submitsForm(e: UIKitKeyEvent): boolean {
    return e.key === 'Enter' && (e.metaKey || e.ctrlKey)
  }

  /**
   * Paste text into the focused area from code, as a host that catches the
   * DOM paste event itself would. Line breaks are kept as newlines; the
   * spec's `accept` and `maxLength` apply.
   */
  paste(text: string): boolean {
    const entry = this.editing()
    if (!entry?.edit) return false
    const next = pasteText(
      entry.edit,
      text.replace(/\r\n?/g, '\n'),
      entry.spec.accept,
      entry.spec.maxLength,
    )
    // A paste that changes nothing keeps the caret's row and goal x.
    if (next !== entry.edit) {
      entry.goalX = null
      entry.upstream = false
    }
    this.applyEdit(entry, next)
    return true
  }

  /** Arrows, Home, End and the pages move by rows; other keys edit the text. */
  protected editKey(
    entry: TextAreaEntry,
    edit: TextEditState,
    e: UIKitKeyEvent,
  ): boolean {
    const { style } = this.scaled(entry)
    const layout = this.entries.layoutOf(entry)
    const advances = glyphAdvances(
      this.font.metrics,
      edit.text,
      style.textSizePx,
    )
    const result = textAreaKey(
      edit,
      e,
      this.rowsOf(entry),
      advances,
      entry.goalX,
      entry.upstream,
      layout.rows,
      entry.spec.accept,
    )
    if (result === null) return false
    const next = result.state
    const max = maxLengthOf(entry.spec.maxLength)
    if (max !== undefined && next.text.length > max) return true
    entry.goalX = result.goalX
    entry.upstream = result.upstream
    this.applyEdit(entry, next)
    return true
  }

  /** Meta or Ctrl plus Enter: commit, then `onSubmit` with the committed text. */
  protected override submit(entry: TextAreaEntry): void {
    this.commit(entry, true)
    entry.spec.onSubmit?.(entry.value, entry.spec.id)
  }

  protected override cut(entry: TextAreaEntry, next: TextEditState): void {
    entry.goalX = null
    entry.upstream = false
    this.applyEdit(entry, next)
  }

  protected normalize(spec: TextAreaSpec, raw: string | undefined): string {
    return truncateText(raw ?? '', spec.maxLength)
  }

  protected display(entry: TextAreaEntry): string {
    return entry.value
  }

  protected newEntry(
    spec: TextAreaSpec,
    style: TextAreaStyle,
    value: string,
  ): TextAreaEntry {
    return {
      spec,
      style,
      layout: null,
      value,
      edit: null,
      session: 0,
      firstRow: 0,
      goalX: null,
      upstream: false,
      hover: false,
      wheelCarry: null,
      manualScroll: false,
    }
  }

  /** Take a new edit state, redrawing and firing `onInput` when the text changed. */
  protected applyEdit(entry: TextAreaEntry, next: TextEditState): void {
    if (!entry.edit || next === entry.edit) return
    const textChanged = next.text !== entry.edit.text
    entry.edit = next
    entry.manualScroll = false
    this.invalidate()
    if (textChanged) entry.spec.onInput?.(next.text, entry.spec.id)
  }

  /** Also trims an edit in progress (and its caret affinity) to the spec's maxLength. */
  protected override respec(entry: TextAreaEntry, spec: TextAreaSpec): void {
    super.respec(entry, spec)
    entry.wheelCarry = null
    entry.goalX = null
    if (entry.edit) {
      const caret = entry.edit.caret
      entry.edit = truncateEdit(entry.edit, spec.maxLength)
      // Affinity only counts at a soft-row end the caret still sits on.
      if (entry.edit.caret !== caret) entry.upstream = false
    }
  }

  protected override remove(id: string): void {
    if (this.scrollDrag?.id === id) this.scrollDrag = null
    if (this.hoverScrollbarId === id) this.hoverScrollbarId = null
    super.remove(id)
  }

  protected override relayout(entry: TextAreaEntry): void {
    entry.layout = null
    entry.wheelCarry = null
    entry.manualScroll = false
  }

  protected rewind(entry: TextAreaEntry): void {
    entry.firstRow = 0
    entry.goalX = null
    entry.upstream = false
    entry.manualScroll = false
  }

  /**
   * Commit the edit: changed text becomes the value and fires `onChange`.
   * When the area stays focused the text is selected again.
   */
  protected commit(entry: TextAreaEntry, stayFocused: boolean): void {
    if (entry.edit && entry.edit.text !== entry.value) {
      entry.value = entry.edit.text
      entry.spec.onChange?.(entry.value, entry.spec.id)
    }
    entry.edit = stayFocused ? this.freshEdit(entry) : null
    entry.firstRow = 0
    this.invalidate()
  }

  private rowsOf(entry: TextAreaEntry) {
    const { style } = this.scaled(entry)
    return textAreaRows(
      this.entries.layoutOf(entry),
      style,
      this.font.metrics,
      this.shown(entry),
    )
  }

  private caretAt(
    entry: TextAreaEntry,
    x: number,
    y: number,
  ): { caret: number; upstream: boolean } {
    const { style } = this.scaled(entry)
    return textAreaCaretAt(
      this.entries.layoutOf(entry),
      style,
      this.font.metrics,
      this.shown(entry),
      entry.firstRow,
      x,
      y,
    )
  }

  /** Current thumb geometry, or null when the text fits without scrolling. */
  private scrollbarOf(entry: TextAreaEntry) {
    const { style } = this.scaled(entry)
    const layout = this.entries.layoutOf(entry)
    const rows = this.rowsOf(entry)
    const shown = textAreaWindow(
      layout,
      rows,
      entry.firstRow,
      entry.edit && !entry.manualScroll ? entry.edit.caret : null,
      entry.upstream,
    )
    return textAreaScrollbar(layout, style, shown, rows.length)
  }

  /** Hit-test the visible thumb plus a gutter-sized pointer target. */
  private thumbContains(
    scrollbar: ReturnType<UIKitTextAreaOverlay['scrollbarOf']>,
    x: number,
    y: number,
  ): boolean {
    if (!scrollbar) return false
    const { track, thumb } = scrollbar
    const left = track.x - SCROLLBAR_HIT_PADDING
    const right = track.x + track.width
    const top = Math.max(track.y, thumb.y - SCROLLBAR_HIT_PADDING)
    const bottom = Math.min(
      track.y + track.height,
      thumb.y + thumb.height + SCROLLBAR_HIT_PADDING,
    )
    return x >= left && x < right && y >= top && y < bottom
  }

  /** Map a dragged thumb top to the nearest whole-row viewport position. */
  private setScrollFromThumb(entry: TextAreaEntry, thumbY: number): void {
    const scrollbar = this.scrollbarOf(entry)
    if (!scrollbar) return
    const travel = scrollbar.track.height - scrollbar.thumb.height
    const top = Math.max(
      scrollbar.track.y,
      Math.min(thumbY, scrollbar.track.y + travel),
    )
    const fraction = travel > 0 ? (top - scrollbar.track.y) / travel : 0
    const next = Math.round(fraction * scrollbar.maxFirst)
    if (next === entry.firstRow) return
    entry.firstRow = next
    entry.manualScroll = true
    this.invalidate()
  }

  protected *geometry(): Generator<UIKitGeometry> {
    for (const entry of this.entries.values()) {
      const { spec, style } = this.scaled(entry)
      const layout = this.entries.layoutOf(entry)
      // Keep the scroll position between frames so the text does not jump,
      // moving it only as far as the caret needs.
      entry.firstRow = textAreaWindow(
        layout,
        this.rowsOf(entry),
        entry.firstRow,
        entry.edit && !entry.manualScroll ? entry.edit.caret : null,
        entry.upstream,
      ).first
      const visual: TextAreaVisual = {
        text: this.shown(entry),
        edit: entry.edit,
        firstRow: entry.firstRow,
        upstream: entry.upstream,
        revealCaret: !entry.manualScroll,
        hover: entry.hover,
        enabled: entry.spec.enabled !== false,
      }
      const geo = buildTextArea(spec, style, layout, this.font.metrics, visual)
      yield { ...geo, lines: [] }
    }
  }
}
