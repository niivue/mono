// A UIKit overlay of number inputs drawn into the scene through the niivue
// overlay hook: a bordered field showing a number, with a spinner at its right
// end. A press on the text takes keyboard focus and selects the whole number
// (a second press places the caret; dragging selects); typing then edits the
// text, which is checked as a number on every keystroke (the border turns red
// while it is not one). Enter commits, Escape reverts to the committed value,
// and losing focus commits. ArrowUp/Down (Shift: ten steps), PageUp/PageDown,
// the spinner buttons and the wheel over a focused field step the value and
// commit at once. `onInput` fires as the typed number changes, `onChange` once
// per committed change. Add it to a `UIKitControls` layer with the other
// widgets, or feed the pointer and keyboard entry points from any host.

import type { UIKitOverlayFrame, UIKitOverlayRenderer } from '@niivue/niivue'
import type {
  UIKitInteractive,
  UIKitKeyEvent,
  UIKitRedrawSource,
} from './controls'
import type { LineData } from './line'
import { UIKitLineOverlay } from './lineOverlay'
import {
  acceptNumberChar,
  buildNumberInput,
  DEFAULT_NUMBER_INPUT_STYLE,
  formatNumberInput,
  layoutNumberInput,
  type NumberInputLayout,
  type NumberInputSpec,
  type NumberInputStyle,
  numberInputCaretAt,
  numberInputContains,
  numberInputSpinAt,
  numberInputTextWindow,
  parseNumberInput,
  resolveNumberInputStyle,
  scaleNumberInput,
  snapNumberInput,
  stepNumberInput,
} from './numberInput'
import type { RectData } from './rect'
import { UIKitRectOverlay } from './rectOverlay'
import { WheelAccumulator } from './scroll'
import type { UIKitFont } from './text/font'
import {
  editKey,
  selectAll,
  setCaret,
  type TextEditState,
  textEditState,
} from './textEdit'
import { type UIKitTextItem, UIKitTextOverlay } from './textOverlay'

export interface UIKitNumberInputOverlayOptions {
  /** Called whenever the overlay needs another frame. A control layer fills it in. */
  requestRedraw?: () => void
  /** Default style for every input; a spec's `style` overrides per key. */
  style?: Partial<NumberInputStyle>
  /**
   * Interpret spec positions and style lengths as CSS pixels and scale them by
   * the frame's device pixel ratio, instead of canvas pixels.
   */
  cssUnits?: boolean
  /** Wheel pixels per step over a focused field. Default 40. */
  wheelStepPx?: number
}

interface NumberInputEntry {
  spec: NumberInputSpec
  style: NumberInputStyle
  layout: NumberInputLayout | null
  /** The committed value. */
  value: number
  /** The edit in progress while focused, else null. */
  edit: TextEditState | null
  /** The last value `onInput` reported (or the committed one). */
  lastInput: number
  firstGlyph: number
  hover: boolean
  spinHover: 1 | -1 | 0
}

export class UIKitNumberInputOverlay
  implements UIKitOverlayRenderer, UIKitInteractive
{
  private readonly font: UIKitFont
  private readonly rects = new UIKitRectOverlay()
  private readonly lines = new UIKitLineOverlay()
  private readonly labels: UIKitTextOverlay
  private readonly entries = new Map<string, NumberInputEntry>()
  private baseStyle: NumberInputStyle
  private readonly cssUnits: boolean
  private readonly wheelCarry: WheelAccumulator
  private requestRedraw: (() => void) | null
  private layer: UIKitRedrawSource | null = null
  private scale = 1
  private geometryDirty = true
  private hoverId: string | null = null
  private cursor = 'text'
  private focusedId: string | null = null
  /** The held press: which input and what part of it. */
  private pressId: string | null = null
  private pressPart: 'text' | 1 | -1 = 'text'

  constructor(font: UIKitFont, options: UIKitNumberInputOverlayOptions = {}) {
    this.font = font
    this.labels = new UIKitTextOverlay(font)
    this.baseStyle = resolveNumberInputStyle(
      DEFAULT_NUMBER_INPUT_STYLE,
      options.style,
    )
    this.cssUnits = options.cssUnits ?? false
    this.requestRedraw = options.requestRedraw ?? null
    this.wheelCarry = new WheelAccumulator(options.wheelStepPx ?? 40)
  }

  /** CSS cursor for the hovered part: a text beam over the field, a pointer over the spinner. */
  get hoverCursor(): string {
    return this.cursor
  }

  /** Replace the default style for every input (per-spec overrides still win). */
  setDefaultStyle(style: Partial<NumberInputStyle>): void {
    this.baseStyle = resolveNumberInputStyle(DEFAULT_NUMBER_INPUT_STYLE, style)
    for (const entry of this.entries.values()) {
      entry.style = resolveNumberInputStyle(this.baseStyle, entry.spec.style)
      entry.layout = null
    }
    this.invalidate()
  }

  /**
   * Add an input, or replace the one with the same id. The spec's `value` is
   * clamped and snapped; a replacement takes the new spec's value and ends
   * any edit in progress.
   */
  addNumberInput(spec: NumberInputSpec): void {
    const existing = this.entries.get(spec.id)
    const style = resolveNumberInputStyle(this.baseStyle, spec.style)
    const value = snapNumberInput(spec, spec.value)
    if (existing) {
      existing.spec = spec
      existing.style = style
      existing.layout = null
      existing.value = value
      existing.lastInput = value
      existing.firstGlyph = 0
      if (existing.edit) existing.edit = this.freshEdit(existing)
    } else {
      this.entries.set(spec.id, {
        spec,
        style,
        layout: null,
        value,
        edit: null,
        lastInput: value,
        firstGlyph: 0,
        hover: false,
        spinHover: 0,
      })
    }
    this.invalidate()
  }

  /** Replace the whole input set. */
  setNumberInputs(specs: readonly NumberInputSpec[]): void {
    const keep = new Set(specs.map((s) => s.id))
    for (const id of [...this.entries.keys()]) {
      if (!keep.has(id)) this.removeNumberInput(id)
    }
    for (const spec of specs) this.addNumberInput(spec)
  }

  removeNumberInput(id: string): void {
    if (!this.entries.delete(id)) return
    if (this.pressId === id) this.pressId = null
    if (this.hoverId === id) this.hoverId = null
    if (this.focusedId === id) this.focusedId = null
    this.invalidate()
  }

  /**
   * Patch one input's spec (label, position, range, step, enabled, ...). The
   * committed value is kept (re-snapped to the new range) unless the patch
   * sets `value`.
   */
  updateNumberInput(
    id: string,
    patch: Partial<Omit<NumberInputSpec, 'id'>>,
  ): void {
    const entry = this.entries.get(id)
    if (!entry) return
    const value = patch.value ?? entry.value
    // A patch that leaves the value alone (a host re-laying out on resize)
    // must not throw away what the user is typing.
    const edit = patch.value === undefined ? entry.edit : null
    this.addNumberInput({ ...entry.spec, ...patch, id, value })
    if (edit && entry.edit) entry.edit = edit
    if (entry.spec.enabled === false) {
      if (this.pressId === id) this.pressId = null
      if (this.focusedId === id) {
        entry.edit = null
        this.focusedId = null
      }
    }
  }

  setEnabled(id: string, enabled: boolean): void {
    this.updateNumberInput(id, { enabled })
  }

  /** Set an input's value from code (clamped and snapped). Fires neither callback. */
  setValue(id: string, value: number): void {
    const entry = this.entries.get(id)
    if (!entry) return
    const v = snapNumberInput(entry.spec, value)
    if (v === entry.value && !entry.edit) return
    entry.value = v
    entry.lastInput = v
    entry.firstGlyph = 0
    if (entry.edit) entry.edit = this.freshEdit(entry)
    this.invalidate()
  }

  /** The committed value. */
  getValue(id: string): number | undefined {
    return this.entries.get(id)?.value
  }

  /** The text the field shows: the edit in progress, or the formatted value. */
  getText(id: string): string | undefined {
    const entry = this.entries.get(id)
    if (!entry) return undefined
    return entry.edit ? entry.edit.text : this.display(entry)
  }

  /** The ids of all inputs, in draw order. */
  get ids(): string[] {
    return [...this.entries.keys()]
  }

  /** An input's boxes in spec units (canvas pixels, or CSS pixels with `cssUnits`). */
  getLayout(id: string): NumberInputLayout | null {
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
      spinUp: box(l.spinUp),
      spinDown: box(l.spinDown),
      baseline: l.baseline / k,
    }
  }

  /** The input with keyboard focus (being edited), if any. */
  get focusedInput(): string | null {
    return this.focusedId
  }

  /**
   * Give an input keyboard focus with its whole number selected, or null to
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
   * On the spinner: steps and commits. On the text: focuses (selecting all),
   * or places the caret when already focused, and starts a drag selection.
   */
  pointerDown(x: number, y: number): boolean {
    const entry = this.hitEntry(x, y)
    if (!entry) return false
    const layout = this.layoutOf(entry)
    const spin = numberInputSpinAt(layout, x, y)
    const wasFocused = this.focusedId === entry.spec.id
    this.pressId = entry.spec.id
    this.pressPart = spin === 0 ? 'text' : spin
    // Focusing selects all, which would scroll to the end; a press keeps the
    // glyphs the user is looking at so a drag starts where they pressed.
    const first = entry.firstGlyph
    this.focus(entry.spec.id)
    entry.firstGlyph = first
    if (spin !== 0) {
      this.step(entry, spin, false)
    } else if (wasFocused && entry.edit) {
      entry.edit = setCaret(entry.edit, this.caretAt(entry, x))
      this.firstShown(entry)
    }
    this.invalidate()
    return true
  }

  pointerMove(x: number, y: number): boolean {
    if (this.pressId !== null) {
      const entry = this.entries.get(this.pressId)
      if (entry && this.pressPart === 'text' && entry.edit) {
        const next = setCaret(entry.edit, this.dragCaretAt(entry, x), true)
        if (next.caret !== entry.edit.caret) {
          entry.edit = next
          this.firstShown(entry)
          this.invalidate()
        }
      }
      return true
    }
    const hit = this.hitEntry(x, y)
    const id = hit ? hit.spec.id : null
    const spin = hit ? numberInputSpinAt(this.layoutOf(hit), x, y) : 0
    const cursor = spin === 0 ? 'text' : 'pointer'
    if (id !== this.hoverId || (hit && hit.spinHover !== spin)) {
      const prev = this.hoverId ? this.entries.get(this.hoverId) : null
      if (prev) {
        prev.hover = false
        prev.spinHover = 0
      }
      if (hit) {
        hit.hover = true
        hit.spinHover = spin
      }
      this.hoverId = id
      this.invalidate()
    }
    this.cursor = cursor
    return false
  }

  pointerUp(x: number, y: number): boolean {
    if (this.pressId === null) return false
    this.pressId = null
    this.invalidate()
    this.pointerMove(x, y)
    return true
  }

  pointerCancel(): void {
    if (this.pressId === null) return
    this.pressId = null
    this.invalidate()
  }

  /**
   * Editing keys change the text; Enter commits; Escape reverts; ArrowUp and
   * ArrowDown step (Shift: ten steps), as do PageUp and PageDown.
   */
  /** Enter commits the field and, in a dialog, submits it. */
  submitsForm(e: UIKitKeyEvent): boolean {
    return e.key === 'Enter'
  }

  keyDown(e: UIKitKeyEvent): boolean {
    if (this.focusedId === null) return false
    const entry = this.entries.get(this.focusedId)
    if (!entry || entry.spec.enabled === false || !entry.edit) return false
    switch (e.key) {
      case 'Enter':
        this.commit(entry, true)
        return true
      case 'Escape':
        entry.edit = this.freshEdit(entry)
        this.invalidate()
        return true
      case 'ArrowUp':
        this.step(entry, 1, e.shiftKey)
        return true
      case 'ArrowDown':
        this.step(entry, -1, e.shiftKey)
        return true
      case 'PageUp':
        this.step(entry, 1, true)
        return true
      case 'PageDown':
        this.step(entry, -1, true)
        return true
      default:
        break
    }
    const next = editKey(entry.edit, e, acceptNumberChar)
    if (next === null) return false
    if (next !== entry.edit) {
      const textChanged = next.text !== entry.edit.text
      entry.edit = next
      this.firstShown(entry)
      this.invalidate()
      if (textChanged) this.reportInput(entry)
    }
    return true
  }

  /** The wheel over a focused field steps it (the page scrolls elsewhere). */
  wheel(x: number, y: number, _deltaX: number, deltaY: number): boolean {
    const entry = this.hitEntry(x, y)
    if (!entry || entry.spec.id !== this.focusedId) return false
    const steps = this.wheelCarry.add(deltaY)
    for (let i = 0; i < Math.abs(steps); i++) {
      this.step(entry, steps < 0 ? 1 : -1, false)
    }
    return true
  }

  /** Commits the edit in progress and drops focus. */
  blur(): void {
    this.focus(null)
  }

  bindLayer(layer: UIKitRedrawSource): void {
    this.requestRedraw ??= () => layer.requestRedraw()
    this.layer = layer
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
    this.lines.drawOverlay(frame)
    this.labels.drawOverlay(frame)
  }

  /** Release GPU resources on both backends. */
  destroy(): void {
    this.rects.destroy()
    this.lines.destroy()
    this.labels.destroy()
  }

  private invalidate(): void {
    this.geometryDirty = true
    this.requestRedraw?.()
  }

  private display(entry: NumberInputEntry): string {
    return formatNumberInput(entry.spec, entry.value)
  }

  /** The edit state for a freshly focused (or reverted) input: all selected. */
  private freshEdit(entry: NumberInputEntry): TextEditState {
    entry.firstGlyph = 0
    return selectAll(textEditState(this.display(entry)))
  }

  /** The typed text as a snapped value, or NaN while it is not a number. */
  private typedValue(entry: NumberInputEntry): number {
    if (!entry.edit) return entry.value
    const raw = parseNumberInput(entry.spec, entry.edit.text)
    return Number.isFinite(raw) ? snapNumberInput(entry.spec, raw) : Number.NaN
  }

  /** Fire `onInput` when the typed number differs from the last one reported. */
  private reportInput(entry: NumberInputEntry): void {
    const v = this.typedValue(entry)
    if (!Number.isFinite(v) || v === entry.lastInput) return
    entry.lastInput = v
    entry.spec.onInput?.(v, entry.spec.id)
  }

  /**
   * Commit the edit: a valid number becomes the value (firing `onChange` if
   * it changed), invalid text reverts. The text is re-formatted and, when the
   * input stays focused, selected again.
   */
  private commit(entry: NumberInputEntry, stayFocused: boolean): void {
    const v = this.typedValue(entry)
    if (Number.isFinite(v) && v !== entry.value) {
      entry.value = v
      if (entry.lastInput !== v) {
        entry.lastInput = v
        entry.spec.onInput?.(v, entry.spec.id)
      }
      entry.spec.onChange?.(v, entry.spec.id)
    }
    entry.lastInput = entry.value
    entry.edit = stayFocused ? this.freshEdit(entry) : null
    entry.firstGlyph = 0
    this.invalidate()
  }

  /** Step from the typed number (or the value when the text is invalid) and commit. */
  private step(entry: NumberInputEntry, direction: 1 | -1, big: boolean): void {
    const base = this.typedValue(entry)
    const from = Number.isFinite(base) ? base : entry.value
    const next = stepNumberInput(entry.spec, from, direction, big)
    if (next !== entry.value) {
      entry.value = next
      entry.lastInput = next
      entry.spec.onInput?.(next, entry.spec.id)
      entry.spec.onChange?.(next, entry.spec.id)
    } else {
      entry.lastInput = next
    }
    if (entry.edit) entry.edit = this.freshEdit(entry)
    this.invalidate()
  }

  /** The caret for a drag: a pointer left of the shown text pulls one hidden glyph into view. */
  private dragCaretAt(entry: NumberInputEntry, x: number): number {
    const caret = this.caretAt(entry, x)
    const first = entry.firstGlyph
    const pastLeft = first > 0 && x < this.layoutOf(entry).textArea.x
    return pastLeft && caret === first ? first - 1 : caret
  }

  private caretAt(entry: NumberInputEntry, x: number): number {
    const { style } = this.scaled(entry)
    const text = entry.edit ? entry.edit.text : this.display(entry)
    return numberInputCaretAt(
      this.layoutOf(entry),
      style,
      this.font.metrics,
      text,
      entry.firstGlyph,
      x,
    )
  }

  /**
   * Settle the scroll position for the next frame: the stored first glyph,
   * moved the least distance that keeps the caret in view. Every caret move
   * (key edit, press, drag) settles, so `firstGlyph` is always the window
   * the next frame shows and pointer math can read it as is; `rebuild` settles
   * again for caret moves that bypass this (focus, step, commit).
   */
  private firstShown(entry: NumberInputEntry): number {
    const { style } = this.scaled(entry)
    const text = entry.edit ? entry.edit.text : this.display(entry)
    entry.firstGlyph = numberInputTextWindow(
      this.layoutOf(entry),
      style,
      this.font.metrics,
      text,
      entry.firstGlyph,
      entry.edit ? entry.edit.caret : 0,
    ).first
    return entry.firstGlyph
  }

  private scaled(entry: NumberInputEntry): {
    spec: NumberInputSpec
    style: NumberInputStyle
  } {
    return scaleNumberInput(entry.spec, entry.style, this.scale)
  }

  private layoutOf(entry: NumberInputEntry): NumberInputLayout {
    if (!entry.layout) {
      const { spec, style } = this.scaled(entry)
      entry.layout = layoutNumberInput(spec, style, this.font.metrics)
    }
    return entry.layout
  }

  /** The topmost (last added) enabled input whose field is under a canvas point. */
  private hitEntry(x: number, y: number): NumberInputEntry | null {
    const list = [...this.entries.values()]
    for (let i = list.length - 1; i >= 0; i--) {
      const entry = list[i]
      if (entry.spec.enabled === false) continue
      if (numberInputContains(this.layoutOf(entry), x, y)) return entry
    }
    return null
  }

  private rebuild(): void {
    const rects: RectData[] = []
    const lines: LineData[] = []
    const text: UIKitTextItem[] = []
    for (const entry of this.entries.values()) {
      const { spec, style } = this.scaled(entry)
      const layout = this.layoutOf(entry)
      const shown = entry.edit ? entry.edit.text : this.display(entry)
      this.firstShown(entry)
      const id = entry.spec.id
      const geo = buildNumberInput(spec, style, layout, this.font.metrics, {
        text: shown,
        edit: entry.edit,
        firstGlyph: entry.firstGlyph,
        valid: !entry.edit || Number.isFinite(this.typedValue(entry)),
        hover: entry.hover,
        spinHover: entry.spinHover,
        spinPressed:
          this.pressId === id && this.pressPart !== 'text' ? this.pressPart : 0,
        enabled: entry.spec.enabled !== false,
      })
      rects.push(...geo.rects)
      lines.push(...geo.lines)
      text.push(...geo.text)
    }
    this.rects.setRects(rects)
    this.lines.setLines(lines)
    this.labels.setItems(text)
    this.geometryDirty = false
  }
}
