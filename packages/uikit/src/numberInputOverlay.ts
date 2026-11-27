// A UIKit overlay of number inputs drawn into the scene through the niivue
// overlay hook: a bordered field showing a number, with a spinner at its right
// end. A press on the text takes keyboard focus and selects the whole number
// (a second press places the caret; dragging selects); typing then edits the
// text, which is checked as a number on every keystroke (the border turns red
// while it is not one). Enter commits, Escape reverts to the committed value,
// and losing focus commits. ArrowUp/Down (Shift: ten steps), PageUp/PageDown,
// the spinner buttons and the wheel over a focused field step the value and
// commit at once. `onInput` fires as the typed number changes, `onChange` once
// per committed change. Meta or Ctrl plus C, X and V copy, cut and paste
// through a clipboard bridge (the browser's async clipboard unless the host
// supplies one; a paste keeps only the characters a number can hold). Add it
// to a `UIKitControls` layer with the other widgets, or feed the pointer and
// keyboard entry points from any host.

import type { UIKitKeyEvent } from './controls'
import { UIKitLineFieldOverlay } from './fieldOverlay'
import type { ClipboardBridge } from './host'
import {
  acceptNumberChar,
  buildNumberInput,
  DEFAULT_NUMBER_INPUT_STYLE,
  formatNumberInput,
  layoutNumberInput,
  type NumberInputLayout,
  type NumberInputSpec,
  type NumberInputStyle,
  numberInputContains,
  numberInputSpinAt,
  parseNumberInput,
  resolveNumberInputStyle,
  scaleNumberInput,
  snapNumberInput,
  stepNumberInput,
} from './numberInput'
import type { UIKitGeometry } from './overlayParts'
import { type UIKitBox, unscaleBox } from './rect'
import { WheelAccumulator } from './scroll'
import type { UIKitFont } from './text/font'
import { editKey, pasteText, setCaret, type TextEditState } from './textEdit'

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
  /** Where copy, cut and paste go. Default: the browser's async clipboard. */
  clipboard?: ClipboardBridge
}

interface NumberInputEntry {
  spec: NumberInputSpec
  style: NumberInputStyle
  layout: NumberInputLayout | null
  /** The committed value. */
  value: number
  /** The edit in progress while focused, else null. */
  edit: TextEditState | null
  /** Bumped whenever an edit starts, so a slow paste read knows its session is over. */
  session: number
  /** The last value `onInput` reported (or the committed one). */
  lastInput: number
  firstGlyph: number
  hover: boolean
  spinHover: 1 | -1 | 0
}

const MODEL = {
  defaultStyle: DEFAULT_NUMBER_INPUT_STYLE,
  resolveStyle: resolveNumberInputStyle,
  scale: scaleNumberInput,
  layout: layoutNumberInput,
  contains: numberInputContains,
}

export class UIKitNumberInputOverlay extends UIKitLineFieldOverlay<
  number,
  NumberInputSpec,
  NumberInputStyle,
  NumberInputLayout,
  NumberInputEntry
> {
  private readonly wheelCarry: WheelAccumulator
  private cursor = 'text'
  /** What part of the held input is pressed. */
  private pressPart: 'text' | 1 | -1 = 'text'

  constructor(font: UIKitFont, options: UIKitNumberInputOverlayOptions = {}) {
    super(font, MODEL, options)
    this.wheelCarry = new WheelAccumulator(options.wheelStepPx ?? 40)
  }

  /** CSS cursor for the hovered part: a text beam over the field, a pointer over the spinner. */
  get hoverCursor(): string {
    return this.cursor
  }

  /**
   * Add an input, or replace the one with the same id. The spec's `value` is
   * clamped and snapped; a replacement takes the new spec's value and ends
   * any edit in progress.
   */
  addNumberInput(spec: NumberInputSpec): void {
    this.add(spec)
  }

  /**
   * Replace the whole input set. A kept id whose spec has the same value
   * (once snapped) keeps any edit in progress, as `updateNumberInput` does; a
   * different `value` replaces it as `addNumberInput` does.
   */
  setNumberInputs(specs: readonly NumberInputSpec[]): void {
    this.setAll(specs)
  }

  removeNumberInput(id: string): void {
    this.remove(id)
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
    this.update(id, patch)
  }

  setEnabled(id: string, enabled: boolean): void {
    this.updateNumberInput(id, { enabled })
  }

  /** An input's boxes in spec units (canvas pixels, or CSS pixels with `cssUnits`). */
  getLayout(id: string): NumberInputLayout | null {
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
   * On the spinner: steps and commits. On the text: focuses (selecting all),
   * or places the caret when already focused, and starts a drag selection.
   */
  pointerDown(x: number, y: number): boolean {
    const entry = this.hitEntry(x, y)
    if (!entry) return false
    const layout = this.entries.layoutOf(entry)
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
    const spin = hit ? numberInputSpinAt(this.entries.layoutOf(hit), x, y) : 0
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

  /** Enter commits the field and, in a dialog, submits it. */
  submitsForm(e: UIKitKeyEvent): boolean {
    return e.key === 'Enter'
  }

  /**
   * Paste text into the focused input from code, as a host that catches the
   * DOM paste event itself would. Surrounding whitespace is trimmed and a
   * Unicode minus becomes `-`; text that is empty or holds any other
   * non-number character (`1,5`, `12 px`) is ignored, leaving the field as it
   * was, rather than filtered into a different number.
   */
  paste(text: string): boolean {
    const entry = this.editing()
    if (!entry?.edit) return false
    const clean = text.trim().replace(/\u2212/g, '-')
    if (clean === '' || ![...clean].every(acceptNumberChar)) return true
    this.applyEdit(entry, pasteText(entry.edit, clean, acceptNumberChar))
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

  /**
   * ArrowUp and ArrowDown step (Shift: ten steps), as do PageUp and PageDown;
   * other keys edit the text.
   */
  protected editKey(
    entry: NumberInputEntry,
    edit: TextEditState,
    e: UIKitKeyEvent,
  ): boolean {
    switch (e.key) {
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
    const next = editKey(edit, e, acceptNumberChar)
    if (next === null) return false
    this.applyEdit(entry, next)
    return true
  }

  protected normalize(spec: NumberInputSpec, raw = spec.value): number {
    return snapNumberInput(spec, raw)
  }

  protected display(entry: NumberInputEntry): string {
    return formatNumberInput(entry.spec, entry.value)
  }

  protected newEntry(
    spec: NumberInputSpec,
    style: NumberInputStyle,
    value: number,
  ): NumberInputEntry {
    return {
      spec,
      style,
      layout: null,
      value,
      edit: null,
      session: 0,
      lastInput: value,
      firstGlyph: 0,
      hover: false,
      spinHover: 0,
    }
  }

  /** Also keeps (mid-edit) the last `onInput` value, so onInput dedup stays right. */
  protected override respec(
    entry: NumberInputEntry,
    spec: NumberInputSpec,
  ): void {
    super.respec(entry, spec)
    if (!entry.edit) entry.lastInput = entry.value
  }

  protected override assign(entry: NumberInputEntry, value: number): void {
    entry.lastInput = value
    super.assign(entry, value)
  }

  /** Fire `onInput` when the typed number differs from the last one reported. */
  protected reportInput(entry: NumberInputEntry): void {
    const v = this.typedValue(entry)
    if (!Number.isFinite(v) || v === entry.lastInput) return
    entry.lastInput = v
    entry.spec.onInput?.(v, entry.spec.id)
  }

  /** The typed text as a snapped value, or NaN while it is not a number. */
  private typedValue(entry: NumberInputEntry): number {
    if (!entry.edit) return entry.value
    const raw = parseNumberInput(entry.spec, entry.edit.text)
    return Number.isFinite(raw) ? snapNumberInput(entry.spec, raw) : Number.NaN
  }

  /**
   * Commit the edit: a valid number becomes the value (firing `onChange` if
   * it changed), invalid text reverts. The text is re-formatted and, when the
   * input stays focused, selected again.
   */
  protected commit(entry: NumberInputEntry, stayFocused: boolean): void {
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

  protected *geometry(): Generator<UIKitGeometry> {
    for (const entry of this.entries.values()) {
      const { spec, style } = this.scaled(entry)
      const layout = this.entries.layoutOf(entry)
      const shown = this.shown(entry)
      this.firstShown(entry)
      const id = entry.spec.id
      yield buildNumberInput(spec, style, layout, this.font.metrics, {
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
    }
  }
}
