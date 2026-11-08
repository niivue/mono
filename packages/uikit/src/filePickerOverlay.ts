// A UIKit overlay of file pickers drawn into the scene through the niivue
// overlay hook. Each picker is a push button (composed from a private button
// overlay) beside a readout of the chosen file names. Pressing the button
// asks the host bridge to open its file chooser; the picker then shows what
// was chosen and fires `onPick`, or `onCancel` when the chooser closed empty.

import type { UIKitOverlayFrame, UIKitOverlayRenderer } from '@niivue/niivue'
import { UIKitButtonOverlay } from './buttonOverlay'
import type {
  UIKitInteractive,
  UIKitKeyEvent,
  UIKitRedrawSource,
} from './controls'
import {
  buildFilePicker,
  DEFAULT_FILE_PICKER_LABEL,
  DEFAULT_FILE_PICKER_STYLE,
  type FilePickerLayout,
  type FilePickerSpec,
  type FilePickerStyle,
  layoutFilePicker,
  resolveFilePickerStyle,
  scaleFilePicker,
} from './filePicker'
import { createBrowserFilePicker, type FilePickerBridge } from './host'
import {
  UIKitDrawBundle,
  UIKitEntryMap,
  type UIKitGeometry,
} from './overlayParts'
import type { UIKitFont } from './text/font'

export interface UIKitFilePickerOverlayOptions {
  /** Called whenever the overlay needs another frame. A control layer fills it in. */
  requestRedraw?: () => void
  /** Default style for every picker; a spec's `style` overrides per key. */
  style?: Partial<FilePickerStyle>
  /**
   * Interpret spec positions and style lengths as CSS pixels and scale them by
   * the frame's device pixel ratio, instead of canvas pixels.
   */
  cssUnits?: boolean
  /** The host's file chooser. Defaults to a hidden `<input type="file">`. */
  pickFiles?: FilePickerBridge
}

interface PickerEntry {
  spec: FilePickerSpec
  style: FilePickerStyle
  /** Boxes in canvas pixels, for the scale they were laid out at. */
  layout: FilePickerLayout | null
  names: string[]
  /** True while the host chooser is open for this picker. */
  busy: boolean
  /** Bumped per press, so a late settle from an earlier chooser is ignored. */
  pickSeq: number
}

export class UIKitFilePickerOverlay
  implements UIKitOverlayRenderer, UIKitInteractive
{
  readonly hoverCursor = 'pointer'
  private readonly font: UIKitFont
  private readonly buttons: UIKitButtonOverlay
  private readonly bundle: UIKitDrawBundle
  private readonly entries: UIKitEntryMap<FilePickerLayout, PickerEntry>
  private baseStyle: FilePickerStyle
  private requestRedraw: (() => void) | null
  private pickFiles: FilePickerBridge | null

  constructor(font: UIKitFont, options: UIKitFilePickerOverlayOptions = {}) {
    this.font = font
    const cssUnits = options.cssUnits ?? false
    this.bundle = new UIKitDrawBundle(font, () => this.requestRedraw?.())
    this.entries = new UIKitEntryMap((entry, scale) => {
      const { spec, style } = scaleFilePicker(entry.spec, entry.style, scale)
      return layoutFilePicker(spec, style, font.metrics)
    }, cssUnits)
    this.baseStyle = resolveFilePickerStyle(
      DEFAULT_FILE_PICKER_STYLE,
      options.style,
    )
    this.requestRedraw = options.requestRedraw ?? null
    this.pickFiles = options.pickFiles ?? null
    this.buttons = new UIKitButtonOverlay(font, {
      requestRedraw: () => this.requestRedraw?.(),
      cssUnits,
    })
  }

  /** Replace the default style for every picker (per-spec overrides still win). */
  setDefaultStyle(style: Partial<FilePickerStyle>): void {
    this.baseStyle = resolveFilePickerStyle(DEFAULT_FILE_PICKER_STYLE, style)
    for (const entry of this.entries.values()) {
      entry.style = resolveFilePickerStyle(this.baseStyle, entry.spec.style)
      entry.layout = null
      this.placeButton(entry)
    }
    this.invalidate()
  }

  /** Add a picker, or replace the one with the same id (keeping its files). */
  addFilePicker(spec: FilePickerSpec): void {
    const existing = this.entries.get(spec.id)
    const style = resolveFilePickerStyle(this.baseStyle, spec.style)
    let entry: PickerEntry
    if (existing) {
      existing.spec = spec
      existing.style = style
      existing.layout = null
      entry = existing
    } else {
      entry = { spec, style, layout: null, names: [], busy: false, pickSeq: 0 }
      this.entries.set(spec.id, entry)
    }
    this.placeButton(entry)
    this.invalidate()
  }

  setFilePickers(specs: readonly FilePickerSpec[]): void {
    this.entries.replaceAll(
      specs,
      (spec) => this.addFilePicker(spec),
      (id) => this.removeFilePicker(id),
    )
  }

  removeFilePicker(id: string): void {
    if (!this.entries.delete(id)) return
    this.buttons.removeButton(id)
    this.invalidate()
  }

  /** Patch one picker's spec (label, position, accept, callbacks, ...). */
  updateFilePicker(
    id: string,
    patch: Partial<Omit<FilePickerSpec, 'id'>>,
  ): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.addFilePicker({ ...entry.spec, ...patch, id })
  }

  setEnabled(id: string, enabled: boolean): void {
    this.updateFilePicker(id, { enabled })
  }

  /** Show these files (or names) as chosen without firing callbacks. */
  setFiles(id: string, files: readonly (File | string)[]): void {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.names = files.map((f) => (typeof f === 'string' ? f : f.name))
    this.invalidate()
  }

  /** The names a picker shows as chosen. */
  getFiles(id: string): string[] | undefined {
    const entry = this.entries.get(id)
    return entry ? [...entry.names] : undefined
  }

  get ids(): string[] {
    return this.entries.ids
  }

  /** A picker's boxes in spec units, or null for an unknown id. */
  getLayout(id: string): FilePickerLayout | null {
    const entry = this.entries.get(id)
    if (!entry) return null
    return layoutFilePicker(entry.spec, entry.style, this.font.metrics)
  }

  /** True while the host chooser is open for the picker. */
  isPending(id: string): boolean {
    return this.entries.get(id)?.busy === true
  }

  /**
   * Open the host chooser for a picker as if its button were pressed. Call it
   * from a pointer or key handler: browsers only open a chooser inside a user
   * activation.
   */
  open(id: string): void {
    const entry = this.entries.get(id)
    if (!entry || entry.spec.enabled === false) return
    this.buttons.click(id)
  }

  hitTest(x: number, y: number): boolean {
    return this.buttons.hitTest(x, y)
  }

  pointerDown(x: number, y: number): boolean {
    return this.buttons.pointerDown(x, y)
  }

  pointerMove(x: number, y: number): boolean {
    return this.buttons.pointerMove(x, y)
  }

  pointerUp(x: number, y: number): boolean {
    return this.buttons.pointerUp(x, y)
  }

  pointerCancel(): void {
    this.buttons.pointerCancel()
  }

  /** Enter or Space presses the last-pressed button. */
  keyDown(e: UIKitKeyEvent): boolean {
    return this.buttons.keyDown(e)
  }

  blur(): void {
    this.buttons.blur()
  }

  bindLayer(layer: UIKitRedrawSource): void {
    this.requestRedraw ??= () => layer.requestRedraw()
  }

  drawOverlay(frame: UIKitOverlayFrame): void {
    if (this.entries.size === 0) return
    const rescaled = this.entries.rescale(frame.dpr)
    this.buttons.drawOverlay(frame)
    this.bundle.draw(frame, () => this.geometry(), rescaled)
  }

  /** Release GPU resources on both backends. */
  destroy(): void {
    this.buttons.destroy()
    this.bundle.destroy()
  }

  private invalidate(): void {
    this.bundle.invalidate()
  }

  private *geometry(): Generator<UIKitGeometry> {
    for (const entry of this.entries.values()) {
      const { spec, style } = scaleFilePicker(
        entry.spec,
        entry.style,
        this.entries.scale,
      )
      const geo = buildFilePicker(
        spec,
        style,
        this.entries.layoutOf(entry),
        this.font.metrics,
        { names: entry.names, enabled: spec.enabled !== false },
      )
      yield { rects: [], lines: [], text: geo.text }
    }
  }

  /** Create or move a picker's button, in spec units. */
  private placeButton(entry: PickerEntry): void {
    const spec = entry.spec
    this.buttons.addButton({
      id: spec.id,
      label: spec.label ?? DEFAULT_FILE_PICKER_LABEL,
      x: spec.x,
      y: spec.y,
      enabled: spec.enabled,
      style: entry.style.button,
      onClick: () => this.pick(entry),
    })
  }

  /** Ask the host for files and report the outcome to the picker's callbacks. */
  private pick(entry: PickerEntry): void {
    // Not gated on busy: a chooser whose browser never reports cancel would
    // otherwise leave the button dead. The newest press wins.
    const spec = entry.spec
    this.pickFiles ??= createBrowserFilePicker()
    const bridge = this.pickFiles
    const seq = ++entry.pickSeq
    entry.busy = true
    const settle = (files: File[]) => {
      if (seq !== entry.pickSeq) return
      entry.busy = false
      if (this.entries.get(spec.id) !== entry) return
      if (files.length === 0) {
        entry.spec.onCancel?.(spec.id)
        return
      }
      entry.names = files.map((f) => f.name)
      this.invalidate()
      entry.spec.onPick?.(files, spec.id)
    }
    let result: Promise<File[]>
    try {
      result = bridge({
        accept: spec.accept,
        multiple: spec.multiple,
        directory: spec.directory,
      })
    } catch {
      settle([])
      return
    }
    result.then(settle, () => settle([]))
  }
}
