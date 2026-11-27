// A UIKit overlay of single-line text inputs drawn into the scene through the
// niivue overlay hook: a bordered field with an optional label. A press on
// the field takes keyboard focus and places the caret at the pointer (a
// second press within the double-click interval selects all; dragging
// selects); typing then edits the text, with the arrows, Home, End, Shift
// selection, Backspace, Delete and select-all handled by the shared text-edit
// model. Enter commits (firing `onChange` when the text changed, then
// `onSubmit`), Escape reverts to the committed text, and losing focus
// commits. `onInput` fires on every keystroke that changes the text. Meta or
// Ctrl plus C, X and V copy, cut and paste through a clipboard bridge (the
// browser's async clipboard unless the host supplies one; a pasted text
// loses its line breaks). There is no IME composition, since no DOM input
// backs the field. Add it to a `UIKitControls` layer with the other
// widgets, or feed the pointer and keyboard entry points from any host.

import type { UIKitKeyEvent } from './controls'
import { UIKitLineFieldOverlay } from './fieldOverlay'
import type { ClipboardBridge } from './host'
import type { UIKitGeometry } from './overlayParts'
import { type UIKitBox, unscaleBox } from './rect'
import type { UIKitFont } from './text/font'
import {
  editKey,
  maxLengthOf,
  pasteText,
  selectAll,
  setCaret,
  type TextEditState,
  truncateEdit,
  truncateText,
} from './textEdit'
import {
  buildTextInput,
  DEFAULT_TEXT_INPUT_STYLE,
  layoutTextInput,
  scaleTextInput,
  type TextInputLayout,
  type TextInputSpec,
  type TextInputStyle,
  type TextInputVisual,
  textInputContains,
} from './textInput'

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
  /** Where copy, cut and paste go. Default: the browser's async clipboard. */
  clipboard?: ClipboardBridge
}

interface TextInputEntry {
  spec: TextInputSpec
  style: TextInputStyle
  layout: TextInputLayout | null
  /** The committed text. */
  value: string
  /** The edit in progress while focused, else null. */
  edit: TextEditState | null
  /** Bumped whenever an edit starts, so a slow paste read knows its session is over. */
  session: number
  firstGlyph: number
  hover: boolean
}

const MODEL = {
  defaultStyle: DEFAULT_TEXT_INPUT_STYLE,
  scale: scaleTextInput,
  layout: layoutTextInput,
  contains: textInputContains,
}

export class UIKitTextInputOverlay extends UIKitLineFieldOverlay<
  string,
  TextInputSpec,
  TextInputStyle,
  TextInputLayout,
  TextInputEntry
> {
  private readonly doubleClickMs: number
  private readonly now: () => number
  private lastDownId: string | null = null
  private lastDownAt = Number.NEGATIVE_INFINITY

  constructor(font: UIKitFont, options: UIKitTextInputOverlayOptions = {}) {
    super(font, MODEL, options)
    this.doubleClickMs = options.doubleClickMs ?? 400
    this.now = options.now ?? (() => performance.now())
  }

  /** CSS cursor while a field is hovered: a text beam. */
  get hoverCursor(): string {
    return 'text'
  }

  /**
   * Add an input, or replace the one with the same id. A replacement takes
   * the new spec's text and ends any edit in progress.
   */
  addTextInput(spec: TextInputSpec): void {
    this.add(spec)
  }

  /**
   * Replace the whole input set. A kept id whose spec leaves the committed
   * text alone (no `value`, or the same one) keeps any edit in progress, as
   * `updateTextInput` does; a different `value` replaces it as `addTextInput`
   * does.
   */
  setTextInputs(specs: readonly TextInputSpec[]): void {
    this.setAll(specs)
  }

  removeTextInput(id: string): void {
    this.remove(id)
  }

  /**
   * Patch one input's spec (label, position, placeholder, enabled, ...). The
   * committed text is kept unless the patch sets `value`.
   */
  updateTextInput(id: string, patch: Partial<Omit<TextInputSpec, 'id'>>): void {
    this.update(id, patch)
  }

  setEnabled(id: string, enabled: boolean): void {
    this.updateTextInput(id, { enabled })
  }

  /** An input's boxes in spec units (canvas pixels, or CSS pixels with `cssUnits`). */
  getLayout(id: string): TextInputLayout | null {
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
      baseline: l.baseline / k,
    }
  }

  /** The input with keyboard focus (being edited), if any. */
  get focusedInput(): string | null {
    return this.focusedId
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
    // Focusing selects all, which would scroll to the end; a press keeps the
    // glyphs the user is looking at so the caret lands where they pressed.
    const first = entry.firstGlyph
    this.focus(id)
    entry.firstGlyph = first
    if (entry.edit) {
      entry.edit = twice
        ? selectAll(entry.edit)
        : setCaret(entry.edit, this.caretAt(entry, x))
      this.firstShown(entry)
    }
    this.invalidate()
    return true
  }

  pointerMove(x: number, y: number): boolean {
    if (this.pressId !== null) {
      const entry = this.entries.get(this.pressId)
      if (entry?.edit) {
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

  /** Enter commits the field and, in a dialog, submits it. */
  submitsForm(e: UIKitKeyEvent): boolean {
    return e.key === 'Enter'
  }

  /**
   * Paste text into the focused input from code, as a host that catches the
   * DOM paste event itself would. Line breaks are dropped, the spec's
   * `accept` and `maxLength` apply.
   */
  paste(text: string): boolean {
    const entry = this.editing()
    if (!entry?.edit) return false
    this.applyEdit(
      entry,
      pasteText(
        entry.edit,
        text.replace(/\r?\n/g, ''),
        entry.spec.accept,
        entry.spec.maxLength,
      ),
    )
    return true
  }

  protected editKey(
    entry: TextInputEntry,
    edit: TextEditState,
    e: UIKitKeyEvent,
  ): boolean {
    const next = editKey(edit, e, entry.spec.accept)
    if (next === null) return false
    const max = maxLengthOf(entry.spec.maxLength)
    if (max !== undefined && next.text.length > max) return true
    this.applyEdit(entry, next)
    return true
  }

  /** Enter: commit, then `onSubmit` with the committed text. */
  protected override submit(entry: TextInputEntry): void {
    this.commit(entry, true)
    entry.spec.onSubmit?.(entry.value, entry.spec.id)
  }

  protected normalize(spec: TextInputSpec, raw: string | undefined): string {
    return truncateText(raw ?? '', spec.maxLength)
  }

  protected display(entry: TextInputEntry): string {
    return entry.value
  }

  protected newEntry(
    spec: TextInputSpec,
    style: TextInputStyle,
    value: string,
  ): TextInputEntry {
    return {
      spec,
      style,
      layout: null,
      value,
      edit: null,
      session: 0,
      firstGlyph: 0,
      hover: false,
    }
  }

  /** Also trims an edit in progress to the spec's maxLength. */
  protected override respec(entry: TextInputEntry, spec: TextInputSpec): void {
    super.respec(entry, spec)
    if (entry.edit) entry.edit = truncateEdit(entry.edit, spec.maxLength)
  }

  protected reportInput(entry: TextInputEntry, text: string): void {
    entry.spec.onInput?.(text, entry.spec.id)
  }

  /**
   * Commit the edit: changed text becomes the value and fires `onChange`.
   * When the input stays focused the text is selected again.
   */
  protected commit(entry: TextInputEntry, stayFocused: boolean): void {
    if (entry.edit && entry.edit.text !== entry.value) {
      entry.value = entry.edit.text
      entry.spec.onChange?.(entry.value, entry.spec.id)
    }
    entry.edit = stayFocused ? this.freshEdit(entry) : null
    entry.firstGlyph = 0
    this.invalidate()
  }

  protected *geometry(): Generator<UIKitGeometry> {
    for (const entry of this.entries.values()) {
      const { spec, style } = this.scaled(entry)
      const layout = this.entries.layoutOf(entry)
      this.firstShown(entry)
      const visual: TextInputVisual = {
        text: this.shown(entry),
        edit: entry.edit,
        firstGlyph: entry.firstGlyph,
        hover: entry.hover,
        enabled: entry.spec.enabled !== false,
      }
      const geo = buildTextInput(spec, style, layout, this.font.metrics, visual)
      yield { ...geo, lines: [] }
    }
  }
}
