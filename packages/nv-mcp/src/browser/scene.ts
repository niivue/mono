/**
 * The core tools, answered from a NiiVue scene.
 *
 * `coreHandlers` turns a host, which is a NiiVue instance and a few hooks
 * the app fills in, into the handlers the client answers requests with.
 * Nothing here imports NiiVue: `View` names the part of its API the core
 * touches, so the app passes its own instance and a test passes a fake.
 * The hooks are where an app adds what NiiVue does not know: its atlas,
 * whether that atlas applies to the loaded volume, how it describes a
 * place to a person, and what it does when the crosshair is moved for it.
 */

import {
  cameraForPlane,
  clipNormal,
  depthThrough,
  namePlane,
  PLANE_NONE,
  PLANE_OFF,
  resolvePlane,
} from '../planes'
import type { PlaneState, RegionSummary, TabState } from '../protocol'
import { ambiguityMessage, findRegion, regionMentions } from '../regions'

/** The part of a NiiVue instance the core drives. NiiVue 1.0 satisfies it as is. */
/** Three numbers by index: a plain array, a typed array, or gl-matrix's vec3. */
export type Triple = { [index: number]: number; readonly length: number }

export interface View {
  canvas: HTMLCanvasElement | null
  volumes: ReadonlyArray<{ name: string }>
  azimuth: number
  elevation: number
  /** The crosshair as fractions of the volume; moved by writing its three slots. gl-matrix's vec3 fits. */
  crosshairPos: Triple
  /** The crosshair in world millimetres. */
  getCrosshairPos(): Triple
  getClipPlaneDepthAziElev(index: number): [number, number, number]
  setClipPlane(plane: number[]): void
  loadVolumes(
    volumes: Array<{
      url: string
      name?: string
      colormap?: string
      opacity?: number
    }>,
  ): Promise<unknown>
  /** Draws a volume as labels from a lookup table, by name (`freesurfer`) or definition. NiiVue 1.0 has it. */
  setColormapLabel?(
    volumeIndex: number,
    cmap: string,
  ): Promise<unknown> | unknown
  /** Schedules a frame. NiiVue 1.0 draws it on the next animation frame, not now. */
  drawScene(): unknown
  /** Fits the canvas's drawing buffer to its box; NiiVue 1.0 has it. */
  resize?(): void
  /** NiiVue 1.0's render backend, whose `render()` draws a frame now. */
  view?: { render(): void } | null
  model: {
    mm2scene(mm: number[]): Triple
    scene2mm(frac: number[]): Triple
  }
}

/** A region as an atlas keeps it: what `list_regions` reports plus its voxel value. */
export interface AtlasRegion extends RegionSummary {
  value: number
}

/** What the core needs of an atlas: four questions over millimetre coordinates. */
export interface AtlasLike {
  regions(): readonly AtlasRegion[]
  regionAt(mm: readonly number[]): string | null
  valueAt(mm: readonly number[]): number
  nearestIn(
    value: number,
    mm: readonly number[],
  ): [number, number, number] | null
}

export interface LoadedVolume {
  url: string
  name: string
  /** Whether the volume is taken to be in MNI space. */
  mni: boolean
}

/** A NiiVue instance and the hooks an app fills in. Every hook is optional. */
export interface NiiVueHost {
  view: View
  /** The atlas, fetched if it has not been. Throws in words when it cannot be. */
  atlas?(): Promise<AtlasLike>
  /** Whether the atlas applies to the loaded volume. Taken as yes when absent. */
  atlasApplies?(): boolean
  /** Called before any answer is read off the scene: a page that sizes its canvas lazily does so here. */
  beforeAnswer?(): void
  /** Called with the new position after the core moves the crosshair. */
  moved?(frac: readonly number[]): void
  /** The place in words, as the app would say it to a person. May look something up first. */
  describe?(): string | Promise<string>
  /** Tells the person something changed that they did not do. */
  announce?(text: string): void
  /** Called after `load_volume` has loaded one. */
  loaded?(volume: LoadedVolume): void
  /** State of the app's own the server should watch between calls. */
  extraState?(): Record<string, unknown>
  /** The name of the plane cut now, when the app has its own names. */
  planeName?(): string
}

export type Handler = (params: Record<string, unknown>) => unknown
export type Handlers = Record<string, Handler>

/** The default width a screenshot is scaled down to. */
export const SCREENSHOT_WIDTH = 1024

/** Where the scene stands, for a hello or an answer's envelope. */
export function sceneState(host: NiiVueHost): TabState {
  const { view } = host
  const volume = view.volumes[0]?.name ?? null
  return {
    volume,
    crosshair: volume ? { mm: Array.from(view.getCrosshairPos()) } : null,
    plane: volume ? planeState(host) : null,
    ...(host.extraState?.() ?? {}),
  }
}

function planeState(host: NiiVueHost): PlaneState {
  const [depth, azimuth, elevation] = host.view.getClipPlaneDepthAziElev(0)
  const name = host.planeName?.() ?? namePlane(depth, azimuth, elevation)
  return { name, depth, azimuth, elevation }
}

function camera(view: View): { azimuth: number; elevation: number } {
  return { azimuth: view.azimuth, elevation: view.elevation }
}

/** Turns the camera to look straight at the face a plane at these angles exposes. */
function facePlane(view: View, azimuth: number, elevation: number): void {
  const at = cameraForPlane(azimuth, elevation)
  view.azimuth = at.azimuth
  view.elevation = at.elevation
}

function text(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = params?.[key]
  if (value === undefined || value === null) return undefined
  const trimmed = String(value).trim()
  return trimmed ? trimmed : undefined
}

function number(
  params: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = params?.[key]
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number.`)
  return n
}

function flag(
  params: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = params?.[key]
  if (value === undefined || value === null) return undefined
  return value === true || value === 'true'
}

/** Whether a volume's name says it is in MNI space, when nobody said. */
export function looksMni(name: string): boolean {
  return /mni/i.test(name)
}

/** The file name at the end of a URL, without its query. */
export function nameFromUrl(url: string): string {
  const path = url.split(/[?#]/)[0]
  return path.slice(path.lastIndexOf('/') + 1) || url
}

const summary = ({
  label,
  name,
  centroid,
  voxels,
}: RegionSummary): RegionSummary => ({ label, name, centroid, voxels })

/** A volume as the page shows it: the base first, then any overlays in order. */
interface Shown {
  url: string
  name: string
  colormap: string
  opacity?: number
  /** A label lookup table by name, for a label map. */
  labels?: string
}

/** Label lookup tables the core knows by name; NiiVue 1.0 has each built in. */
export const LABEL_TABLES = ['freesurfer'] as const

/** Three finite numbers, or a message saying what is wrong. */
function point(
  params: Record<string, unknown>,
  key: string,
): [number, number, number] {
  const value = params?.[key]
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((v) => !Number.isFinite(Number(v)))
  ) {
    throw new Error(`${key} must be three numbers, [x, y, z] in millimetres.`)
  }
  return [Number(value[0]), Number(value[1]), Number(value[2])]
}

/** The handlers for the core tools, over this host. */
export function coreHandlers(host: NiiVueHost): Handlers {
  const { view } = host

  const requireVolume = () => {
    if (!view.volumes[0])
      throw new Error('No volume is loaded yet. Call load_volume first.')
  }

  const requireAtlas = async (): Promise<AtlasLike> => {
    if (!host.atlas) throw new Error('This page has no atlas.')
    return host.atlas()
  }

  // What is on show, so an overlay can be added without losing the base.
  let shown: Shown[] = []

  const loadShown = async (): Promise<void> => {
    await view.loadVolumes(
      shown.map(({ url, name, colormap, opacity }) => ({
        url,
        name,
        colormap,
        ...(opacity === undefined ? {} : { opacity }),
      })),
    )
    for (const [index, volume] of shown.entries()) {
      if (volume.labels) await view.setColormapLabel?.(index, volume.labels)
    }
  }

  /** Moves the crosshair to `frac`, cuts `plane` through it facing the camera at the cut, and draws. */
  const moveTo = (
    frac: [number, number, number],
    plane: { azimuth: number; elevation: number },
  ): number => {
    const normal = clipNormal(plane.azimuth, plane.elevation)
    const depth = depthThrough(normal, frac)
    // Face the cut first, so the exposed face with the target on it is
    // the near side rather than hidden behind the part the cut keeps.
    facePlane(view, plane.azimuth, plane.elevation)
    view.setClipPlane([depth, plane.azimuth, plane.elevation])
    const position = view.crosshairPos
    position[0] = frac[0]
    position[1] = frac[1]
    position[2] = frac[2]
    view.drawScene()
    host.moved?.(frac)
    return depth
  }

  const describe = async (): Promise<string> => {
    if (host.describe) return await host.describe()
    const mm = Array.from(view.getCrosshairPos()).map((v) => Math.round(v))
    return `Crosshair at ${mm.join(', ')} mm.`
  }

  return {
    async load_volume(params) {
      const url = text(params, 'url')
      if (!url) throw new Error('load_volume needs a url.')
      const name = text(params, 'name') ?? nameFromUrl(url)
      const colormap = text(params, 'colormap') ?? 'gray'
      const mni = flag(params, 'mni') ?? looksMni(name)
      try {
        await view.loadVolumes([{ url, name, colormap }])
        shown = [{ url, name, colormap }]
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error)
        throw new Error(`The volume at ${url} could not be loaded: ${why}`)
      }
      host.loaded?.({ url, name, mni })
      host.beforeAnswer?.()
      view.drawScene()
      const min = Array.from(view.model.scene2mm([0, 0, 0]))
      const max = Array.from(view.model.scene2mm([1, 1, 1]))
      return {
        name: view.volumes[0]?.name ?? name,
        mni,
        bounds: { mm: { min, max } },
        crosshair: { mm: Array.from(view.getCrosshairPos()) },
      }
    },

    async where_am_i() {
      host.beforeAnswer?.()
      const volume = view.volumes[0]?.name ?? null
      if (!volume) {
        return {
          volume: null,
          description: 'No volume is loaded yet.',
          ...(host.extraState?.() ?? {}),
        }
      }
      const frac = Array.from(view.crosshairPos)
      const mm = Array.from(view.getCrosshairPos())
      return {
        volume,
        crosshair: { mm, frac },
        plane: planeState(host),
        camera: camera(view),
        description: await describe(),
        ...(host.extraState?.() ?? {}),
      }
    },

    async list_regions(params) {
      const loaded = await requireAtlas()
      const wanted = text(params, 'query')
      const regions = wanted
        ? loaded.regions().filter((r) => regionMentions(r, wanted))
        : loaded.regions()
      return regions.map(summary)
    },

    async go_to_region(params) {
      const query = text(params, 'region')
      if (!query) throw new Error('go_to_region needs a region name.')
      requireVolume()
      host.beforeAnswer?.()
      const loaded = await requireAtlas()
      if (host.atlasApplies && !host.atlasApplies()) {
        throw new Error(
          'The loaded volume is not in MNI space, so the atlas does not apply to it. Load one that is.',
        )
      }
      const planeName = text(params, 'plane')
      const plane = resolvePlane(planeName, view.getClipPlaneDepthAziElev(0))
      if (!plane) throw new Error(`Unknown plane "${planeName}".`)
      const { region, candidates } = findRegion(loaded.regions(), query)
      if (!region) {
        if (candidates.length)
          throw new Error(ambiguityMessage(query, candidates))
        throw new Error(
          `No region matches "${query}". Call list_regions to see the names.`,
        )
      }

      // A curved region's mean can lie outside it; land inside rather than
      // on the neighbour that happens to be there.
      let target = region.centroid
      let snapped = false
      if (loaded.valueAt(target) !== region.value) {
        const inside = loaded.nearestIn(region.value, target)
        if (inside) {
          target = inside
          snapped = true
        }
      }

      const at = view.model.mm2scene([target[0], target[1], target[2]])
      const frac: [number, number, number] = [at[0], at[1], at[2]]
      if (frac.some((f) => f < 0 || f > 1)) {
        throw new Error(`${region.name} lies outside the loaded volume.`)
      }

      const depth = moveTo(frac, plane)

      const description = await describe()
      host.announce?.(description)
      return {
        region: summary(region),
        landed: { mm: target, frac },
        snapped,
        plane: {
          name: plane.name,
          depth,
          azimuth: plane.azimuth,
          elevation: plane.elevation,
        },
        camera: camera(view),
        description,
        ...(host.extraState?.() ?? {}),
      }
    },

    async add_overlay(params) {
      requireVolume()
      if (!shown.length)
        throw new Error(
          'Load the base volume with load_volume before adding an overlay.',
        )
      const url = text(params, 'url')
      if (!url) throw new Error('add_overlay needs a url.')
      const name = text(params, 'name') ?? nameFromUrl(url)
      const labels = text(params, 'labels')
      if (labels && !(LABEL_TABLES as readonly string[]).includes(labels)) {
        throw new Error(
          `Unknown label table "${labels}". One of: ${LABEL_TABLES.join(', ')}.`,
        )
      }
      if (labels && !view.setColormapLabel)
        throw new Error("This page's NiiVue cannot draw label maps.")
      const opacity = Math.min(
        1,
        Math.max(0, number(params, 'opacity') ?? (labels ? 0.5 : 0.7)),
      )
      const colormap = text(params, 'colormap') ?? (labels ? 'gray' : 'warm')
      const before = shown
      shown = [
        ...shown,
        { url, name, colormap, opacity, ...(labels ? { labels } : {}) },
      ]
      try {
        await loadShown()
      } catch (error) {
        shown = before
        const why = error instanceof Error ? error.message : String(error)
        throw new Error(`The overlay at ${url} could not be loaded: ${why}`)
      }
      host.beforeAnswer?.()
      view.drawScene()
      return {
        volumes: shown.map(
          ({ name: n, colormap: c, opacity: o, labels: l }, index) => ({
            index,
            name: n,
            colormap: c,
            ...(o === undefined ? {} : { opacity: o }),
            ...(l ? { labels: l } : {}),
          }),
        ),
        crosshair: { mm: Array.from(view.getCrosshairPos()) },
      }
    },

    async go_to_point(params) {
      requireVolume()
      host.beforeAnswer?.()
      const mm = point(params, 'mm')
      const planeName = text(params, 'plane')
      const plane = resolvePlane(planeName, view.getClipPlaneDepthAziElev(0))
      if (!plane) throw new Error(`Unknown plane "${planeName}".`)
      const at = view.model.mm2scene([mm[0], mm[1], mm[2]])
      const frac: [number, number, number] = [at[0], at[1], at[2]]
      if (frac.some((f) => !Number.isFinite(f) || f < 0 || f > 1)) {
        throw new Error(`[${mm.join(', ')}] mm lies outside the loaded volume.`)
      }
      const depth = moveTo(frac, plane)
      const label = text(params, 'label')
      const place = await describe()
      const description = label ? `${label}. ${place}` : place
      host.announce?.(description)
      return {
        landed: { mm, frac },
        plane: {
          name: plane.name,
          depth,
          azimuth: plane.azimuth,
          elevation: plane.elevation,
        },
        camera: camera(view),
        description,
        ...(host.extraState?.() ?? {}),
      }
    },

    set_clip_plane(params) {
      requireVolume()
      host.beforeAnswer?.()
      const name = (text(params, 'plane') ?? '').toLowerCase()
      if (!name) throw new Error('set_clip_plane needs a plane name, or off.')
      if (name === 'off') {
        view.setClipPlane([PLANE_NONE, 0, 0])
        view.drawScene()
        host.announce?.('Cut plane: off.')
        return { plane: planeState(host), camera: camera(view) }
      }
      const plane = resolvePlane(name, null)
      if (!plane || name === 'current')
        throw new Error(`Unknown plane "${name}".`)
      const depth = Math.min(1.5, Math.max(-1.5, number(params, 'depth') ?? 0))
      if (flag(params, 'face') ?? true)
        facePlane(view, plane.azimuth, plane.elevation)
      view.setClipPlane([depth, plane.azimuth, plane.elevation])
      view.drawScene()
      host.announce?.(`Cut plane: ${plane.name}.`)
      return {
        plane: {
          name: plane.name,
          depth,
          azimuth: plane.azimuth,
          elevation: plane.elevation,
        },
        camera: camera(view),
      }
    },

    set_camera(params) {
      requireVolume()
      host.beforeAnswer?.()
      const azimuth = number(params, 'azimuth')
      const elevation = number(params, 'elevation')
      if (azimuth === undefined || elevation === undefined)
        throw new Error('set_camera needs an azimuth and an elevation.')
      view.azimuth = ((azimuth % 360) + 360) % 360
      view.elevation = Math.min(90, Math.max(-90, elevation))
      view.drawScene()
      return { camera: camera(view), plane: planeState(host) }
    },

    screenshot(params) {
      host.beforeAnswer?.()
      const canvas = view.canvas
      if (!canvas) throw new Error('NiiVue has no canvas to draw.')
      if (tabHidden()) {
        throw new Error(
          'The tab is in the background, so the browser is not drawing it. Bring it to the front and try again.',
        )
      }
      const maxWidth = Math.max(
        1,
        Math.floor(number(params, 'max_width') ?? SCREENSHOT_WIDTH),
      )
      drawNow(view, canvas)
      const picture =
        canvas.width > maxWidth ? scaledCopy(canvas, maxWidth) : canvas
      const dataUrl = picture.toDataURL('image/png')
      const comma = dataUrl.indexOf(',')
      return {
        data: dataUrl.slice(comma + 1),
        mimeType: dataUrl.slice(5, dataUrl.indexOf(';')) || 'image/png',
        width: picture.width,
        height: picture.height,
        canvas: { width: canvas.width, height: canvas.height },
      }
    },
  }
}

/** Whether the browser has stopped drawing the page: a tab behind another gets no frames. */
function tabHidden(): boolean {
  return (
    typeof document !== 'undefined' && document.visibilityState === 'hidden'
  )
}

/** The canvas drawn onto a smaller one, `maxWidth` wide, keeping its shape. */
function scaledCopy(
  canvas: HTMLCanvasElement,
  maxWidth: number,
): HTMLCanvasElement {
  const copy = document.createElement('canvas')
  const scale = maxWidth / canvas.width
  copy.width = maxWidth
  copy.height = Math.max(1, Math.round(canvas.height * scale))
  const context = copy.getContext('2d')
  if (!context)
    throw new Error('The page cannot scale the picture: no 2d context.')
  context.drawImage(canvas, 0, 0, copy.width, copy.height)
  return copy
}

/** Whether a plane by NiiVue's numbers is cut at all. */
export function planeIsCut(plane: readonly [number, number, number]): boolean {
  return plane[0] < PLANE_OFF
}

/**
 * Draws a frame now, so the read-back that follows in the same task sees
 * it. NiiVue 1.0's `drawScene` only schedules one, and a WebGL drawing
 * buffer does not survive to the next task unless it was asked to; its
 * render backend draws on demand. A canvas whose drawing buffer does not
 * fit its box yet, as one NiiVue has not sized, is sized first.
 */
function drawNow(view: View, canvas: HTMLCanvasElement): void {
  const box = canvas.getBoundingClientRect?.()
  if (box && box.width > 0 && view.resize) {
    const scale = globalThis.devicePixelRatio || 1
    const wanted = Math.max(1, Math.floor(box.width * scale))
    if (canvas.width !== wanted) view.resize()
  }
  view.drawScene()
  view.view?.render()
}
