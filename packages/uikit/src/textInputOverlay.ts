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
import type { UIKitFont } from './text/font'
import {
  clipboardEdit,
  clipboardKey,
  editKey,
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

export class UIKitTextInputOverlay
  implements UIKitOverlayRenderer, UIKitInteractive
{
  private readonly font: UIKitFont
  private readonly bundle: UIKitDrawBundle
  private readonly entries: UIKitEntryMap<TextInputLayout, TextInputEntry>
  private baseStyle: TextInputStyle
  private readonly doubleClickMs: number
  private readonly now: () => number
  private layer: UIKitRedrawSource | null = null
  private clipboard: ClipboardBridge | null
  private hoverId: string | null = null
  private focusedId: string | null = null
  /** The held press, which drags the selection. */
  private pressId: string | null = null
  private lastDownId: string | null = null
  private lastDownAt = Number.NEGATIVE_INFINITY

  constructor(font: UIKitFont, options: UIKitTextInputOverlayOptions = {}) {
    this.font = font
    this.bundle = new UIKitDrawBundle(font, options.requestRedraw)
    this.entries = new UIKitEntryMap((entry, scale) => {
      const { spec, style } = scaleTextInput(entry.spec, entry.style, scale)
      return layoutTextInput(spec, style, font.metrics)
    }, options.cssUnits ?? false)
    this.baseStyle = resolveTextInputStyle(
      DEFAULT_TEXT_INPUT_STYLE,
      options.style,
    )
    this.doubleClickMs = options.doubleClickMs ?? 400
    this.now = options.now ?? (() => performance.now())
    this.clipboard = options.clipboard ?? null
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
    if (existing) {
      this.respec(existing, spec)
      existing.value = truncateText(spec.value ?? '', spec.maxLength)
      existing.firstGlyph = 0
      if (existing.edit) existing.edit = this.freshEdit(existing)
      return
    }
    this.entries.set(spec.id, {
      spec,
      style: resolveTextInputStyle(this.baseStyle, spec.style),
      layout: null,
      value: truncateText(spec.value ?? '', spec.maxLength),
      edit: null,
      session: 0,
      firstGlyph: 0,
      hover: false,
    })
    this.invalidate()
  }

  /**
   * Replace the whole input set. A kept id whose spec leaves the committed
   * text alone (no `value`, or the same one) keeps any edit in progress, as
   * `updateTextInput` does; a different `value` replaces it as `addTextInput`
   * does.
   */
  setTextInputs(specs: readonly TextInputSpec[]): void {
    this.entries.replaceAll(
      specs,
      (spec) => {
        const entry = this.entries.get(spec.id)
        if (entry && sameValue(entry.value, spec)) this.respec(entry, spec)
        else this.addTextInput(spec)
      },
      (id) => this.removeTextInput(id),
    )
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
    const spec = { ...entry.spec, ...patch, id }
    // A patch that leaves the value alone (a host re-laying out on resize)
    // must not throw away what the user is typing, or a paste on its way.
    if (patch.value === undefined) this.respec(entry, spec)
    else this.addTextInput(spec)
  }

  setEnabled(id: string, enabled: boolean): void {
    this.updateTextInput(id, { enabled })
  }

  /** Set an input's text from code. Fires no callback; a focused field shows it selected. */
  setValue(id: string, value: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    const v = truncateText(value, entry.spec.maxLength)
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
    return this.entries.ids
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

  pointerCancel(): void {
    if (this.pressId === null) return
    this.pressId = null
    this.invalidate()
  }

  /**
   * Editing keys change the text; Enter commits and submits; Escape reverts;
   * Meta or Ctrl plus C, X and V go through the clipboard.
   */
  /** Enter commits the field and, in a dialog, submits it. */
  submitsForm(e: UIKitKeyEvent): boolean {
    return e.key === 'Enter'
  }

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
        (next) => this.applyEdit(entry, next),
      )
      return true
    }
    const next = editKey(entry.edit, e, entry.spec.accept)
    if (next === null) return false
    const max = maxLengthOf(entry.spec.maxLength)
    if (max !== undefined && next.text.length > max) return true
    this.applyEdit(entry, next)
    return true
  }

  /**
   * Paste text into the focused input from code, as a host that catches the
   * DOM paste event itself would. Line breaks are dropped, the spec's
   * `accept` and `maxLength` apply.
   */
  paste(text: string): boolean {
    if (this.focusedId === null) return false
    const entry = this.entries.get(this.focusedId)
    if (!entry || entry.spec.enabled === false || !entry.edit) return false
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
    this.bundle.draw(frame, () => this.geometry(), rescaled)
  }

  /** Release GPU resources on both backends. */
  destroy(): void {
    // A clipboard read still in flight must not edit a destroyed overlay.
    this.focusedId = null
    this.bundle.destroy()
  }

  private invalidate(): void {
    this.bundle.invalidate()
  }

  /**
   * Take a new spec, keeping the committed text, edit, session and scroll
   * (trimmed to the spec's maxLength). Disabling drops press and focus.
   */
  private respec(entry: TextInputEntry, spec: TextInputSpec): void {
    entry.spec = spec
    entry.style = resolveTextInputStyle(this.baseStyle, spec.style)
    entry.layout = null
    entry.value = truncateText(entry.value, spec.maxLength)
    if (entry.edit) entry.edit = truncateEdit(entry.edit, spec.maxLength)
    if (spec.enabled === false) {
      if (this.pressId === spec.id) this.pressId = null
      if (this.focusedId === spec.id) {
        entry.edit = null
        this.focusedId = null
      }
    }
    this.invalidate()
  }

  /** Take a new edit state, redrawing and firing `onInput` when the text changed. */
  private applyEdit(entry: TextInputEntry, next: TextEditState): void {
    if (!entry.edit || next === entry.edit) return
    const textChanged = next.text !== entry.edit.text
    entry.edit = next
    this.firstShown(entry)
    this.invalidate()
    if (textChanged) entry.spec.onInput?.(next.text, entry.spec.id)
  }

  /** The edit state for a freshly focused (or reverted) input: all selected. */
  private freshEdit(entry: TextInputEntry): TextEditState {
    entry.firstGlyph = 0
    entry.session++
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

  /** The caret for a drag: a pointer left of the shown text pulls one hidden glyph into view. */
  private dragCaretAt(entry: TextInputEntry, x: number): number {
    const caret = this.caretAt(entry, x)
    const first = entry.firstGlyph
    const pastLeft = first > 0 && x < this.entries.layoutOf(entry).textArea.x
    return pastLeft && caret === first ? first - 1 : caret
  }

  private caretAt(entry: TextInputEntry, x: number): number {
    const { style } = this.scaled(entry)
    const text = entry.edit ? entry.edit.text : entry.value
    return textInputCaretAt(
      this.entries.layoutOf(entry),
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
   * again for caret moves that bypass this (focus, commit).
   */
  private firstShown(entry: TextInputEntry): number {
    const { style } = this.scaled(entry)
    const text = entry.edit ? entry.edit.text : entry.value
    entry.firstGlyph = textInputTextWindow(
      this.entries.layoutOf(entry),
      style,
      this.font.metrics,
      text,
      entry.firstGlyph,
      entry.edit ? entry.edit.caret : 0,
    ).first
    return entry.firstGlyph
  }

  private scaled(entry: TextInputEntry): {
    spec: TextInputSpec
    style: TextInputStyle
  } {
    return scaleTextInput(entry.spec, entry.style, this.entries.scale)
  }

  /** The topmost (last added) enabled input whose field is under a canvas point. */
  private hitEntry(x: number, y: number): TextInputEntry | null {
    return this.entries.topmost(textInputContains, x, y)
  }

  private *geometry(): Generator<UIKitGeometry> {
    for (const entry of this.entries.values()) {
      const { spec, style } = this.scaled(entry)
      const layout = this.entries.layoutOf(entry)
      const shown = entry.edit ? entry.edit.text : entry.value
      this.firstShown(entry)
      const visual: TextInputVisual = {
        text: shown,
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
