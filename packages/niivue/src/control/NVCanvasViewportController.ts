/**
 * OpenSeadragon-style pan/zoom controller for the canvas viewport.
 *
 * Wraps a `CanvasViewport` (`{ pan, zoom }`) with smooth animated zoom around
 * the cursor and inertial pan. Pure pointer/wheel UX on top of `setViewport` —
 * no OpenSeadragon dependency.
 *
 * Usage:
 *   const ctl = new NVCanvasViewportController(canvas, {
 *     apply: (v) => nv1.setViewport(v),
 *     getViewport: () => nv1.getViewport(),
 *   })
 *   ctl.attach()
 *   // ...
 *   ctl.detach()
 */

import type { CanvasViewport } from '@/NVTypes'

export type NVCanvasViewportControllerOptions = {
  /** Apply a viewport update — usually `(v) => nv1.setViewport(v)`. */
  apply: (viewport: CanvasViewport) => void
  /** Read current viewport (used to seed the controller). */
  getViewport?: () => CanvasViewport
  /** Min zoom (default 0.1). */
  minZoom?: number
  /** Max zoom (default 50). */
  maxZoom?: number
  /** Wheel ΔY → zoom factor sensitivity (default 0.0015). */
  zoomSensitivity?: number
  /** Animate wheel zoom (default true). */
  smoothZoom?: boolean
  /** Time constant (ms) for the smooth-zoom exponential ease (default 90). */
  zoomTimeConstantMs?: number
  /** Enable inertial pan after release (default true). */
  inertia?: boolean
  /** Velocity decay per ~16ms frame (default 0.92). 0=instant stop, 1=no decay. */
  friction?: number
  /** Mouse button for pan: 0=left, 1=middle, 2=right, 'any' (default 2). */
  panButton?: 0 | 1 | 2 | 'any'
  /** Allow alt/meta + left-click to pan even if `panButton` is right (default true). */
  modifierPanWithLeft?: boolean
  /** Optional pan clamp ([min,max] in normalized canvas units, GL convention). */
  panBounds?: { min: [number, number]; max: [number, number] } | null
  /** Optional listener for every viewport change. */
  onChange?: (viewport: CanvasViewport) => void
}

const DEFAULTS = {
  minZoom: 0.1,
  maxZoom: 50,
  zoomSensitivity: 0.0015,
  smoothZoom: true,
  zoomTimeConstantMs: 90,
  inertia: true,
  friction: 0.92,
  panButton: 2 as 0 | 1 | 2 | 'any',
  modifierPanWithLeft: true,
}

type ResolvedOptions = Required<
  Omit<
    NVCanvasViewportControllerOptions,
    'getViewport' | 'panBounds' | 'onChange'
  >
> & {
  getViewport: NVCanvasViewportControllerOptions['getViewport']
  panBounds: NVCanvasViewportControllerOptions['panBounds']
  onChange: NVCanvasViewportControllerOptions['onChange']
}

/**
 * Smooth pan/zoom controller. One per canvas. Multiple sibling NiiVue instances
 * share the same canvas viewport, so a single controller drives them all via
 * the supplied `apply` callback.
 */
export class NVCanvasViewportController {
  private canvas: HTMLCanvasElement
  private opts: ResolvedOptions

  // Mutable viewport state. `current` is what we display; `target` is where we're heading.
  private current: CanvasViewport = { pan: [0, 0], zoom: 1 }
  private target: CanvasViewport = { pan: [0, 0], zoom: 1 }

  // Pan state
  private isPanning = false
  private panPointerId: number | null = null
  private panStartClient: [number, number] = [0, 0]
  private panStartViewport: CanvasViewport = { pan: [0, 0], zoom: 1 }
  // Pan units per ms
  private velocity: [number, number] = [0, 0]
  // Recent pointer positions for velocity estimation
  private samples: { t: number; x: number; y: number }[] = []

  // RAF state
  private rafId: number | null = null
  private lastTickMs = 0

  private attached = false
  private boundOnPointerDown: (e: PointerEvent) => void
  private boundOnPointerMove: (e: PointerEvent) => void
  private boundOnPointerUp: (e: PointerEvent) => void
  private boundOnPointerCancel: (e: PointerEvent) => void
  private boundOnWheel: (e: WheelEvent) => void
  private boundOnContextMenu: (e: MouseEvent) => void

  constructor(
    canvas: HTMLCanvasElement,
    options: NVCanvasViewportControllerOptions,
  ) {
    if (!canvas || !(canvas instanceof HTMLCanvasElement)) {
      throw new Error(
        'NVCanvasViewportController: canvas must be an HTMLCanvasElement',
      )
    }
    if (typeof options.apply !== 'function') {
      throw new Error('NVCanvasViewportController: options.apply is required')
    }
    this.canvas = canvas
    this.opts = {
      apply: options.apply,
      getViewport: options.getViewport,
      minZoom: options.minZoom ?? DEFAULTS.minZoom,
      maxZoom: options.maxZoom ?? DEFAULTS.maxZoom,
      zoomSensitivity: options.zoomSensitivity ?? DEFAULTS.zoomSensitivity,
      smoothZoom: options.smoothZoom ?? DEFAULTS.smoothZoom,
      zoomTimeConstantMs:
        options.zoomTimeConstantMs ?? DEFAULTS.zoomTimeConstantMs,
      inertia: options.inertia ?? DEFAULTS.inertia,
      friction: options.friction ?? DEFAULTS.friction,
      panButton: options.panButton ?? DEFAULTS.panButton,
      modifierPanWithLeft:
        options.modifierPanWithLeft ?? DEFAULTS.modifierPanWithLeft,
      panBounds: options.panBounds ?? null,
      onChange: options.onChange,
    }

    // Seed from current viewport if provided
    if (this.opts.getViewport) {
      const v = this.opts.getViewport()
      this.current = { pan: [v.pan[0], v.pan[1]], zoom: v.zoom }
      this.target = { pan: [v.pan[0], v.pan[1]], zoom: v.zoom }
    }

    this.boundOnPointerDown = this.onPointerDown.bind(this)
    this.boundOnPointerMove = this.onPointerMove.bind(this)
    this.boundOnPointerUp = this.onPointerUp.bind(this)
    this.boundOnPointerCancel = this.onPointerCancel.bind(this)
    this.boundOnWheel = this.onWheel.bind(this)
    this.boundOnContextMenu = (e) => e.preventDefault()
  }

  attach(): void {
    if (this.attached) return
    this.canvas.addEventListener('pointerdown', this.boundOnPointerDown)
    this.canvas.addEventListener('pointermove', this.boundOnPointerMove)
    this.canvas.addEventListener('pointerup', this.boundOnPointerUp)
    this.canvas.addEventListener('pointercancel', this.boundOnPointerCancel)
    this.canvas.addEventListener('wheel', this.boundOnWheel, { passive: false })
    this.canvas.addEventListener('contextmenu', this.boundOnContextMenu)
    this.attached = true
  }

  detach(): void {
    if (!this.attached) return
    this.canvas.removeEventListener('pointerdown', this.boundOnPointerDown)
    this.canvas.removeEventListener('pointermove', this.boundOnPointerMove)
    this.canvas.removeEventListener('pointerup', this.boundOnPointerUp)
    this.canvas.removeEventListener('pointercancel', this.boundOnPointerCancel)
    this.canvas.removeEventListener('wheel', this.boundOnWheel)
    this.canvas.removeEventListener('contextmenu', this.boundOnContextMenu)
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    this.attached = false
  }

  /** Snap the viewport instantly (no animation) and stop any inertia. */
  reset(viewport: CanvasViewport = { pan: [0, 0], zoom: 1 }): void {
    this.cancelMotion()
    this.current = {
      pan: [viewport.pan[0], viewport.pan[1]],
      zoom: viewport.zoom,
    }
    this.target = {
      pan: [viewport.pan[0], viewport.pan[1]],
      zoom: viewport.zoom,
    }
    this.applyNow()
  }

  /** Imperative setViewport, optionally animated (smooth zoom + slide). */
  setViewport(
    viewport: CanvasViewport,
    opts: { animate?: boolean } = {},
  ): void {
    const animate = opts.animate ?? false
    this.cancelInertia()
    this.target = {
      pan: [viewport.pan[0], viewport.pan[1]],
      zoom: this.clampZoom(viewport.zoom),
    }
    this.clampPanInPlace(this.target.pan)
    if (!animate) {
      this.current = {
        pan: [this.target.pan[0], this.target.pan[1]],
        zoom: this.target.zoom,
      }
      this.applyNow()
    } else {
      this.kickRaf()
    }
  }

  /** Zoom around a point in normalized canvas coordinates (0..1, GL convention y-up). */
  zoomTo(
    zoom: number,
    anchor?: [number, number] | null,
    opts: { animate?: boolean } = {},
  ): void {
    const animate = opts.animate ?? this.opts.smoothZoom
    const newZoom = this.clampZoom(zoom)
    const a = anchor ?? [0.5, 0.5]
    // Compute target pan so the world point under `a` at current target zoom stays under `a`.
    const z = this.target.zoom
    const worldX = (a[0] - 0.5 - this.target.pan[0]) / z + 0.5
    const worldY = (a[1] - 0.5 - this.target.pan[1]) / z + 0.5
    const newPanX = a[0] - ((worldX - 0.5) * newZoom + 0.5)
    const newPanY = a[1] - ((worldY - 0.5) * newZoom + 0.5)
    this.target.zoom = newZoom
    this.target.pan = [newPanX, newPanY]
    this.clampPanInPlace(this.target.pan)
    this.cancelInertia()
    if (!animate) {
      this.current = {
        pan: [this.target.pan[0], this.target.pan[1]],
        zoom: this.target.zoom,
      }
      this.applyNow()
    } else {
      this.kickRaf()
    }
  }

  /** Read the controller's current viewport. */
  getViewport(): CanvasViewport {
    return {
      pan: [this.current.pan[0], this.current.pan[1]],
      zoom: this.current.zoom,
    }
  }

  // ---- Internal -------------------------------------------------------------

  private clampZoom(z: number): number {
    if (!Number.isFinite(z) || z <= 0) return this.current.zoom
    return Math.max(this.opts.minZoom, Math.min(this.opts.maxZoom, z))
  }

  private clampPanInPlace(pan: [number, number]): void {
    const b = this.opts.panBounds
    if (!b) return
    pan[0] = Math.max(b.min[0], Math.min(b.max[0], pan[0]))
    pan[1] = Math.max(b.min[1], Math.min(b.max[1], pan[1]))
  }

  private cancelMotion(): void {
    this.velocity = [0, 0]
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    this.lastTickMs = 0
  }

  private cancelInertia(): void {
    this.velocity = [0, 0]
  }

  private applyNow(): void {
    const v: CanvasViewport = {
      pan: [this.current.pan[0], this.current.pan[1]],
      zoom: this.current.zoom,
    }
    this.opts.apply(v)
    this.opts.onChange?.(v)
  }

  private needsTick(): boolean {
    if (
      this.opts.smoothZoom &&
      Math.abs(this.current.zoom - this.target.zoom) > 1e-4
    ) {
      return true
    }
    if (Math.abs(this.current.pan[0] - this.target.pan[0]) > 1e-5) return true
    if (Math.abs(this.current.pan[1] - this.target.pan[1]) > 1e-5) return true
    if (
      Math.abs(this.velocity[0]) > 1e-5 ||
      Math.abs(this.velocity[1]) > 1e-5
    ) {
      return true
    }
    return false
  }

  private kickRaf(): void {
    if (this.rafId !== null) return
    this.lastTickMs = 0
    this.rafId = requestAnimationFrame(this.tick)
  }

  private tick = (now: number): void => {
    const last = this.lastTickMs || now
    const dt = Math.min(50, Math.max(1, now - last))
    this.lastTickMs = now

    // Smooth zoom + pan: exponential approach to target with time constant.
    if (this.opts.smoothZoom) {
      const tau = this.opts.zoomTimeConstantMs
      const k = 1 - Math.exp(-dt / tau)
      this.current.zoom += (this.target.zoom - this.current.zoom) * k
      this.current.pan[0] += (this.target.pan[0] - this.current.pan[0]) * k
      this.current.pan[1] += (this.target.pan[1] - this.current.pan[1]) * k
      // Snap when very close to avoid lingering sub-pixel updates.
      if (Math.abs(this.current.zoom - this.target.zoom) < 1e-4) {
        this.current.zoom = this.target.zoom
      }
      if (Math.abs(this.current.pan[0] - this.target.pan[0]) < 1e-5) {
        this.current.pan[0] = this.target.pan[0]
      }
      if (Math.abs(this.current.pan[1] - this.target.pan[1]) < 1e-5) {
        this.current.pan[1] = this.target.pan[1]
      }
    }

    // Inertia: integrate velocity, decay with friction. Only when not actively panning.
    if (
      !this.isPanning &&
      (Math.abs(this.velocity[0]) > 1e-5 || Math.abs(this.velocity[1]) > 1e-5)
    ) {
      this.target.pan[0] += this.velocity[0] * dt
      this.target.pan[1] += this.velocity[1] * dt
      this.clampPanInPlace(this.target.pan)
      // Mirror to current immediately if zoom isn't animating, so inertia feels direct.
      if (!this.opts.smoothZoom || this.current.zoom === this.target.zoom) {
        this.current.pan[0] = this.target.pan[0]
        this.current.pan[1] = this.target.pan[1]
      }
      const decay = this.opts.friction ** (dt / 16)
      this.velocity[0] *= decay
      this.velocity[1] *= decay
      if (Math.hypot(this.velocity[0], this.velocity[1]) < 5e-5) {
        this.velocity = [0, 0]
      }
    }

    this.applyNow()

    if (this.needsTick()) {
      this.rafId = requestAnimationFrame(this.tick)
    } else {
      this.rafId = null
      this.lastTickMs = 0
    }
  }

  // ---- Pointer / wheel handlers --------------------------------------------

  private isPanTrigger(e: PointerEvent): boolean {
    const pb = this.opts.panButton
    if (pb === 'any') return true
    if (e.button === pb) return true
    if (
      this.opts.modifierPanWithLeft &&
      e.button === 0 &&
      (e.altKey || e.metaKey)
    ) {
      return true
    }
    return false
  }

  private onPointerDown(e: PointerEvent): void {
    if (!this.isPanTrigger(e)) return
    this.cancelInertia()
    this.isPanning = true
    this.panPointerId = e.pointerId
    this.panStartClient = [e.clientX, e.clientY]
    this.panStartViewport = {
      pan: [this.target.pan[0], this.target.pan[1]],
      zoom: this.target.zoom,
    }
    this.samples = [{ t: e.timeStamp, x: e.clientX, y: e.clientY }]
    this.canvas.setPointerCapture?.(e.pointerId)
    e.preventDefault()
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.isPanning || e.pointerId !== this.panPointerId) return
    const rect = this.canvas.getBoundingClientRect()
    const dxNorm = (e.clientX - this.panStartClient[0]) / rect.width
    const dyNorm = -(e.clientY - this.panStartClient[1]) / rect.height
    this.target.pan[0] = this.panStartViewport.pan[0] + dxNorm
    this.target.pan[1] = this.panStartViewport.pan[1] + dyNorm
    this.clampPanInPlace(this.target.pan)
    // During an active drag, the controller responds synchronously — no RAF easing.
    this.current.pan[0] = this.target.pan[0]
    this.current.pan[1] = this.target.pan[1]
    this.applyNow()

    // Track a small history for velocity estimation. Keep last ~80ms.
    this.samples.push({ t: e.timeStamp, x: e.clientX, y: e.clientY })
    const cutoff = e.timeStamp - 80
    while (this.samples.length > 2 && this.samples[0].t < cutoff) {
      this.samples.shift()
    }
    e.preventDefault()
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.isPanning || e.pointerId !== this.panPointerId) return
    this.isPanning = false
    this.panPointerId = null
    this.canvas.releasePointerCapture?.(e.pointerId)

    if (this.opts.inertia && this.samples.length >= 2) {
      const rect = this.canvas.getBoundingClientRect()
      const a = this.samples[0]
      const b = this.samples[this.samples.length - 1]
      const dt = Math.max(1, b.t - a.t)
      // norm/ms
      const vx = (b.x - a.x) / dt / rect.width
      const vy = -(b.y - a.y) / dt / rect.height
      // Skip inertia for taps / very slow flicks.
      const speed = Math.hypot(vx, vy)
      if (speed > 5e-4) {
        this.velocity = [vx, vy]
        this.kickRaf()
      }
    }
    this.samples = []
  }

  private onPointerCancel(e: PointerEvent): void {
    if (e.pointerId !== this.panPointerId) return
    this.isPanning = false
    this.panPointerId = null
    this.samples = []
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault()
    const rect = this.canvas.getBoundingClientRect()
    const cx = (e.clientX - rect.left) / rect.width
    const cy = 1 - (e.clientY - rect.top) / rect.height

    const factor = Math.exp(-e.deltaY * this.opts.zoomSensitivity)
    const newZoom = this.clampZoom(this.target.zoom * factor)

    // Recompute target pan so the world point under the cursor at the *target*
    // viewport (where wheel events accumulate) stays under the cursor at newZoom.
    const z = this.target.zoom
    const worldX = (cx - 0.5 - this.target.pan[0]) / z + 0.5
    const worldY = (cy - 0.5 - this.target.pan[1]) / z + 0.5
    this.target.pan[0] = cx - ((worldX - 0.5) * newZoom + 0.5)
    this.target.pan[1] = cy - ((worldY - 0.5) * newZoom + 0.5)
    this.target.zoom = newZoom
    this.clampPanInPlace(this.target.pan)
    this.cancelInertia()

    if (!this.opts.smoothZoom) {
      this.current.zoom = this.target.zoom
      this.current.pan[0] = this.target.pan[0]
      this.current.pan[1] = this.target.pan[1]
      this.applyNow()
    } else {
      this.kickRaf()
    }
  }
}

export default NVCanvasViewportController
