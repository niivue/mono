/**
 * The animate tool's handler: puts NiiVue's animateTo behind the server,
 * turning the tool's words (volumes and meshes by index or name, clip
 * planes by the parts that move) into NiiVue's target by index.
 */

import { MAX_ANIMATION_MS } from '../limits'
import { namePlane, planeDepthCuts } from '../planes'
import {
  choice,
  clamp,
  entries,
  flag,
  integer,
  number,
  numbers,
  type Params,
  pointIfGiven,
} from './params'
import { pickIndex } from './pick'
import type { AnimationTarget, Handlers, NiiVueHost, View } from './view'

const EASINGS = ['linear', 'easeIn', 'easeOut', 'easeInOut'] as const
const ANGLES = ['shortest', 'literal'] as const

/** The handler for the animate tool. */
export function animateHandlers(host: NiiVueHost): Handlers {
  const { view } = host

  /** The clip planes to move, each filled out from where it is now. */
  const clipPlanes = (
    list: Params[],
  ): Record<number, [number, number, number]> => {
    const planes: Record<number, [number, number, number]> = {}
    for (const entry of list) {
      const index = integer(entry, 'index') ?? 0
      if (index > 5) throw new Error('A clip plane index is 0 to 5.')
      const now = planes[index] ?? view.getClipPlaneDepthAziElev(index)
      const depth = number(entry, 'depth')
      const azimuth = number(entry, 'azimuth')
      const elevation = number(entry, 'elevation')
      if (
        depth === undefined &&
        azimuth === undefined &&
        elevation === undefined
      )
        throw new Error(
          `Clip plane ${index} needs something to move to: depth, azimuth or elevation.`,
        )
      const cutNow = Number.isFinite(now[0]) && planeDepthCuts(now[0])
      if (
        !cutNow &&
        (depth === undefined ||
          azimuth === undefined ||
          elevation === undefined)
      )
        throw new Error(
          `Clip plane ${index} cuts nothing yet, so give its depth, azimuth and elevation.`,
        )
      planes[index] = [
        depth ?? now[0],
        azimuth ?? now[1],
        clamp(elevation ?? now[2], -90, 90),
      ]
    }
    return planes
  }

  /** The volumes to change, by index, each checked against what it shows. */
  const volumeTargets = (list: Params[]) => {
    const targets: NonNullable<AnimationTarget['volumes']> = {}
    for (const entry of list) {
      const index = pickIndex(view.volumes, entry.volume, 'volume', 0)
      const shown = view.volumes[index]
      const target = { ...targets[index] }
      const calMin = number(entry, 'cal_min')
      const calMax = number(entry, 'cal_max')
      const opacity = number(entry, 'opacity')
      const frame = integer(entry, 'frame')
      if (calMin !== undefined) target.calMin = calMin
      if (calMax !== undefined) target.calMax = calMax
      if (opacity !== undefined) target.opacity = clamp(opacity, 0, 1)
      if (frame !== undefined) {
        const frames = shown.nFrame4D ?? 1
        if (frame >= frames)
          throw new Error(
            `${shown.name} has ${frames} frame${frames === 1 ? '' : 's'}, numbered from 0; there is no frame ${frame}.`,
          )
        target.frame4D = frame
      }
      if (Object.keys(target).length === 0)
        throw new Error(
          `${shown.name} needs something to move to: cal_min, cal_max, opacity or frame.`,
        )
      const low = target.calMin ?? shown.calMin
      const high = target.calMax ?? shown.calMax
      if (low !== undefined && high !== undefined && low > high)
        throw new Error(
          `cal_min (${low}) must not be above cal_max (${high}) for ${shown.name}; the window would be empty.`,
        )
      targets[index] = target
    }
    return targets
  }

  /** The meshes to fade, by index. */
  const meshTargets = (list: Params[]) => {
    const meshes = view.meshes ?? []
    const targets: NonNullable<AnimationTarget['meshes']> = {}
    for (const entry of list) {
      const index = pickIndex(meshes, entry.mesh, 'mesh', 0)
      const opacity = number(entry, 'opacity')
      if (opacity === undefined)
        throw new Error(`${meshes[index].name} needs an opacity to move to.`)
      targets[index] = { opacity: clamp(opacity, 0, 1) }
    }
    return targets
  }

  /** The target the tool's arguments name; empty when they name nothing. */
  const targetOf = (params: Params): AnimationTarget => {
    const target: AnimationTarget = {}
    const azimuth = number(params, 'azimuth')
    if (azimuth !== undefined) target.azimuth = azimuth
    const elevation = number(params, 'elevation')
    if (elevation !== undefined) target.elevation = clamp(elevation, -90, 90)
    const zoom = number(params, 'zoom')
    if (zoom !== undefined) {
      if (zoom <= 0) throw new Error('zoom must be above 0.')
      target.scaleMultiplier = zoom
    }
    const renderPan = numbers(params, 'render_pan', 2)
    if (renderPan) target.renderPan = [renderPan[0], renderPan[1]]
    const pan = numbers(params, 'pan_2d', 4)
    if (pan) {
      if (!(pan[3] > 0)) throw new Error('The zoom in pan_2d must be above 0.')
      target.pan2Dxyzmm = [pan[0], pan[1], pan[2], pan[3]]
    }
    const crosshair = pointIfGiven(params, 'crosshair_mm')
    if (crosshair) target.crosshairMM = crosshair
    const planes = entries(params, 'clip_planes')
    if (planes?.length) target.clipPlanes = clipPlanes(planes)
    const volumes = entries(params, 'volumes')
    if (volumes?.length) {
      if (!view.volumes.length)
        throw new Error('No volume is loaded: load one with load_volume first.')
      target.volumes = volumeTargets(volumes)
    }
    const meshes = entries(params, 'meshes')
    if (meshes?.length) {
      if (!view.meshes?.length) throw new Error('No mesh is loaded.')
      target.meshes = meshTargets(meshes)
    }
    return target
  }

  /**
   * Tells the person where a move that took the crosshair or a cut left
   * them, as go_to_point and set_clip_plane do. A failure to say so is
   * not the move's failure. A move a newer one replaced stays quiet: it
   * stopped mid-flight, and the newer move announces where it ends.
   */
  const announceEnd = async (
    target: AnimationTarget,
    result: { reason: string },
  ): Promise<void> => {
    if (!host.announce || result.reason === 'superseded') return
    const said: string[] = []
    try {
      if (target.crosshairMM) {
        const mm = Array.from(view.getCrosshairPos(), (v) => Math.round(v))
        said.push(
          host.describe
            ? await host.describe()
            : `Crosshair at ${mm.join(', ')} mm.`,
        )
      }
    } catch {
      // The place could not be put in words; the cut still can.
    }
    if (target.clipPlanes) said.push(`Cut plane: ${stateOf(host).plane.name}.`)
    if (said.length) host.announce(said.join(' '))
  }

  return {
    async animate(params: Params) {
      host.beforeAnswer?.()
      if (!view.animateTo || !view.stopAnimation)
        throw new Error("This page's NiiVue cannot animate.")
      // A move may be stopped whatever is loaded.
      if (flag(params, 'stop')) {
        const running = view.isAnimating === true
        view.stopAnimation()
        return { stopped: running, ...stateOf(host) }
      }
      // A camera, a cut or a mesh moves without a volume; only a volume target needs one.
      if (!view.volumes.length && !view.meshes?.length)
        throw new Error(
          'Nothing is loaded to move: load a volume with load_volume or a mesh with load_mesh first.',
        )
      const target = targetOf(params)
      if (Object.keys(target).length === 0)
        throw new Error(
          'animate needs something to move to: azimuth, elevation, zoom, render_pan, pan_2d, ' +
            'crosshair_mm, clip_planes, volumes or meshes; or stop.',
        )
      const duration = number(params, 'duration_ms')
      if (
        duration !== undefined &&
        (duration < 0 || duration > MAX_ANIMATION_MS)
      )
        throw new Error(
          `duration_ms must be 0 to ${MAX_ANIMATION_MS}, so the move ends before the call times out.`,
        )
      const easing = choice(params, 'easing', EASINGS)
      const angles = choice(params, 'angles', ANGLES)
      const interrupt = flag(params, 'interrupt_on_input')
      const done = view.animateTo(target, {
        ...(duration !== undefined ? { duration } : {}),
        ...(easing ? { easing } : {}),
        ...(angles ? { angles } : {}),
        ...(interrupt !== undefined ? { interruptOnInput: interrupt } : {}),
      })
      if (params?.wait === false || params?.wait === 'false') {
        // Leave the move running; a rejection later has nobody to hear it.
        done.then((result) => announceEnd(target, result)).catch(() => {})
        return {
          started: true,
          durationMs: duration ?? 500,
          moving: Object.keys(target),
        }
      }
      const result = await done
      view.drawScene()
      await announceEnd(target, result)
      return {
        completed: result.completed,
        reason: result.reason,
        elapsedMs: Math.round(result.elapsedMs),
        ...(result.failed?.length ? { failed: result.failed } : {}),
        ...stateOf(host),
      }
    },
  }
}

/** The camera, the first cut and the crosshair, as the scene stands. */
function stateOf(host: NiiVueHost) {
  const { view } = host
  const [depth, azimuth, elevation] = view.getClipPlaneDepthAziElev(0)
  return {
    camera: cameraOf(view),
    plane: {
      name: host.planeName?.() ?? namePlane(depth, azimuth, elevation),
      depth,
      azimuth,
      elevation,
    },
    crosshairMM: Array.from(view.getCrosshairPos(), (v) => round(v)),
  }
}

function cameraOf(view: View) {
  return {
    azimuth: view.azimuth,
    elevation: view.elevation,
    ...(view.scaleMultiplier !== undefined
      ? { zoom: view.scaleMultiplier }
      : {}),
  }
}

/** A millimetre to a hundredth. */
function round(v: number): number {
  return Math.round(v * 100) / 100
}
