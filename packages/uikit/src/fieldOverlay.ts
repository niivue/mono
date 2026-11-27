// The overlay mechanics UIKit's entry fields share (number inputs, text
// inputs, text areas): add, replace and patch entries while keeping a live
// edit, focus and commit, the clipboard keys with their paste liveness, and
// for single-line fields the caret mapping and glyph scrolling. Parsing,
// paste filtering, pointer handling and drawing stay in each widget.

import type { UIKitInteractive, UIKitKeyEvent } from './controls'
import { type ClipboardBridge, createBrowserClipboard } from './host'
import {
  type UIKitEntryModel,
  UIKitEntryOverlay,
  type UIKitEntryOverlayOptions,
} from './overlayParts'
import type { UIKitBox } from './rect'
import type { UIKitFont } from './text/font'
import {
  clipboardEdit,
  clipboardKey,
  selectAll,
  type TextEditState,
  textEditState,
} from './textEdit'
import {
  type TextFieldStyle,
  textFieldCaretAt,
  textFieldWindow,
} from './textField'

interface FieldSpec<St, V> {
  id: string
  enabled?: boolean
  style?: Partial<St>
  value?: V
}

interface FieldEntry<S, St, L, V> {
  spec: S
  style: St
  layout: L | null
  /** The committed value. */
  value: V
  /** The edit in progress while focused, else null. */
  edit: TextEditState | null
  /** Bumped whenever an edit starts, so a slow paste read knows its session is over. */
  session: number
  hover: boolean
}

export interface UIKitFieldOverlayOptions<St>
  extends UIKitEntryOverlayOptions<St> {
  clipboard?: ClipboardBridge
}

export abstract class UIKitFieldOverlay<
    V,
    S extends FieldSpec<St, V>,
    St,
    L,
    E extends FieldEntry<S, St, L, V>,
  >
  extends UIKitEntryOverlay<S, St, L, E>
  implements UIKitInteractive
{
  protected clipboard: ClipboardBridge | null
  protected hoverId: string | null = null
  protected focusedId: string | null = null
  /** The held press. */
  protected pressId: string | null = null

  constructor(
    font: UIKitFont,
    model: UIKitEntryModel<S, St, L>,
    options: UIKitFieldOverlayOptions<St>,
  ) {
    super(font, model, options)
    this.clipboard = options.clipboard ?? null
  }

  /** The value a spec (or code) sets, made valid for the spec. */
  protected abstract normalize(spec: S, raw: V | undefined): V
  /** The committed value as the field shows it. */
  protected abstract display(entry: E): string
  protected abstract newEntry(spec: S, style: St, value: V): E
  /** Take a new edit state, redrawing and reporting input when the text changed. */
  protected abstract applyEdit(entry: E, next: TextEditState): void
  /** Commit the edit; a field that stays focused gets a fresh one. */
  protected abstract commit(entry: E, stayFocused: boolean): void
  /** Scroll back to the start (and drop any per-edit caret state). */
  protected abstract rewind(entry: E): void
  /** A key the shared handling left: editing, or the widget's own keys. */
  protected abstract editKey(
    entry: E,
    edit: TextEditState,
    e: UIKitKeyEvent,
  ): boolean
  abstract paste(text: string): boolean
  abstract submitsForm(e: UIKitKeyEvent): boolean
  abstract pointerDown(x: number, y: number): boolean
  abstract pointerMove(x: number, y: number): boolean
  abstract pointerUp(x: number, y: number): boolean

  /** Set a field's value from code. Fires no callback; a focused field shows it selected. */
  setValue(id: string, value: V): void {
    const entry = this.entries.get(id)
    if (!entry) return
    const v = this.normalize(entry.spec, value)
    if (v === entry.value && !entry.edit) return
    this.assign(entry, v)
    this.invalidate()
  }

  /** The committed value. */
  getValue(id: string): V | undefined {
    return this.entries.get(id)?.value
  }

  /** The text the field shows: the edit in progress, or the committed value. */
  getText(id: string): string | undefined {
    const entry = this.entries.get(id)
    return entry ? this.shown(entry) : undefined
  }

  /**
   * Give a field keyboard focus with its whole text selected, or null to
   * clear. Leaving a field commits its edit. Disabled fields refuse.
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

  pointerCancel(): void {
    if (this.pressId === null) return
    this.pressId = null
    this.invalidate()
  }

  /**
   * The form-submit key commits, Escape reverts, Meta or Ctrl plus C, X and
   * V go through the clipboard; the widget handles the rest.
   */
  keyDown(e: UIKitKeyEvent): boolean {
    const entry = this.editing()
    if (!entry?.edit) return false
    if (this.submitsForm(e)) {
      this.submit(entry)
      return true
    }
    if (e.key === 'Escape') {
      entry.edit = this.freshEdit(entry)
      this.invalidate()
      return true
    }
    const clip = clipboardKey(e)
    if (clip === null) return this.editKey(entry, entry.edit, e)
    this.clipboard ??= createBrowserClipboard()
    const id = entry.spec.id
    clipboardEdit(
      this.clipboard,
      entry,
      clip,
      () => this.entries.get(id) === entry && this.focusedId === id,
      (text) => this.paste(text),
      (next) => this.cut(entry, next),
    )
    return true
  }

  /** Commits the edit in progress and drops focus. */
  blur(): void {
    this.focus(null)
  }

  /** Release GPU resources on both backends. */
  override destroy(): void {
    // A clipboard read still in flight must not edit a destroyed overlay.
    this.focusedId = null
    super.destroy()
  }

  /** The submit key: commit, staying focused. */
  protected submit(entry: E): void {
    this.commit(entry, true)
  }

  protected cut(entry: E, next: TextEditState): void {
    this.applyEdit(entry, next)
  }

  /** The focused, enabled field with an edit in progress. */
  protected editing(): E | undefined {
    if (this.focusedId === null) return undefined
    const entry = this.entries.get(this.focusedId)
    return entry && entry.spec.enabled !== false && entry.edit
      ? entry
      : undefined
  }

  protected shown(entry: E): string {
    return entry.edit ? entry.edit.text : this.display(entry)
  }

  /**
   * Add a field, or replace the one with the same id. A replacement takes
   * the new spec's value and ends any edit in progress.
   */
  protected add(spec: S): void {
    const existing = this.entries.get(spec.id)
    if (existing) {
      // The new spec first: the fresh edit is formatted with it.
      this.respec(existing, spec)
      this.assign(existing, this.normalize(spec, spec.value))
      return
    }
    const style = this.model.resolveStyle(this.baseStyle, spec.style)
    this.entries.set(
      spec.id,
      this.newEntry(spec, style, this.normalize(spec, spec.value)),
    )
    this.invalidate()
  }

  /**
   * Replace the whole set. A kept id whose spec leaves the committed value
   * alone (no `value`, or the same one once normalized) keeps any edit in
   * progress, as `update` does; a different `value` replaces it as `add` does.
   */
  protected setAll(specs: readonly S[]): void {
    this.entries.replaceAll(
      specs,
      (spec) => {
        const entry = this.entries.get(spec.id)
        if (
          entry &&
          (spec.value === undefined ||
            this.normalize(spec, spec.value) ===
              this.normalize(spec, entry.value))
        )
          this.respec(entry, spec)
        else this.add(spec)
      },
      (id) => this.remove(id),
    )
  }

  protected remove(id: string): void {
    if (!this.entries.delete(id)) return
    if (this.pressId === id) this.pressId = null
    if (this.hoverId === id) this.hoverId = null
    if (this.focusedId === id) this.focusedId = null
    this.invalidate()
  }

  /** Patch one field's spec. The committed value is kept unless the patch sets `value`. */
  protected update(id: string, patch: Partial<Omit<S, 'id'>>): void {
    const entry = this.entries.get(id)
    if (!entry) return
    const spec = { ...entry.spec, ...patch, id }
    // A patch that leaves the value alone (a host re-laying out on resize)
    // must not throw away what the user is typing, or a paste on its way.
    if (patch.value === undefined) this.respec(entry, spec)
    else this.add(spec)
  }

  /**
   * Take a new spec, keeping the edit, session and scroll; the committed
   * value is normalized for it. Disabling drops press and focus.
   */
  protected respec(entry: E, spec: S): void {
    entry.spec = spec
    entry.style = this.model.resolveStyle(this.baseStyle, spec.style)
    entry.layout = null
    entry.value = this.normalize(spec, entry.value)
    if (spec.enabled === false) {
      if (this.pressId === spec.id) this.pressId = null
      if (this.focusedId === spec.id) {
        entry.edit = null
        this.focusedId = null
      }
    }
    this.invalidate()
  }

  /** Take a new committed value, rewinding and restarting any edit. */
  protected assign(entry: E, value: V): void {
    entry.value = value
    this.rewind(entry)
    if (entry.edit) entry.edit = this.freshEdit(entry)
  }

  /** The edit state for a freshly focused (or reverted) field: all selected. */
  protected freshEdit(entry: E): TextEditState {
    this.rewind(entry)
    entry.session++
    return selectAll(textEditState(this.display(entry)))
  }
}

interface LineFieldEntry<S, St, L, V> extends FieldEntry<S, St, L, V> {
  firstGlyph: number
}

/** A single-line field: the text scrolls by whole glyphs to keep the caret in view. */
export abstract class UIKitLineFieldOverlay<
  V,
  S extends FieldSpec<St, V>,
  St extends TextFieldStyle,
  L extends { textArea: UIKitBox },
  E extends LineFieldEntry<S, St, L, V>,
> extends UIKitFieldOverlay<V, S, St, L, E> {
  /** Report the edit's text (or the value it means) after it changed. */
  protected abstract reportInput(entry: E, text: string): void

  protected applyEdit(entry: E, next: TextEditState): void {
    if (!entry.edit || next === entry.edit) return
    const textChanged = next.text !== entry.edit.text
    entry.edit = next
    this.firstShown(entry)
    this.invalidate()
    if (textChanged) this.reportInput(entry, next.text)
  }

  protected rewind(entry: E): void {
    entry.firstGlyph = 0
  }

  /** The caret for a drag: a pointer left of the shown text pulls one hidden glyph into view. */
  protected dragCaretAt(entry: E, x: number): number {
    const caret = this.caretAt(entry, x)
    const first = entry.firstGlyph
    const pastLeft = first > 0 && x < this.entries.layoutOf(entry).textArea.x
    return pastLeft && caret === first ? first - 1 : caret
  }

  protected caretAt(entry: E, x: number): number {
    return textFieldCaretAt(
      this.entries.layoutOf(entry).textArea,
      this.scaled(entry).style,
      this.font.metrics,
      this.shown(entry),
      entry.firstGlyph,
      x,
    )
  }

  /**
   * Settle the scroll position for the next frame: the stored first glyph,
   * moved the least distance that keeps the caret in view. Every caret move
   * (key edit, press, drag) settles, so `firstGlyph` is always the window
   * the next frame shows and pointer math can read it as is; `geometry`
   * settles again for caret moves that bypass this (focus, step, commit).
   */
  protected firstShown(entry: E): void {
    entry.firstGlyph = textFieldWindow(
      this.entries.layoutOf(entry).textArea,
      this.scaled(entry).style,
      this.font.metrics,
      this.shown(entry),
      entry.firstGlyph,
      entry.edit ? entry.edit.caret : 0,
    ).first
  }
}
