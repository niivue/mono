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

import type { UIKitOverlayFrame, UIKitOverlayRenderer } from '@niivue/niivue'
import type {
  UIKitInteractive,
  UIKitKeyEvent,
  UIKitRedrawSource,
} from './controls'
import { type ClipboardBridge, createBrowserClipboard } from './host'
import {
  UIKitDrawBundle,
  UIKitEntryMap,
  type UIKitGeometry,
} from './overlayParts'
import { type UIKitBox, unscaleBox } from './rect'
import { scrollWindow, WheelAccumulator } from './scroll'
import type { UIKitFont } from './text/font'
import {
  buildTextArea,
  DEFAULT_TEXT_AREA_STYLE,
  layoutTextArea,
  resolveTextAreaStyle,
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
  clipboardEdit,
  clipboardKey,
  glyphAdvances,
  maxLengthOf,
  pasteText,
  sameValue,
  selectAll,
  setCaret,
  type TextEditState,
  textEditState,
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

export class UIKitTextAreaOverlay
  implements UIKitOverlayRenderer, UIKitInteractive
{
  private readonly font: UIKitFont
  private readonly bundle: UIKitDrawBundle
  private readonly entries: UIKitEntryMap<TextAreaLayout, TextAreaEntry>
  private baseStyle: TextAreaStyle
  private readonly doubleClickMs: number
  private readonly now: () => number
  private layer: UIKitRedrawSource | null = null
  private clipboard: ClipboardBridge | null
  private hoverId: string | null = null
  private hoverScrollbarId: string | null = null
  private focusedId: string | null = null
  /** The held press, which drags the selection. */
  private pressId: string | null = null
  /** The held scrollbar thumb and the pointer's offset from its top edge. */
  private scrollDrag: { id: string; offsetY: number } | null = null
  private lastDownId: string | null = null
  private lastDownAt = Number.NEGATIVE_INFINITY

  constructor(font: UIKitFont, options: UIKitTextAreaOverlayOptions = {}) {
    this.font = font
    this.bundle = new UIKitDrawBundle(font, options.requestRedraw)
    this.entries = new UIKitEntryMap((entry, scale) => {
      const { spec, style } = scaleTextArea(entry.spec, entry.style, scale)
      return layoutTextArea(spec, style, font.metrics)
    }, options.cssUnits ?? false)
    this.baseStyle = resolveTextAreaStyle(
      DEFAULT_TEXT_AREA_STYLE,
      options.style,
    )
    this.doubleClickMs = options.doubleClickMs ?? 400
    this.now = options.now ?? (() => performance.now())
    this.clipboard = options.clipboard ?? null
  }

  /** CSS cursor while a field is hovered: resize over a scrollbar thumb. */
  get hoverCursor(): string {
    return this.scrollDrag || this.hoverScrollbarId !== null
      ? 'ns-resize'
      : 'text'
  }

  /** Replace the default style for every area (per-spec overrides still win). */
  setDefaultStyle(style: Partial<TextAreaStyle>): void {
    this.baseStyle = resolveTextAreaStyle(DEFAULT_TEXT_AREA_STYLE, style)
    for (const entry of this.entries.values()) {
      entry.style = resolveTextAreaStyle(this.baseStyle, entry.spec.style)
      this.resetLayout(entry)
    }
    this.invalidate()
  }

  /**
   * Add an area, or replace the one with the same id. A replacement takes
   * the new spec's text and ends any edit in progress.
   */
  addTextArea(spec: TextAreaSpec): void {
    const existing = this.entries.get(spec.id)
    if (existing) {
      this.respec(existing, spec)
      existing.value = truncateText(spec.value ?? '', spec.maxLength)
      existing.firstRow = 0
      existing.manualScroll = false
      if (existing.edit) existing.edit = this.freshEdit(existing)
      return
    }
    this.entries.set(spec.id, {
      spec,
      style: resolveTextAreaStyle(this.baseStyle, spec.style),
      layout: null,
      value: truncateText(spec.value ?? '', spec.maxLength),
      edit: null,
      session: 0,
      firstRow: 0,
      goalX: null,
      upstream: false,
      hover: false,
      wheelCarry: null,
      manualScroll: false,
    })
    this.invalidate()
  }

  /**
   * Replace the whole area set. A kept id whose spec leaves the committed
   * text alone (no `value`, or the same one) keeps any edit in progress, as
   * `updateTextArea` does; a different `value` replaces it as `addTextArea`
   * does.
   */
  setTextAreas(specs: readonly TextAreaSpec[]): void {
    this.entries.replaceAll(
      specs,
      (spec) => {
        const entry = this.entries.get(spec.id)
        if (entry && sameValue(entry.value, spec)) this.respec(entry, spec)
        else this.addTextArea(spec)
      },
      (id) => this.removeTextArea(id),
    )
  }

  removeTextArea(id: string): void {
    if (!this.entries.delete(id)) return
    if (this.pressId === id) this.pressId = null
    if (this.scrollDrag?.id === id) this.scrollDrag = null
    if (this.hoverId === id) this.hoverId = null
    if (this.hoverScrollbarId === id) this.hoverScrollbarId = null
    if (this.focusedId === id) this.focusedId = null
    this.invalidate()
  }

  /**
   * Patch one area's spec (label, position, rows, placeholder, enabled, ...).
   * The committed text is kept unless the patch sets `value`.
   */
  updateTextArea(id: string, patch: Partial<Omit<TextAreaSpec, 'id'>>): void {
    const entry = this.entries.get(id)
    if (!entry) return
    const spec = { ...entry.spec, ...patch, id }
    // A patch that leaves the value alone (a host re-laying out on resize)
    // must not throw away what the user is typing, or a paste on its way.
    if (patch.value === undefined) this.respec(entry, spec)
    else this.addTextArea(spec)
  }

  setEnabled(id: string, enabled: boolean): void {
    this.updateTextArea(id, { enabled })
  }

  /** Set an area's text from code. Fires no callback; a focused field shows it selected. */
  setValue(id: string, value: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    const v = truncateText(value, entry.spec.maxLength)
    if (v === entry.value && !entry.edit) return
    entry.value = v
    entry.firstRow = 0
    if (entry.edit) entry.edit = this.freshEdit(entry)
    this.invalidate()
  }

  /** The committed text. */
  getValue(id: string): string | undefined {
    return this.entries.get(id)?.value
  }

  /** The text the field shows: the edit in progress, or the committed text. */
  getText(id: string): string | undefined {
    const entry = this.entries.get(id)
    if (!entry) return undefined
    return entry.edit ? entry.edit.text : entry.value
  }

  /** The ids of all areas, in draw order. */
  get ids(): string[] {
    return this.entries.ids
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
   * Give an area keyboard focus with its whole text selected, or null to
   * clear. Leaving an area commits its edit. Disabled areas refuse.
   */
  focus(id: string | null): void {
    const entry = id !== null ? this.entries.get(id) : undefined
    const next = entry && entry.spec.enabled !== false ? id : null
    if (next === this.focusedId) return
    const prev =
      this.focusedId !== null ? this.entries.get(this.focusedId) : undefined
    if (prev) this.commit(prev, false)
    this.focusedId = next
    if (entry && next !== null) {
      entry.edit = this.freshEdit(entry)
      this.layer?.focus?.(this)
    }
    this.invalidate()
  }

  hitTest(x: number, y: number): boolean {
    return this.hitEntry(x, y) !== null
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

  pointerCancel(): void {
    if (this.scrollDrag) {
      this.scrollDrag = null
      this.invalidate()
      return
    }
    if (this.pressId === null) return
    this.pressId = null
    this.invalidate()
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
   * Editing keys change the text; Meta or Ctrl plus Enter commits and
   * submits; Escape reverts.
   */
  keyDown(e: UIKitKeyEvent): boolean {
    if (this.focusedId === null) return false
    const entry = this.entries.get(this.focusedId)
    if (!entry || entry.spec.enabled === false || !entry.edit) return false
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      this.commit(entry, true)
      entry.spec.onSubmit?.(entry.value, entry.spec.id)
      return true
    }
    if (e.key === 'Escape') {
      entry.edit = this.freshEdit(entry)
      this.invalidate()
      return true
    }
    const clip = clipboardKey(e)
    if (clip !== null) {
      this.clipboard ??= createBrowserClipboard()
      const id = entry.spec.id
      clipboardEdit(
        this.clipboard,
        entry,
        clip,
        () => this.entries.get(id) === entry && this.focusedId === id,
        (text) => this.paste(text),
        (next) => {
          entry.goalX = null
          entry.upstream = false
          this.applyEdit(entry, next)
        },
      )
      return true
    }
    const { style } = this.scaled(entry)
    const layout = this.entries.layoutOf(entry)
    const advances = glyphAdvances(
      this.font.metrics,
      entry.edit.text,
      style.textSizePx,
    )
    const result = textAreaKey(
      entry.edit,
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

  /**
   * Paste text into the focused area from code, as a host that catches the
   * DOM paste event itself would. Line breaks are kept as newlines; the
   * spec's `accept` and `maxLength` apply.
   */
  paste(text: string): boolean {
    if (this.focusedId === null) return false
    const entry = this.entries.get(this.focusedId)
    if (!entry || entry.spec.enabled === false || !entry.edit) return false
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

  /** Commits the edit in progress and drops focus. */
  blur(): void {
    this.focus(null)
  }

  bindLayer(layer: UIKitRedrawSource): void {
    this.bundle.bind(layer)
    this.layer = layer
  }

  drawOverlay(frame: UIKitOverlayFrame): void {
    if (this.entries.size === 0) return
    const rescaled = this.entries.rescale(frame.dpr)
    if (rescaled)
      for (const entry of this.entries.values()) this.resetLayout(entry)
    this.bundle.draw(frame, () => this.geometry(), rescaled)
  }

  /** Release GPU resources on both backends. */
  destroy(): void {
    // A clipboard read still in flight must not edit a destroyed overlay.
    this.focusedId = null
    this.bundle.destroy()
  }

  /** Take a new edit state, redrawing and firing `onInput` when the text changed. */
  private applyEdit(entry: TextAreaEntry, next: TextEditState): void {
    if (!entry.edit || next === entry.edit) return
    const textChanged = next.text !== entry.edit.text
    entry.edit = next
    entry.manualScroll = false
    this.invalidate()
    if (textChanged) entry.spec.onInput?.(next.text, entry.spec.id)
  }

  private invalidate(): void {
    this.bundle.invalidate()
  }

  /**
   * Take a new spec, keeping the committed text, edit, session and scroll
   * (trimmed to the spec's maxLength). Disabling drops press and focus.
   */
  private respec(entry: TextAreaEntry, spec: TextAreaSpec): void {
    entry.spec = spec
    entry.style = resolveTextAreaStyle(this.baseStyle, spec.style)
    entry.layout = null
    entry.wheelCarry = null
    entry.goalX = null
    entry.value = truncateText(entry.value, spec.maxLength)
    if (entry.edit) {
      const caret = entry.edit.caret
      entry.edit = truncateEdit(entry.edit, spec.maxLength)
      // Affinity only counts at a soft-row end the caret still sits on.
      if (entry.edit.caret !== caret) entry.upstream = false
    }
    if (spec.enabled === false) {
      if (this.pressId === spec.id) this.pressId = null
      if (this.focusedId === spec.id) {
        entry.edit = null
        this.focusedId = null
      }
    }
    this.invalidate()
  }

  private resetLayout(entry: TextAreaEntry): void {
    entry.layout = null
    entry.wheelCarry = null
    entry.manualScroll = false
  }

  /** The edit state for a freshly focused (or reverted) area: all selected. */
  private freshEdit(entry: TextAreaEntry): TextEditState {
    entry.firstRow = 0
    entry.goalX = null
    entry.upstream = false
    entry.manualScroll = false
    entry.session++
    return selectAll(textEditState(entry.value))
  }

  /**
   * Commit the edit: changed text becomes the value and fires `onChange`.
   * When the area stays focused the text is selected again.
   */
  private commit(entry: TextAreaEntry, stayFocused: boolean): void {
    if (entry.edit && entry.edit.text !== entry.value) {
      entry.value = entry.edit.text
      entry.spec.onChange?.(entry.value, entry.spec.id)
    }
    entry.edit = stayFocused ? this.freshEdit(entry) : null
    entry.firstRow = 0
    this.invalidate()
  }

  private shownText(entry: TextAreaEntry): string {
    return entry.edit ? entry.edit.text : entry.value
  }

  private rowsOf(entry: TextAreaEntry) {
    const { style } = this.scaled(entry)
    return textAreaRows(
      this.entries.layoutOf(entry),
      style,
      this.font.metrics,
      this.shownText(entry),
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
      this.shownText(entry),
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

  private scaled(entry: TextAreaEntry): {
    spec: TextAreaSpec
    style: TextAreaStyle
  } {
    return scaleTextArea(entry.spec, entry.style, this.entries.scale)
  }

  /** The topmost (last added) enabled area whose field is under a canvas point. */
  private hitEntry(x: number, y: number): TextAreaEntry | null {
    return this.entries.topmost(textAreaContains, x, y)
  }

  private *geometry(): Generator<UIKitGeometry> {
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
        text: this.shownText(entry),
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
