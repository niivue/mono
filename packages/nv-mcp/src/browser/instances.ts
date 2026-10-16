/**
 * The instances tool's handler: puts NiiVue's setInstances behind the
 * server, so an agent can lay out a global 3D scene (volumes placed,
 * scaled and turned in one world, seen by the global camera) or tile the
 * canvas, and read back what it built.
 *
 * The tool speaks degrees and names volumes by index or name; NiiVue
 * takes radians and finds a volume by its name or address, so each
 * instance's volume is checked to be the one NiiVue will find.
 */

import { MAX_INSTANCES } from '../limits'
import {
  entries,
  flag,
  number,
  numbers,
  type Params,
  point,
  pointIfGiven,
  record,
  text,
} from './params'
import { pickIndex } from './pick'
import type {
  GlobalCamera,
  Handlers,
  Instance,
  NiiVueHost,
  ShownVolume,
  View,
} from './view'

const DEG = Math.PI / 180

/** Degrees rounded to a readable number, from NiiVue's radians. */
const degrees = (radians: number): number =>
  Math.round((radians / DEG) * 1e6) / 1e6

/**
 * A global camera from the tool's words: `position` in scene units, `yaw`
 * and `pitch` in degrees (NiiVue's are radians), `fov` in degrees.
 */
export function globalCameraFrom(placed: Params): GlobalCamera {
  const cam: GlobalCamera = { position: point(placed, 'position') }
  const yaw = number(placed, 'yaw')
  const pitch = number(placed, 'pitch')
  if (yaw !== undefined) cam.yaw = yaw * DEG
  if (pitch !== undefined) {
    if (pitch < -90 || pitch > 90)
      throw new Error('pitch must be -90 to 90 degrees.')
    cam.pitch = pitch * DEG
  }
  const fov = number(placed, 'fov')
  if (fov !== undefined) {
    if (fov <= 0 || fov >= 180)
      throw new Error('fov must be above 0 and below 180 degrees.')
    cam.fov = fov
  }
  const near = number(placed, 'near')
  const far = number(placed, 'far')
  if (near !== undefined && near <= 0) throw new Error('near must be above 0.')
  if (near !== undefined) cam.near = near
  if (far !== undefined) cam.far = far
  if ((near ?? 0.1) >= (far ?? 900)) throw new Error('far must be beyond near.')
  return cam
}

/** A global camera as the tool reports it: degrees, as it was given. */
export function reportedCamera(cam: GlobalCamera): Record<string, unknown> {
  return {
    position: [...cam.position],
    ...(cam.yaw === undefined ? {} : { yaw: degrees(cam.yaw) }),
    ...(cam.pitch === undefined ? {} : { pitch: degrees(cam.pitch) }),
    ...(cam.fov === undefined ? {} : { fov: cam.fov }),
    ...(cam.near === undefined ? {} : { near: cam.near }),
    ...(cam.far === undefined ? {} : { far: cam.far }),
  }
}

/** The index of the volume NiiVue draws for `volumeId`: by name, else address, else the base. */
function drawnIndex(volumes: ReadonlyArray<ShownVolume>, id?: string): number {
  if (id === undefined) return 0
  const at = volumes.findIndex((v) => v.name === id || v.url === id)
  return at < 0 ? 0 : at
}

/** The instances NiiVue holds, as the tool reports them: degrees, volumes by index and name. */
export function reportedInstances(view: View): Record<string, unknown>[] {
  return (view.opts?.instances ?? []).map((inst) => {
    const index = drawnIndex(view.volumes, inst.volumeId)
    const global3d = inst.space === 'global3d' || inst.position !== undefined
    const out: Record<string, unknown> = {
      id: inst.id,
      space: global3d ? 'global3d' : 'canvas',
      volume: { index, name: view.volumes[index]?.name ?? null },
    }
    if (global3d) {
      out.position = [...(inst.position ?? [0, 0, 0])]
      out.scale = Array.isArray(inst.scale)
        ? [...inst.scale]
        : (inst.scale ?? 1)
      if (inst.orientation)
        out.orientation = inst.orientation.map((r) => degrees(r))
    } else {
      if (inst.bounds) out.bounds = [...inst.bounds[0], ...inst.bounds[1]]
    }
    return out
  })
}

/** The instances and global camera, for `where_am_i` and a reply; nothing when none are set. */
export function instancesState(view: View): Record<string, unknown> {
  const instances = view.opts?.instances
  if (!instances?.length) return {}
  const cam = view.opts?.globalCamera
  return {
    instances: reportedInstances(view),
    ...(cam ? { globalCamera: reportedCamera(cam) } : {}),
  }
}

/** The handler for the set_instances tool. */
export function instanceHandlers(host: NiiVueHost): Handlers {
  const { view } = host

  /** The name NiiVue will find volume `index` by, refused when it would find another. */
  const volumeIdOf = (index: number): string => {
    const volume = view.volumes[index]
    const id = volume.name || volume.url
    if (!id)
      throw new Error(
        `Volume ${index} has no name for NiiVue to find it by. Load it with one (add_overlay takes one).`,
      )
    const other = drawnIndex(view.volumes, id)
    if (other !== index) {
      throw new Error(
        `NiiVue finds a volume by its name or address, and volume ${index} ("${volume.name}") ` +
          `shares that with volume ${other}, so it would draw volume ${other}. ` +
          'Load each copy with its own name (add_overlay takes one).',
      )
    }
    return id
  }

  /** One instance from the tool's words. */
  const instanceFrom = (entry: Params, i: number): Instance => {
    const id = text(entry, 'id') ?? `instance ${i}`
    const inst: Instance = { id }
    const given = (key: string) =>
      entry?.[key] !== undefined && entry?.[key] !== null
    if (given('volume'))
      inst.volumeId = volumeIdOf(
        pickIndex(view.volumes, entry.volume, 'volume'),
      )
    const bounds = numbers(entry, 'bounds', 4)
    const position = pointIfGiven(entry, 'position')
    const space =
      text(entry, 'space') ??
      (bounds !== undefined && !position ? 'canvas' : 'global3d')
    if (space !== 'global3d' && space !== 'canvas')
      throw new Error(`instance ${id}: space must be global3d or canvas.`)
    if (space === 'global3d') {
      if (bounds)
        throw new Error(
          `instance ${id}: bounds are for a canvas tile; a global3d instance takes position, scale and orientation.`,
        )
      inst.space = 'global3d'
      inst.position = position ?? [0, 0, 0]
      const scale = entry?.scale
      if (given('scale')) {
        const one = Array.isArray(scale) ? undefined : number(entry, 'scale')
        const s = Array.isArray(scale)
          ? numbers(entry, 'scale', 3)
          : one === undefined
            ? undefined
            : [one]
        if (!s || s.some((v) => v <= 0))
          throw new Error(
            `instance ${id}: scale must be above 0, one number or three.`,
          )
        inst.scale = s.length === 3 ? [s[0], s[1], s[2]] : s[0]
      }
      const turn = pointIfGiven(entry, 'orientation')
      if (turn) inst.orientation = [turn[0] * DEG, turn[1] * DEG, turn[2] * DEG]
      return inst
    }
    if (position || given('scale') || given('orientation'))
      throw new Error(
        `instance ${id}: position, scale and orientation are for a global3d instance; a canvas tile takes bounds.`,
      )
    inst.space = 'canvas'
    if (bounds) {
      if (bounds.some((v) => v < 0 || v > 1))
        throw new Error(
          `instance ${id}: bounds must be [x1, y1, x2, y2], each 0 to 1.`,
        )
      if (bounds[0] >= bounds[2] || bounds[1] >= bounds[3])
        throw new Error(
          `instance ${id}: bounds must run from the lower left [x1, y1] to the upper right [x2, y2].`,
        )
      inst.bounds = [
        [bounds[0], bounds[1]],
        [bounds[2], bounds[3]],
      ]
    }
    // NiiVue draws a canvas tile with the scene's own render camera: it
    // reads a tile's rotation and viewport only for a tile on a screen.
    return inst
  }

  return {
    async set_instances(params: Params) {
      if (!view.setInstances)
        throw new Error("This page's NiiVue cannot lay out instances.")
      host.beforeAnswer?.()
      const list = entries(params, 'instances')
      const clear = flag(params, 'clear') ?? false
      const placed = record(params, 'camera')
      if (clear && list)
        throw new Error('set_instances takes instances or clear, not both.')
      if (!clear && !list && !placed)
        throw new Error(
          'set_instances needs instances to lay out, a camera, or clear.',
        )
      if (list && !list.length)
        throw new Error(
          'instances is empty; to go back to the usual layout, ask to clear.',
        )
      if (list && list.length > MAX_INSTANCES)
        throw new Error(`At most ${MAX_INSTANCES} instances at once.`)
      if (!clear && !view.volumes.length)
        throw new Error('No volume is loaded yet.')
      // Everything is read and checked before NiiVue is touched, so a
      // refused call leaves the scene as it was.
      const instances = list?.map(instanceFrom)
      if (instances) {
        const ids = new Set<string>()
        for (const inst of instances) {
          if (ids.has(inst.id))
            throw new Error(`Two instances share the id "${inst.id}".`)
          ids.add(inst.id)
        }
        // NiiVue keeps one texture per address (by name when there is
        // none), so two volumes loaded from one file would draw the same.
        const byKey = new Map<string, number>()
        for (const inst of instances) {
          const index = drawnIndex(view.volumes, inst.volumeId)
          const volume = view.volumes[index]
          const key = volume.url || volume.name
          const other = byKey.get(key)
          if (other !== undefined && other !== index)
            throw new Error(
              `Volumes ${other} ("${view.volumes[other].name}") and ${index} ("${volume.name}") were ` +
                'both loaded from one file, and NiiVue keeps ' +
                'one texture per file in this layout, so both instances would draw the same one. ' +
                'Lay out only one of them; to compare them, clear the instances and show both as overlays.',
            )
          byKey.set(key, index)
        }
      }
      const cam = placed ? globalCameraFrom(placed) : undefined
      if (cam) {
        if (!view.setGlobalCamera)
          throw new Error("This page's NiiVue has no global camera to place.")
        if (clear)
          throw new Error(
            'The global camera only shows global3d instances; clearing them leaves it nothing to show.',
          )
        if (!instances && !view.opts?.instances?.length)
          throw new Error(
            'The global camera only shows global3d instances, and none are set: lay some out first, or in the same call.',
          )
      }
      if (cam) await view.setGlobalCamera?.(cam)
      if (instances) await view.setInstances(instances)
      if (clear) await view.setInstances(null)
      view.drawScene()
      return { instances: [], ...instancesState(view) }
    },
  }
}
