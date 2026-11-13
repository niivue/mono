import { log } from '@/logger'
import type {
  UIKitOverlayFrame,
  UIKitOverlayRenderer,
} from '@/view/NVOverlayHook'
import type { NVSlide, NVSlideSample, NVSlideScreen } from './NVSlide'
import {
  NVSlideController,
  type NVSlideControllerOptions,
} from './slideController'
import type { SlideRendererOptions } from './slideFuse'
import {
  type SlideOverlayContent,
  type SlideOverlayStyle,
  slideOverlayContent,
} from './slideOverlay'
import { screenPixels } from './slideTiles'

/** What a slide view needs of a renderer; `SlideRenderer` and `SlideRendererGPU` both fit. */
export interface SlideRenderBackend {
  render(slides: readonly NVSlide[], screen: NVSlideScreen): void
  clearTextures(): void
  destroy(): void
  isNearestInterpolation: boolean
  overlay: SlideOverlayContent | null
  overlayDraw: ((frame: UIKitOverlayFrame) => void) | null
}

export type SlideBackendKind = 'webgpu' | 'webgl2'

export interface SlideBackendOptions extends SlideRendererOptions {
  antialias: boolean
  preserveDrawingBuffer?: boolean
}

/** Makes a renderer on a canvas: null when the backend is unavailable. */
export interface SlideBackendFactory {
  kind: SlideBackendKind
  create(
    canvas: HTMLCanvasElement,
    options: SlideBackendOptions,
  ): Promise<SlideRenderBackend | null>
}

export interface SlideViewOptions extends SlideRendererOptions {
  /** Backend tried first; the other is the fallback. Default 'webgpu'. */
  backend?: SlideBackendKind
  /** Multisample anti-aliasing. Default on, except WebKit (it misrenders and runs slower with it). */
  antialias?: boolean
  /** WebGL2 only: keep the drawing buffer after compositing (canvas readback later). */
  preserveDrawingBuffer?: boolean
  /** Draw at the display's pixel ratio (never below 1); false draws one canvas pixel per CSS pixel. Default true. */
  hidpi?: boolean
  /** The slide on show at start. */
  slide?: NVSlide | null
  /** Gestures (`NVSlideController`); false attaches none. */
  controller?: Omit<NVSlideControllerOptions, 'slide' | 'screen'> | false
  /** Draw the controller's rulers and boxes (core's overlay). Default true;
   * false for a host drawing its own (UIKit ruler) from the controller state. */
  controllerOverlay?: boolean
  /** Ruler, scale bar and selection-box style for the controller's overlay. */
  overlayStyle?: Partial<SlideOverlayStyle>
  /** Runs before each frame draws, after sizing, fitting and clamping (set overlay geometry here). */
  onBeforeRender?: (screen: NVSlideScreen) => void
  /** Runs after each frame (HUD, status). */
  onRender?: (screen: NVSlideScreen) => void
}

/** A slide on a canvas: one renderer, one frame loop, one teardown. */
export interface SlideView {
  /** The canvas drawn on: a replacement when a failed WebGPU start spoiled the given one. */
  readonly canvas: HTMLCanvasElement
  readonly backend: SlideBackendKind
  readonly renderer: SlideRenderBackend
  readonly controller: NVSlideController | null
  readonly slide: NVSlide | null
  hidpi: boolean
  overlayStyle: Partial<SlideOverlayStyle>
  /** Show `slide` (null: none), releasing the previous one; fits it unless `fit` is false. */
  setSlide(slide: NVSlide | null, opts?: { fit?: boolean }): void
  /** Fit the slide on the next sized frame, and again on resizes until the view moves. */
  fit(): void
  /** The canvas size in CSS pixels and the pixel ratio in force. */
  screen(): NVSlideScreen
  requestRender(): void
  /** Draw now (e.g. before `canvas.toBlob`, which reads the frame drawn in this task). */
  renderNow(): void
  /** Draw `overlay` at the end of every frame (UIKit widgets); returns its remover. */
  addOverlay(overlay: UIKitOverlayRenderer): () => void
  /** Call `fn` after every frame; returns its remover. */
  addRenderListener(fn: (screen: NVSlideScreen) => void): () => void
  /** Idempotent. Leaves the canvas in place. */
  destroy(): void
}

const isWebKit = (): boolean =>
  typeof navigator !== 'undefined' &&
  /AppleWebKit/.test(navigator.userAgent) &&
  !/Chrome|Chromium|Edg\//.test(navigator.userAgent)

async function startBackend(
  canvas: HTMLCanvasElement,
  backends: readonly SlideBackendFactory[],
  options: SlideViewOptions,
): Promise<{
  canvas: HTMLCanvasElement
  renderer: SlideRenderBackend
  kind: SlideBackendKind
}> {
  const backendOptions: SlideBackendOptions = {
    antialias: options.antialias ?? !isWebKit(),
    preserveDrawingBuffer: options.preserveDrawingBuffer,
    maxRawPoolBytes: options.maxRawPoolBytes,
  }
  const first = options.backend ?? 'webgpu'
  const ordered = [...backends].sort(
    (a, b) => Number(b.kind === first) - Number(a.kind === first),
  )
  const create = (factory: SlideBackendFactory, on: HTMLCanvasElement) =>
    factory.create(on, backendOptions).catch((err) => {
      log.warn(`${factory.kind} slide renderer failed to start`, err)
      return null
    })
  let failedBefore = false
  for (const factory of ordered) {
    const renderer = await create(factory, canvas)
    if (renderer) return { canvas, renderer, kind: factory.kind }
    // A backend that took a context before failing locks the canvas to that
    // context type, and the next one gets null on it (either order): retry on
    // a clone, put back if that fails too.
    if (!failedBefore || !canvas.parentNode) {
      failedBefore = true
      continue
    }
    const fresh = canvas.cloneNode() as HTMLCanvasElement
    canvas.replaceWith(fresh)
    const retried = await create(factory, fresh)
    if (retried) return { canvas: fresh, renderer: retried, kind: factory.kind }
    fresh.replaceWith(canvas)
  }
  throw new Error(
    `No slide backend could start (${ordered.map((b) => b.kind).join(', ')})`,
  )
}

/**
 * Mount a slide view on `canvas` with the first of `backends` that starts.
 * Entry points bind the backends (`createSlideView`); this is the shared core.
 */
export async function createSlideViewWith(
  backends: readonly SlideBackendFactory[],
  canvasIn: HTMLCanvasElement,
  options: SlideViewOptions = {},
): Promise<SlideView> {
  const { canvas, renderer, kind } = await startBackend(
    canvasIn,
    backends,
    options,
  )
  let slide: NVSlide | null = null
  let hidpi = options.hidpi ?? true
  let overlayStyle = options.overlayStyle ?? {}
  let destroyed = false
  let frame = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let pendingFit = false
  // The view a fit produced, kept until the user moves it: a resize refits.
  let fitted: { key: string; w: number; h: number } | null = null
  const overlays = new Set<UIKitOverlayRenderer>()
  const listeners = new Set<(screen: NVSlideScreen) => void>()
  if (options.onRender) listeners.add(options.onRender)

  const viewKey = (s: NVSlide): string => {
    const v = s.viewport
    return `${v.centerX},${v.centerY},${v.scale}`
  }

  const screen = (): NVSlideScreen => {
    const rect = canvas.getBoundingClientRect()
    return {
      // A hidden pane is 0 x 0: 1 keeps the slide maths finite (fit waits for a size).
      widthCss: Math.max(1, rect.width),
      heightCss: Math.max(1, rect.height),
      // Never below 1: browser zoom-out would otherwise draw a blurry canvas.
      devicePixelRatio: hidpi ? Math.max(1, window.devicePixelRatio || 1) : 1,
    }
  }

  const render = (): void => {
    if (destroyed) return
    if (frame) cancelAnimationFrame(frame)
    clearTimeout(timer)
    frame = 0
    timer = undefined
    const s = screen()
    const [, width, height] = screenPixels(s)
    // Resizing resets the canvas, so only when the size changed.
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    // Fit only once the canvas has a size (a pane laid out late would fit a corner).
    const sized = s.widthCss > 1 && s.heightCss > 1
    if (slide && sized) {
      const refit =
        fitted &&
        (fitted.w !== s.widthCss || fitted.h !== s.heightCss) &&
        fitted.key === viewKey(slide)
      if (pendingFit || refit) {
        slide.fitToScreen(s)
        slide.clampViewport(s)
        fitted = { key: viewKey(slide), w: s.widthCss, h: s.heightCss }
        pendingFit = false
      }
    }
    if (slide) slide.clampViewport(s)
    options.onBeforeRender?.(s)
    renderer.overlay =
      slide && controller && options.controllerOverlay !== false
        ? slideOverlayContent(slide, s, controller, overlayStyle)
        : slide && overlayStyle.isRulerVisible
          ? slideOverlayContent(
              slide,
              s,
              { measurements: [], activeMeasurement: null, selection: null },
              overlayStyle,
            )
          : null
    renderer.render(slide ? [slide] : [], s)
    for (const fn of listeners) fn(s)
  }

  // rAF pauses in a hidden tab; the timer still draws there, so tiles keep
  // streaming and the view is current when the tab returns.
  const requestRender = (): void => {
    if (destroyed || frame) return
    frame = requestAnimationFrame(render)
    timer = setTimeout(render, 100)
  }

  const syncOverlays = (): void => {
    renderer.overlayDraw = overlays.size
      ? (f) => {
          for (const o of overlays) o.drawOverlay(f)
        }
      : null
  }

  const controller =
    options.controller === false
      ? null
      : new NVSlideController(canvas, {
          ...options.controller,
          slide: () => slide,
          screen,
          onChange: () => {
            requestRender()
            if (options.controller) options.controller.onChange?.()
          },
        })

  const resize = new ResizeObserver(() => requestRender())
  resize.observe(canvas)
  // Re-armed on every change: the query names the ratio in force.
  let ratioQuery: MediaQueryList | null = null
  const onRatio = (): void => {
    watchRatio()
    requestRender()
  }
  const watchRatio = (): void => {
    ratioQuery?.removeEventListener('change', onRatio)
    ratioQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    ratioQuery.addEventListener('change', onRatio)
  }
  watchRatio()

  const view: SlideView = {
    canvas,
    backend: kind,
    renderer,
    controller,
    get slide() {
      return slide
    },
    get hidpi() {
      return hidpi
    },
    set hidpi(on: boolean) {
      hidpi = on
      requestRender()
    },
    get overlayStyle() {
      return overlayStyle
    },
    set overlayStyle(style: Partial<SlideOverlayStyle>) {
      overlayStyle = style
      requestRender()
    },
    setSlide(next, { fit = true } = {}) {
      // After destroy nothing will show it: the slide is released at once.
      if (destroyed) {
        next?.dispose()
        return
      }
      if (next === slide) return
      slide?.removeEventListener('change', requestRender)
      slide?.dispose()
      renderer.clearTextures()
      slide = next
      slide?.addEventListener('change', requestRender)
      fitted = null
      pendingFit = fit && !!slide
      requestRender()
    },
    fit() {
      pendingFit = true
      requestRender()
    },
    screen,
    requestRender,
    renderNow: render,
    addOverlay(overlay) {
      overlays.add(overlay)
      syncOverlays()
      requestRender()
      return () => {
        if (destroyed) return
        overlays.delete(overlay)
        syncOverlays()
        requestRender()
      }
    },
    addRenderListener(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      if (frame) cancelAnimationFrame(frame)
      clearTimeout(timer)
      resize.disconnect()
      ratioQuery?.removeEventListener('change', onRatio)
      controller?.dispose()
      slide?.removeEventListener('change', requestRender)
      slide?.dispose()
      slide = null
      overlays.clear()
      listeners.clear()
      renderer.destroy()
    },
  }
  if (options.slide) view.setSlide(options.slide)
  else requestRender()
  return view
}

type PhysicalView = { x: number; y: number; scale: number }

// Physical (mm) when both slides state spacing, else fractions of the slide.
function physicalView(slide: NVSlide, physical: boolean): PhysicalView {
  const { centerX, centerY, scale } = slide.viewport
  const sp = slide.manifest.pixelSpacingMM
  if (physical && sp)
    return { x: centerX * sp[0], y: centerY * sp[1], scale: scale / sp[0] }
  const { width, height } = slide.manifest
  return { x: centerX / width, y: centerY / height, scale: scale * width }
}

function viewportFrom(
  slide: NVSlide,
  v: PhysicalView,
  physical: boolean,
): { centerX: number; centerY: number; scale: number } {
  const sp = slide.manifest.pixelSpacingMM
  if (physical && sp)
    return {
      centerX: v.x / sp[0],
      centerY: v.y / sp[1],
      scale: v.scale * sp[0],
    }
  const { width, height } = slide.manifest
  return { centerX: v.x * width, centerY: v.y * height, scale: v.scale / width }
}

/**
 * Keep the views' viewports together: a pan or zoom in one moves the others to
 * the same physical place and scale (mm, when every slide states its pixel
 * spacing; else the same fraction of each slide). Slides need not share pixel
 * dimensions. The first view's viewport is applied to the others at once;
 * show a joining view's slide with `setSlide(slide, { fit: false })`, as a
 * pending fit would move it on its first frame and the link would carry that
 * back to the others. Returns the unlink function.
 */
export function linkSlideViews(views: readonly SlideView[]): () => void {
  const seen = new Map<SlideView, string>()
  // The viewport the link set on a view: its next frame, if still showing it,
  // is not echoed back; a gesture before that frame changes it and is pushed.
  const echoes = new Map<SlideView, string>()
  // Where the view shows, not its pixel numbers: a slide swapped for one with
  // other spacing at the same pixel viewport has moved.
  const key = (s: NVSlide): string => {
    const v = physicalView(s, !!s.manifest.pixelSpacingMM)
    return `${v.x},${v.y},${v.scale}`
  }
  const push = (source: SlideView): void => {
    const from = source.slide
    if (!from) return
    seen.set(source, key(from))
    for (const target of views) {
      const to = target.slide
      if (target === source || !to) continue
      const physical =
        !!from.manifest.pixelSpacingMM && !!to.manifest.pixelSpacingMM
      to.setViewport(viewportFrom(to, physicalView(from, physical), physical))
      // Clamp now, as the frame will: the echo key is what that frame shows.
      to.clampViewport(target.screen())
      echoes.set(target, key(to))
    }
  }
  // The first view leads at link time: a view joining (a lens, a compare
  // pane) takes the user's place rather than resetting it with its own fit.
  if (views[0]) push(views[0])
  const removers = views.map((source) =>
    source.addRenderListener(() => {
      const from = source.slide
      if (!from) return
      const k = key(from)
      const echo = echoes.get(source)
      echoes.delete(source)
      if (echo === k || seen.get(source) === k) {
        seen.set(source, k)
        return
      }
      push(source)
    }),
  )
  return () => {
    for (const remove of removers) remove()
  }
}

/**
 * Show `lens` through a circle that follows the pointer over `main` (Avivator's
 * lens): `lens.canvas` must cover `main.canvas` exactly; it takes no pointer
 * input. The views are linked. Returns the detach function.
 */
export function attachSlideLens(
  main: SlideView,
  lens: SlideView,
  { radiusCss = 96 }: { radiusCss?: number } = {},
): () => void {
  const style = lens.canvas.style
  style.pointerEvents = 'none'
  style.clipPath = 'circle(0px at -1px -1px)'
  const move = (e: PointerEvent): void => {
    const r = main.canvas.getBoundingClientRect()
    style.clipPath = `circle(${radiusCss}px at ${e.clientX - r.left}px ${e.clientY - r.top}px)`
  }
  const leave = (): void => {
    style.clipPath = 'circle(0px at -1px -1px)'
  }
  main.canvas.addEventListener('pointermove', move)
  main.canvas.addEventListener('pointerleave', leave)
  const unlink = linkSlideViews([main, lens])
  return () => {
    unlink()
    main.canvas.removeEventListener('pointermove', move)
    main.canvas.removeEventListener('pointerleave', leave)
    style.clipPath = ''
    style.pointerEvents = ''
  }
}

// A clipped quantized sample is only a bound of the true value: at the stored
// range's low end (0, int16 -32768) it is at most that, at the high end
// (65535, int16 32767) at least; otherwise only approximate.
function clippedBound(s: NVSlideSample): string {
  if (!s.clipped) return ''
  if (s.stored === 0 || s.stored === -32768) return '<='
  if (s.stored === 65535 || s.stored === 32767) return '>='
  return '~'
}

const formatNumber = (v: number): string =>
  Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(5)))

/**
 * One line for `sampleAt` results: base pixel, each channel's value (or why it
 * is missing) and the level read. Empty outside the slide.
 */
export function formatSlideSample(
  x: number,
  y: number,
  samples: readonly NVSlideSample[],
): string {
  if (!samples.length || samples[0]?.missing === 'outside') return ''
  const values = samples
    .map((s) => {
      const v = s.value === null ? s.missing : formatNumber(s.value)
      return `${s.name} ${clippedBound(s)}${v}`
    })
    .join(', ')
  return `${Math.floor(x)},${Math.floor(y)} ${values} (L${samples[0]?.level ?? '-'})`
}

/**
 * The slide's state as HUD rows (key, text): drawn level and why, zoom, tiles,
 * requests, bytes and failures. Reads the last frame's tiles when there is one.
 */
export function slideStatsSummary(
  slide: NVSlide,
  screen: NVSlideScreen,
): Array<[string, string]> {
  const { level, tiles, requestedLevel, capped } =
    slide.lastVisibleTiles ?? slide.visibleTiles(screen)
  const st = slide.stats
  const scale = slide.viewport.scale
  const mode = capped
    ? '(no level fits the tile cache: centre only, zoom in)'
    : requestedLevel
      ? `(L${requestedLevel.index} exceeds the tile cache)`
      : slide.levelChoice === 'auto'
        ? 'auto'
        : 'fixed'
  const icc = slide.colorLut
    ? `, ICC profile${slide.colorManagement ? '' : ' (off)'}`
    : ''
  return [
    ['slide', `${slide.name}: ${slide.manifest.levels.length} levels${icc}`],
    [
      'level',
      level ? `L${level.index} ${mode} ${level.width}x${level.height}` : '-',
    ],
    ['codec', level?.codec ?? '-'],
    [
      'zoom',
      scale >= 1 ? `${scale.toFixed(2)}x` : `1:${(1 / scale).toFixed(1)}`,
    ],
    ['tiles', `${tiles.length} visible, ${slide.pendingCount} pending`],
    [
      'requests',
      `${st.completed}/${st.requested} done, ${st.rangeHits} HTTP 206, ${st.fullFileFallbacks} HTTP 200`,
    ],
    ['wire', `${(st.wireBytes / 1e6).toFixed(2)} MB`],
    ['cache', `${(st.cacheBytes / 1e6).toFixed(2)} MB, ${st.cacheHits} hits`],
    ['failures', String(st.failures)],
  ]
}
