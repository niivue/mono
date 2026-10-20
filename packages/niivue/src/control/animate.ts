import { log } from '@/logger'
import { NUM_CLIP_PLANE } from '@/NVConstants'
import type NiiVueGPU from '@/NVControlBase'
import type {
  AnimationEasing,
  AnimationEndReason,
  AnimationOptions,
  AnimationResult,
  AnimationTarget,
} from '@/NVTypes'

/**
 * Timed transitions between scene states, behind `NiiVue.animateTo`.
 *
 * A transition is planned once, up front, as a list of channels: each one
 * reads where its property is now, knows where it should end, and writes
 * through the same public setter an app would call, so events, redraw
 * coalescing and clamping all behave as they do for a direct write. The
 * runner then samples every channel on each animation frame.
 *
 * Kept in a leaf module (type-only controller import) with an injectable
 * clock, so planning, easing and timing are unit-testable under the bun test
 * runner, unlike the controller itself.
 */

/** How a number moves from start to end. */
type TrackKind =
  /** Straight interpolation. */
  | 'linear'
  /** Degrees, the short way round (literal angles plan as 'linear'). */
  | 'angle'
  /** A whole number, rounded from the straight interpolation. */
  | 'index'

interface Track {
  from: number
  to: number
  kind: TrackKind
}

/**
 * One property, or a group of numbers written together (a crosshair, a clip
 * plane), and the setter that writes them. A write that returns a promise is
 * paced: frames that arrive while it is in flight are skipped rather than
 * queued, so a slow GPU rebuild drops frames instead of falling behind.
 */
export interface AnimationChannel {
  name: string
  tracks: Track[]
  write: (values: number[]) => void | Promise<void>
}

/** The clock and frame source a transition runs on. */
export interface AnimationClock {
  now(): number
  requestFrame(cb: () => void): number
  cancelFrame(id: number): void
  setTimer(cb: () => void, ms: number): unknown
  clearTimer(id: unknown): void
}

const browserClock: AnimationClock = {
  now: () => performance.now(),
  requestFrame: (cb) => requestAnimationFrame(cb),
  cancelFrame: (id) => cancelAnimationFrame(id),
  setTimer: (cb, ms) => setTimeout(cb, ms),
  clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
}

/** Default length of a transition, in milliseconds. */
const DEFAULT_DURATION_MS = 500

/**
 * Extra time past the end before a transition stops waiting for frames and
 * jumps to its target. A hidden tab stops animation frames entirely, but
 * timers still fire (throttled), so an awaited animateTo always settles.
 */
export const STALL_GRACE_MS = 250

const EASINGS: Record<AnimationEasing, (t: number) => number> = {
  linear: (t) => t,
  easeIn: (t) => t * t * t,
  easeOut: (t) => 1 - (1 - t) ** 3,
  easeInOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
}

/** Resolve an easing option to a function, falling back to easeInOut. */
export function easingFunction(
  easing: AnimationOptions['easing'],
): (t: number) => number {
  if (typeof easing === 'function') return easing
  if (easing === undefined) return EASINGS.easeInOut
  const fn = EASINGS[easing]
  if (fn) return fn
  log.warn(`animateTo: unknown easing "${easing}", using easeInOut`)
  return EASINGS.easeInOut
}

/** The signed turn from `from` to `to` in degrees, in (-180, 180]. */
export function shortestTurn(from: number, to: number): number {
  const d = (((to - from) % 360) + 360) % 360
  return d > 180 ? d - 360 : d
}

/** A track's value at progress `u` (0 at the start, 1 at the end). */
export function sampleTrack(track: Track, u: number): number {
  // The end is exact, so a finished transition lands on the target as given.
  if (u >= 1) return track.to
  if (u <= 0) return track.from
  switch (track.kind) {
    case 'angle':
      return track.from + shortestTurn(track.from, track.to) * u
    case 'index':
      return Math.round(track.from + (track.to - track.from) * u)
    default:
      return track.from + (track.to - track.from) * u
  }
}

function track(from: number, to: number, kind: TrackKind): Track {
  // A start that cannot be read (a disabled clip plane has no direction)
  // jumps to the target rather than interpolating from NaN.
  return { from: Number.isFinite(from) ? from : to, to, kind }
}

function finite(name: string, value: unknown): value is number {
  if (typeof value === 'number' && Number.isFinite(value)) return true
  log.warn(`animateTo: ${name} is not a finite number, leaving it as is`)
  return false
}

function finiteTuple(
  name: string,
  value: unknown,
  length: number,
): value is number[] {
  if (
    Array.isArray(value) &&
    value.length === length &&
    value.every((v) => typeof v === 'number' && Number.isFinite(v))
  )
    return true
  log.warn(
    `animateTo: ${name} needs ${length} finite numbers, leaving it as is`,
  )
  return false
}

/** The indices of a by-index record, dropping any that are out of range. */
function indices(
  name: string,
  record: Record<number, unknown> | undefined,
  count: number,
): number[] {
  if (!record) return []
  const out: number[] = []
  for (const key of Object.keys(record)) {
    const i = Number(key)
    if (Number.isInteger(i) && i >= 0 && i < count) out.push(i)
    else log.warn(`animateTo: there is no ${name} ${key}, skipping it`)
  }
  return out
}

/**
 * Read where each targeted property is now and plan a channel for it.
 * Properties the target leaves out get no channel and are never written.
 */
export function planAnimation(
  ctrl: NiiVueGPU,
  target: AnimationTarget,
  angles: AnimationOptions['angles'] = 'shortest',
): AnimationChannel[] {
  const angle: TrackKind = angles === 'literal' ? 'linear' : 'angle'
  const channels: AnimationChannel[] = []

  if (target.azimuth !== undefined && finite('azimuth', target.azimuth))
    channels.push({
      name: 'azimuth',
      tracks: [track(ctrl.azimuth, target.azimuth, angle)],
      write: ([v]) => {
        ctrl.azimuth = v
      },
    })
  if (target.elevation !== undefined && finite('elevation', target.elevation))
    channels.push({
      name: 'elevation',
      tracks: [track(ctrl.elevation, target.elevation, 'linear')],
      write: ([v]) => {
        ctrl.elevation = v
      },
    })
  if (
    target.scaleMultiplier !== undefined &&
    finite('scaleMultiplier', target.scaleMultiplier)
  )
    channels.push({
      name: 'scaleMultiplier',
      tracks: [track(ctrl.scaleMultiplier, target.scaleMultiplier, 'linear')],
      write: ([v]) => {
        ctrl.scaleMultiplier = v
      },
    })
  if (
    target.renderPan !== undefined &&
    finiteTuple('renderPan', target.renderPan, 2)
  ) {
    const now = ctrl.renderPan
    const to = target.renderPan
    channels.push({
      name: 'renderPan',
      tracks: to.map((v, i) => track(now[i], v, 'linear')),
      write: (v) => {
        ctrl.renderPan = [v[0], v[1]]
      },
    })
  }
  if (
    target.pan2Dxyzmm !== undefined &&
    finiteTuple('pan2Dxyzmm', target.pan2Dxyzmm, 4)
  ) {
    const now = ctrl.pan2Dxyzmm
    const to = target.pan2Dxyzmm
    channels.push({
      name: 'pan2Dxyzmm',
      tracks: to.map((v, i) => track(now[i], v, 'linear')),
      write: (v) => {
        ctrl.pan2Dxyzmm = [v[0], v[1], v[2], v[3]]
      },
    })
  }
  if (
    target.crosshairMM !== undefined &&
    finiteTuple('crosshairMM', target.crosshairMM, 3)
  ) {
    const now = ctrl.getCrosshairPos()
    const to = target.crosshairMM
    channels.push({
      name: 'crosshairMM',
      tracks: to.map((v, i) => track(now[i], v, 'linear')),
      write: (v) => ctrl.setCrosshairPos([v[0], v[1], v[2]]),
    })
  }

  const planes = target.clipPlanes
  for (const i of indices('clip plane', planes, NUM_CLIP_PLANE)) {
    const to = planes?.[i]
    if (!finiteTuple(`clipPlanes[${i}]`, to, 3)) continue
    const now = ctrl.getClipPlaneDepthAziElev(i)
    channels.push({
      name: `clipPlanes[${i}]`,
      tracks: [
        track(now[0], to[0], 'linear'),
        track(now[1], to[1], angle),
        track(now[2], to[2], 'linear'),
      ],
      write: (v) => ctrl.setClipPlaneDepthAziElev(v[0], v[1], v[2], i),
    })
  }

  const volumes = ctrl.volumes
  for (const i of indices('volume', target.volumes, volumes.length)) {
    const want = target.volumes?.[i] ?? {}
    const vol = volumes[i]
    const display: [keyof typeof want, number][] = []
    for (const key of ['calMin', 'calMax', 'opacity'] as const) {
      const v = want[key]
      if (v !== undefined && finite(`volumes[${i}].${key}`, v))
        display.push([key, v])
    }
    if (display.length > 0) {
      const keys = display.map(([k]) => k)
      channels.push({
        name: `volumes[${i}]`,
        tracks: display.map(([k, v]) =>
          track((vol[k] as number | undefined) ?? v, v, 'linear'),
        ),
        write: (v) =>
          ctrl.setVolume(i, Object.fromEntries(keys.map((k, j) => [k, v[j]]))),
      })
    }
    if (
      want.frame4D !== undefined &&
      finite(`volumes[${i}].frame4D`, want.frame4D)
    ) {
      const last = Math.max(0, (vol.nFrame4D ?? 1) - 1)
      const to = Math.max(0, Math.min(Math.round(want.frame4D), last))
      channels.push({
        name: `volumes[${i}].frame4D`,
        tracks: [track(vol.frame4D ?? 0, to, 'index')],
        // setFrame4D finds a volume by id; one without an id takes the
        // frame through setVolume instead.
        write: ([v]) =>
          vol.id
            ? ctrl.setFrame4D(vol.id, v)
            : ctrl.setVolume(i, { frame4D: v }),
      })
    }
  }

  const meshes = ctrl.meshes
  for (const i of indices('mesh', target.meshes, meshes.length)) {
    const v = target.meshes?.[i]?.opacity
    if (v === undefined || !finite(`meshes[${i}].opacity`, v)) continue
    channels.push({
      name: `meshes[${i}]`,
      tracks: [track(meshes[i].opacity ?? 1, v, 'linear')],
      write: ([o]) => ctrl.setMesh(i, { opacity: o }),
    })
  }
  return channels
}

/** Per-channel bookkeeping while a transition runs. */
interface ChannelState {
  channel: AnimationChannel
  /** The values last handed to the setter, so unchanged frames skip it. */
  written: number[] | null
  /** A paced write still in flight. */
  busy: Promise<void> | null
}

function same(a: number[] | null, b: number[]): boolean {
  return a !== null && a.length === b.length && a.every((v, i) => v === b[i])
}

/**
 * One running transition. Construct it with its channels and call `start`;
 * `result` settles once, when the target is reached or the run is stopped.
 * Stopping leaves every property where the last frame put it.
 */
export class Animation {
  readonly result: Promise<AnimationResult>
  private readonly states: ChannelState[]
  private readonly duration: number
  private readonly ease: (t: number) => number
  private startedAt = 0
  private frameId: number | null = null
  private timer: unknown = null
  private settled = false
  private finishing = false
  private resolve: (r: AnimationResult) => void = () => {}

  constructor(
    channels: AnimationChannel[],
    options: AnimationOptions,
    private readonly clock: AnimationClock = browserClock,
  ) {
    this.states = channels.map((channel) => ({
      channel,
      written: null,
      busy: null,
    }))
    const d = options.duration ?? DEFAULT_DURATION_MS
    if (!Number.isFinite(d) || d < 0)
      log.warn(`animateTo: duration ${d} is not a non-negative number, using 0`)
    this.duration = Number.isFinite(d) && d > 0 ? d : 0
    this.ease = easingFunction(options.easing)
    this.result = new Promise((resolve) => {
      this.resolve = resolve
    })
  }

  /** True until the transition has settled. */
  get running(): boolean {
    return !this.settled
  }

  start(): Promise<AnimationResult> {
    this.startedAt = this.clock.now()
    if (this.duration === 0 || this.states.length === 0) {
      void this.finish('finished')
      return this.result
    }
    this.timer = this.clock.setTimer(
      () => void this.finish('stalled'),
      this.duration + STALL_GRACE_MS,
    )
    this.frameId = this.clock.requestFrame(this.tick)
    return this.result
  }

  /** End now, leaving every property where the last frame put it. */
  stop(reason: AnimationEndReason): void {
    if (this.settled) return
    this.cancelPending()
    this.settle(false, reason)
  }

  private readonly tick = (): void => {
    this.frameId = null
    if (this.settled || this.finishing) return
    const t = (this.clock.now() - this.startedAt) / this.duration
    if (t >= 1) {
      void this.finish('finished')
      return
    }
    const u = this.ease(t)
    for (const s of this.states) {
      if (s.busy) continue
      void this.write(
        s,
        s.channel.tracks.map((tr) => sampleTrack(tr, u)),
      )
      // A setter's listener may have stopped this run or started another.
      if (this.settled || this.finishing) return
    }
    this.frameId = this.clock.requestFrame(this.tick)
  }

  /**
   * Hands `values` to the channel's setter, unless they were the last ones
   * written and landed. Settles true once the write has landed, false if it
   * threw or rejected (logged here).
   */
  private write(s: ChannelState, values: number[]): Promise<boolean> {
    if (same(s.written, values)) return Promise.resolve(true)
    s.written = values
    let out: void | Promise<void>
    try {
      out = s.channel.write(values)
    } catch (e) {
      log.warn(`animateTo: writing ${s.channel.name} failed`, e)
      s.written = null
      return Promise.resolve(false)
    }
    if (!(out instanceof Promise)) return Promise.resolve(true)
    const landed = out.then(
      () => true,
      (e) => {
        log.warn(`animateTo: writing ${s.channel.name} failed`, e)
        s.written = null
        return false
      },
    )
    const busy = landed.then(() => {})
    s.busy = busy
    void busy.then(() => {
      if (s.busy === busy) s.busy = null
    })
    return landed
  }

  /** Land every channel exactly on its target, then settle. */
  private async finish(reason: AnimationEndReason): Promise<void> {
    if (this.settled || this.finishing) return
    this.finishing = true
    this.cancelPending()
    // Let paced writes land first, so the target is the last thing written.
    await Promise.all(this.states.map((s) => s.busy))
    if (this.settled) return
    const ends: Promise<boolean>[] = []
    for (const s of this.states) {
      ends.push(
        this.write(
          s,
          s.channel.tracks.map((tr) => tr.to),
        ),
      )
      // A setter's listener may have stopped this run or started another.
      if (this.settled) return
    }
    const landed = await Promise.all(ends)
    if (this.settled) return
    const failed = this.states
      .filter((_, i) => !landed[i])
      .map((s) => s.channel.name)
    if (failed.length > 0) this.settle(false, 'failed', failed)
    else this.settle(true, reason)
  }

  private cancelPending(): void {
    if (this.frameId !== null) this.clock.cancelFrame(this.frameId)
    this.frameId = null
    if (this.timer !== null) this.clock.clearTimer(this.timer)
    this.timer = null
  }

  private settle(
    completed: boolean,
    reason: AnimationEndReason,
    failed?: string[],
  ): void {
    if (this.settled) return
    this.settled = true
    this.resolve({
      completed,
      reason,
      elapsedMs: Math.max(0, this.clock.now() - this.startedAt),
      ...(failed ? { failed } : {}),
    })
  }
}
