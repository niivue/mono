// A UIKit overlay of single-line text inputs drawn into the scene through the
// niivue overlay hook: a bordered field with an optional label. A press on
// the field takes keyboard focus and places the caret at the pointer (a
// second press within the double-click interval selects all; dragging
// selects); typing then edits the text, with the arrows, Home, End, Shift
// selection, Backspace, Delete and select-all handled by the shared text-edit
// model. Enter commits (firing `onChange` when the text changed, then
// `onSubmit`), Escape reverts to the committed text, and losing focus
// commits. `onInput` fires on every keystroke that changes the text. Entry
// is keyboard-only: there is no paste and no IME composition, since no DOM
// input backs the field. Add it to a `UIKitControls` layer with the other
// widgets, or feed the pointer and keyboard entry points from any host.

import type { UIKitOverlayFrame, UIKitOverlayRenderer } from '@niivue/niivue'
import type {
  UIKitInteractive,
  UIKitKeyEvent,
  UIKitRedrawSource,
} from './controls'
import type { RectData } from './rect'
import { UIKitRectOverlay } from './rectOverlay'
import type { UIKitFont } from './text/font'
import {
  editKey,
  selectAll,
  setCaret,
  type TextEditState,
  textEditState,
} from './textEdit'
import {
  buildTextInput,
  DEFAULT_TEXT_INPUT_STYLE,
  layoutTextInput,
  resolveTextInputStyle,
  scaleTextInput,
  type TextInputLayout,
  type TextInputSpec,
  type TextInputStyle,
  type TextInputVisual,
  textInputCaretAt,
  textInputContains,
  textInputTextWindow,
} from './textInput'
import { type UIKitTextItem, UIKitTextOverlay } from './textOverlay'

export interface UIKitTextInputOverlayOptions {
  /** Called whenever the overlay needs another frame. A control layer fills it in. */
  requestRedraw?: () => void
  /** Default style for every input; a spec's `style` overrides per key. */
  style?: Partial<TextInputStyle>
  /**
   * Interpret spec positions and style lengths as CSS pixels and scale them by
   * the frame's device pixel ratio, instead of canvas pixels.
   */
  cssUnits?: boolean
  /** Two presses on a focused field within this many ms select all. Default 400. */
  doubleClickMs?: number
  /** Clock for the double-click interval. Default `performance.now`. */
  now?: () => number
}

interface TextInputEntry {
  spec: TextInputSpec
  style: TextInputStyle
  layout: TextInputLayout | null
  /** The committed text. */
  value: string
  /** The edit in progress while focused, else null. */
  edit: TextEditState | null
  firstGlyph: number
  hover: boolean
}

export class UIKitTextInputOverlay
  implements UIKitOverlayRenderer, UIKitInteractive
{
  private readonly font: UIKitFont
  private readonly rects = new UIKitRectOverlay()
  private readonly labels: UIKitTextOverlay
  private readonly entries = new Map<string, TextInputEntry>()
  private baseStyle: TextInputStyle
  private readonly cssUnits: boolean
  private readonly doubleClickMs: number
  private readonly now: () => number
  private requestRedraw: (() => void) | null
  private scale = 1
  private geometryDirty = true
  private hoverId: string | null = null
  private focusedId: string | null = null
  /** The held press, which drags the selection. */
  private pressId: string | null = null
  private lastDownId: string | null = null
  private lastDownAt = Number.NEGATIVE_INFINITY

  constructor(font: UIKitFont, options: UIKitTextInputOverlayOptions = {}) {
    this.font = font
    this.labels = new UIKitTextOverlay(font)
    this.baseStyle = resolveTextInputStyle(
      DEFAULT_TEXT_INPUT_STYLE,
      options.style,
    )
    this.cssUnits = options.cssUnits ?? false
    this.doubleClickMs = options.doubleClickMs ?? 400
    this.now = options.now ?? (() => performance.now())
    this.requestRedraw = options.requestRedraw ?? null
  }

  /** CSS cursor while a field is hovered: a text beam. */
  get hoverCursor(): string {
    return 'text'
  }

  /** Replace the default style for every input (per-spec overrides still win). */
  setDefaultStyle(style: Partial<TextInputStyle>): void {
    this.baseStyle = resolveTextInputStyle(DEFAULT_TEXT_INPUT_STYLE, style)
    for (const entry of this.entries.values()) {
      entry.style = resolveTextInputStyle(this.baseStyle, entry.spec.style)
      entry.layout = null
    }
    this.invalidate()
  }

  /**
   * Add an input, or replace the one with the same id. A replacement takes
   * the new spec's text and ends any edit in progress.
   */
  addTextInput(spec: TextInputSpec): void {
    const existing = this.entries.get(spec.id)
    const style = resolveTextInputStyle(this.baseStyle, spec.style)
    const value = this.truncate(spec, spec.value ?? '')
    if (existing) {
      existing.spec = spec
      existing.style = style
      existing.layout = null
      existing.value = value
      existing.firstGlyph = 0
      if (existing.edit) existing.edit = this.freshEdit(existing)
    } else {
      this.entries.set(spec.id, {
        spec,
        style,
        layout: null,
        value,
        edit: null,
        firstGlyph: 0,
        hover: false,
      })
    }
    this.invalidate()
  }

  /** Replace the whole input set. */
  setTextInputs(specs: readonly TextInputSpec[]): void {
    const keep = new Set(specs.map((s) => s.id))
    for (const id of [...this.entries.keys()]) {
      if (!keep.has(id)) this.removeTextInput(id)
    }
    for (const spec of specs) this.addTextInput(spec)
  }

  removeTextInput(id: string): void {
    if (!this.entries.delete(id)) return
    if (this.pressId === id) this.pressId = null
    if (this.hoverId === id) this.hoverId = null
    if (this.focusedId === id) this.focusedId = null
    this.invalidate()
  }

  /**
   * Patch one input's spec (label, position, placeholder, enabled, ...). The
   * committed text is kept unless the patch sets `value`.
   */
  updateTextInput(id: string, patch: Partial<Omit<TextInputSpec, 'id'>>): void {
    const entry = this.entries.get(id)
    if (!entry) return
    const value = patch.value ?? entry.value
    this.addTextInput({ ...entry.spec, ...patch, id, value })
    if (entry.spec.enabled === false) {
      if (this.pressId === id) this.pressId = null
      if (this.focusedId === id) {
        entry.edit = null
        this.focusedId = null
      }
    }
  }

  setEnabled(id: string, enabled: boolean): void {
    this.updateTextInput(id, { enabled })
  }

  /** Set an input's text from code. Fires no callback; a focused field shows it selected. */
  setValue(id: string, value: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    const v = this.truncate(entry.spec, value)
    if (v === entry.value && !entry.edit) return
    entry.value = v
    entry.firstGlyph = 0
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

  /** The ids of all inputs, in draw order. */
  get ids(): string[] {
    return [...this.entries.keys()]
  }

  /** An input's boxes in spec units (canvas pixels, or CSS pixels with `cssUnits`). */
  getLayout(id: string): TextInputLayout | null {
    const entry = this.entries.get(id)
    if (!entry) return null
    const l = this.layoutOf(entry)
    const k = this.scale
    if (k === 1) return l
    const box = (b: {
      x: number
      y: number
      width: number
      height: number
    }) => ({
      x: b.x / k,
      y: b.y / k,
      width: b.width / k,
      height: b.height / k,
    })
    return {
      ...box(l),
      field: box(l.field),
      textArea: box(l.textArea),
      baseline: l.baseline / k,
    }
  }

  /** The input with keyboard focus (being edited), if any. */
  get focusedInput(): string | null {
    return this.focusedId
  }

  /**
   * Give an input keyboard focus with its whole text selected, or null to
   * clear. Leaving an input commits its edit. Disabled inputs refuse.
   */
  focus(id: string | null): void {
    const entry = id !== null ? this.entries.get(id) : undefined
    const next = entry && entry.spec.enabled !== false ? id : null
    if (next === this.focusedId) return
    const prev =
      this.focusedId !== null ? this.entries.get(this.focusedId) : undefined
    if (prev) this.commit(prev, false)
    this.focusedId = next
    if (entry && next !== null) entry.edit = this.freshEdit(entry)
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
    const id = entry.spec.id
    const t = this.now()
    const twice =
      this.lastDownId === id && t - this.lastDownAt <= this.doubleClickMs
    this.lastDownId = id
    this.lastDownAt = t
    this.pressId = id
    this.focus(id)
    if (entry.edit) {
      entry.edit = twice
        ? selectAll(entry.edit)
        : setCaret(entry.edit, this.caretAt(entry, x))
    }
    this.invalidate()
    return true
  }

  pointerMove(x: number, y: number): boolean {
    if (this.pressId !== null) {
      const entry = this.entries.get(this.pressId)
      if (entry?.edit) {
        const next = setCaret(entry.edit, this.caretAt(entry, x), true)
        if (next.caret !== entry.edit.caret) {
          entry.edit = next
          this.invalidate()
        }
      }
      return true
    }
    const hit = this.hitEntry(x, y)
    const id = hit ? hit.spec.id : null
    if (id !== this.hoverId) {
      const prev = this.hoverId ? this.entries.get(this.hoverId) : null
      if (prev) prev.hover = false
      if (hit) hit.hover = true
      this.hoverId = id
      this.invalidate()
    }
    return false
  }

  pointerUp(x: number, y: number): boolean {
    if (this.pressId === null) return false
    this.pressId = null
    this.pointerMove(x, y)
    return true
  }

  pointerCancel(): void {
    if (this.pressId === null) return
    this.pressId = null
    this.invalidate()
  }

  /** Editing keys change the text; Enter commits and submits; Escape reverts. */
  keyDown(e: UIKitKeyEvent): boolean {
    if (this.focusedId === null) return false
    const entry = this.entries.get(this.focusedId)
    if (!entry || entry.spec.enabled === false || !entry.edit) return false
    if (e.key === 'Enter') {
      this.commit(entry, true)
      entry.spec.onSubmit?.(entry.value, entry.spec.id)
      return true
    }
    if (e.key === 'Escape') {
      entry.edit = this.freshEdit(entry)
      this.invalidate()
      return true
    }
    const next = editKey(entry.edit, e, entry.spec.accept)
    if (next === null) return false
    const max = entry.spec.maxLength
    if (max !== undefined && next.text.length > max) return true
    if (next !== entry.edit) {
      const textChanged = next.text !== entry.edit.text
      entry.edit = next
      this.invalidate()
      if (textChanged) entry.spec.onInput?.(next.text, entry.spec.id)
    }
    return true
  }

  /** Commits the edit in progress and drops focus. */
  blur(): void {
    this.focus(null)
  }

  bindLayer(layer: UIKitRedrawSource): void {
    this.requestRedraw ??= () => layer.requestRedraw()
  }

  drawOverlay(frame: UIKitOverlayFrame): void {
    if (this.entries.size === 0) return
    const scale = this.cssUnits ? frame.dpr : 1
    if (scale !== this.scale) {
      this.scale = scale
      for (const entry of this.entries.values()) entry.layout = null
      this.geometryDirty = true
    }
    if (this.geometryDirty) this.rebuild()
    this.rects.drawOverlay(frame)
    this.labels.drawOverlay(frame)
  }

  /** Release GPU resources on both backends. */
  destroy(): void {
    this.rects.destroy()
    this.labels.destroy()
  }

  private invalidate(): void {
    this.geometryDirty = true
    this.requestRedraw?.()
  }

  private truncate(spec: TextInputSpec, text: string): string {
    return spec.maxLength === undefined ? text : text.slice(0, spec.maxLength)
  }

  /** The edit state for a freshly focused (or reverted) input: all selected. */
  private freshEdit(entry: TextInputEntry): TextEditState {
    entry.firstGlyph = 0
    return selectAll(textEditState(entry.value))
  }

  /**
   * Commit the edit: changed text becomes the value and fires `onChange`.
   * When the input stays focused the text is selected again.
   */
  private commit(entry: TextInputEntry, stayFocused: boolean): void {
    if (entry.edit && entry.edit.text !== entry.value) {
      entry.value = entry.edit.text
      entry.spec.onChange?.(entry.value, entry.spec.id)
    }
    entry.edit = stayFocused ? this.freshEdit(entry) : null
    entry.firstGlyph = 0
    this.invalidate()
  }

  private caretAt(entry: TextInputEntry, x: number): number {
    const { style } = this.scaled(entry)
    const text = entry.edit ? entry.edit.text : entry.value
    return textInputCaretAt(
      this.layoutOf(entry),
      style,
      this.font.metrics,
      text,
      entry.firstGlyph,
      x,
    )
  }

  private scaled(entry: TextInputEntry): {
    spec: TextInputSpec
    style: TextInputStyle
  } {
    return scaleTextInput(entry.spec, entry.style, this.scale)
  }

  private layoutOf(entry: TextInputEntry): TextInputLayout {
    if (!entry.layout) {
      const { spec, style } = this.scaled(entry)
      entry.layout = layoutTextInput(spec, style, this.font.metrics)
    }
    return entry.layout
  }

  /** The topmost (last added) enabled input whose field is under a canvas point. */
  private hitEntry(x: number, y: number): TextInputEntry | null {
    const list = [...this.entries.values()]
    for (let i = list.length - 1; i >= 0; i--) {
      const entry = list[i]
      if (entry.spec.enabled === false) continue
      if (textInputContains(this.layoutOf(entry), x, y)) return entry
    }
    return null
  }

  private rebuild(): void {
    const rects: RectData[] = []
    const text: UIKitTextItem[] = []
    for (const entry of this.entries.values()) {
      const { spec, style } = this.scaled(entry)
      const layout = this.layoutOf(entry)
      const shown = entry.edit ? entry.edit.text : entry.value
      // Keep the scroll position between frames so the text does not jump.
      entry.firstGlyph = textInputTextWindow(
        layout,
        style,
        this.font.metrics,
        shown,
        entry.firstGlyph,
        entry.edit ? entry.edit.caret : 0,
      ).first
      const visual: TextInputVisual = {
        text: shown,
        edit: entry.edit,
        firstGlyph: entry.firstGlyph,
        hover: entry.hover,
        enabled: entry.spec.enabled !== false,
      }
      const geo = buildTextInput(spec, style, layout, this.font.metrics, visual)
      rects.push(...geo.rects)
      text.push(...geo.text)
    }
    this.rects.setRects(rects)
    this.labels.setItems(text)
    this.geometryDirty = false
  }
}
