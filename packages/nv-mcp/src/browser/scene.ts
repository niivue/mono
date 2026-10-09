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
  planeDepthCuts,
  resolvePlane,
} from '../planes'
import type { PlaneState, RegionSummary, TabState } from '../protocol'
import { ambiguityMessage, findRegion, regionMentions } from '../regions'
import { COLORMAP_TYPES } from '../settings'
import {
  LAYOUTS,
  nameFor,
  SHOW_RENDER,
  SLICE_TYPES,
  type ViewState,
} from '../views'
import { meshHandlers } from './meshes'
import {
  clamp,
  flag,
  integer,
  nameFromUrl,
  nothingIn,
  number,
  numbers,
  point,
  pointIfGiven,
  put,
  record,
  text,
} from './params'
import { pickIndex } from './pick'
import { settingHandlers } from './settings'
import type {
  AffineTransform,
  AtlasLike,
  GlobalCamera,
  Handlers,
  LabelTable,
  NiiVueHost,
  ShownVolume,
  View,
  VolumeUpdate,
} from './view'

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

/** Whether the page's NiiVue exposes its view layout. */
function hasLayout(view: View): boolean {
  return view.sliceType !== undefined
}

/** The view layout by name. */
export function viewState(view: View): ViewState {
  return {
    slice: nameFor(SLICE_TYPES, view.sliceType),
    layout: nameFor(LAYOUTS, view.multiplanarType),
    ...(view.mosaicString ? { mosaic: view.mosaicString } : {}),
    showRender: nameFor(SHOW_RENDER, view.showRender),
    radiological: view.isRadiological ?? false,
    colorbar: view.isColorbarVisible ?? false,
  }
}

/** Turns the camera to look straight at the face a plane at these angles exposes. */
function facePlane(view: View, azimuth: number, elevation: number): void {
  const at = cameraForPlane(azimuth, elevation)
  view.azimuth = at.azimuth
  view.elevation = at.elevation
}

/** Whether a volume's name says it is in MNI space, when nobody said. */
export function looksMni(name: string): boolean {
  return /mni/i.test(name)
}

const summary = ({
  label,
  name,
  centroid,
  voxels,
}: RegionSummary): RegionSummary => ({ label, name, centroid, voxels })

/** Label lookup tables the core knows by name; NiiVue 1.0 has each built in. */
export const LABEL_TABLES = ['freesurfer'] as const

/** Whether `labels` is an address to fetch a table from, rather than a name the core knows. */
function isAddress(labels: string): boolean {
  return labels.includes('/')
}

/**
 * Fetches a label table from an address the page can reach, and fills in
 * what NiiVue's own reader would: `I` counting from 0, and `A` opaque with
 * label 0 clear. Refuses in words when the address cannot be fetched or
 * what it holds is not a table.
 */
export async function fetchLabelTable(address: string): Promise<LabelTable> {
  let body: unknown
  try {
    const response = await fetch(address)
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`.trim())
    }
    body = await response.json()
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    throw new Error(
      `The label table at ${address} could not be fetched: ${why}`,
    )
  }
  const numbers = (value: unknown): value is number[] =>
    Array.isArray(value) && value.every((v) => typeof v === 'number')
  const strings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((v) => typeof v === 'string')
  const table =
    body && typeof body === 'object'
      ? (body as Partial<Record<keyof LabelTable, unknown>>)
      : {}
  const { R, G, B, A, I, labels } = table
  const unreadable = () =>
    new Error(
      `The label table at ${address} is not one NiiVue can read: it needs R, G and B arrays of one length, with I, A and labels optional.`,
    )
  if (!numbers(R) || R.length === 0) throw unreadable()
  const fits = (value: unknown): value is number[] =>
    numbers(value) && value.length === R.length
  if (
    !fits(G) ||
    !fits(B) ||
    (A !== undefined && !fits(A)) ||
    (I !== undefined && !fits(I)) ||
    (labels !== undefined && !strings(labels))
  ) {
    throw unreadable()
  }
  const indices = I ?? R.map((_, i) => i)
  return {
    R,
    G,
    B,
    A: A ?? indices.map((i) => (i === 0 ? 0 : 255)),
    I: indices,
    ...(labels ? { labels } : {}),
  }
}

/** Three finite numbers, or a message saying what is wrong. */
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

  // The label table each label-map overlay was drawn with, by the volume
  // NiiVue keeps; a new base clears the volumes, and the map with them.
  const labelled = new WeakMap<ShownVolume, string>()

  /** A volume as the tools report it: how it is drawn, its window and span, and its frame when it has several. */
  const describeVolume = (volume: ShownVolume, index: number) => {
    const labels = labelled.get(volume)
    const windowed = volume.calMin !== undefined && volume.calMax !== undefined
    const spanned =
      volume.globalMin !== undefined && volume.globalMax !== undefined
    const frames = volume.nFrame4D ?? 1
    return {
      index,
      name: volume.name,
      ...(volume.colormap === undefined ? {} : { colormap: volume.colormap }),
      ...(volume.opacity === undefined ? {} : { opacity: volume.opacity }),
      ...(labels ? { labels } : {}),
      ...(windowed ? { calMin: volume.calMin, calMax: volume.calMax } : {}),
      ...(spanned
        ? { globalMin: volume.globalMin, globalMax: volume.globalMax }
        : {}),
      ...(frames > 1 ? { frame: volume.frame4D ?? 0, frames } : {}),
      ...(volume.nTotalFrame4D !== undefined && volume.nTotalFrame4D > frames
        ? { framesInFile: volume.nTotalFrame4D }
        : {}),
      ...(volume.isColormapInverted ? { inverted: true } : {}),
      ...(volume.colormapNegative
        ? { colormapNegative: volume.colormapNegative }
        : {}),
      ...(volume.calMinNeg !== undefined && volume.calMaxNeg !== undefined
        ? { calMinNeg: volume.calMinNeg, calMaxNeg: volume.calMaxNeg }
        : {}),
      ...(volume.colormapType
        ? { colormapType: nameFor(COLORMAP_TYPES, volume.colormapType) }
        : {}),
      ...(volume.isTransparentBelowCalMin
        ? { transparentBelowCalMin: true }
        : {}),
      ...(volume.isColorbarVisible ? { colorbar: true } : {}),
      ...(volume.isNearestInterpolation ? { nearest: true } : {}),
      ...(volume.atlasOutline ? { atlasOutline: volume.atlasOutline } : {}),
      ...(volume.modulateAlpha ? { modulateAlpha: volume.modulateAlpha } : {}),
    }
  }

  /** A label table by name or fetched from an address, checked before anything changes. */
  const knownLabelTable = (labels: string): void => {
    if (isAddress(labels)) return
    if (!(LABEL_TABLES as readonly string[]).includes(labels)) {
      throw new Error(
        `Unknown label table "${labels}". One of: ${LABEL_TABLES.join(', ')}, or the address of a label table JSON the page can fetch.`,
      )
    }
  }
  const labelTable = async (labels: string): Promise<string | LabelTable> => {
    knownLabelTable(labels)
    return isAddress(labels) ? fetchLabelTable(labels) : labels
  }

  /** The volumes on show, as `add_overlay` and `where_am_i` report them. */
  const volumesShown = () => view.volumes.map(describeVolume)

  /** The index of the volume `params.volume` names, by index or by name; the base without it. */
  const volumeIndex = (params: Record<string, unknown>): number =>
    pickIndex(view.volumes, params?.volume, 'volume', 0)

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
    view.crosshairPos = new Float32Array(frac)
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
    ...settingHandlers(host),
    ...meshHandlers(host),

    async load_volume(params) {
      const url = text(params, 'url')
      if (!url) throw new Error('load_volume needs a url.')
      const name = text(params, 'name') ?? nameFromUrl(url)
      const colormap = text(params, 'colormap') ?? 'gray'
      const mni = flag(params, 'mni') ?? looksMni(name)
      try {
        await view.loadVolumes([{ url, name, colormap }])
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
        volumes: volumesShown(),
        crosshair: { mm, frac },
        plane: planeState(host),
        camera: camera(view),
        ...(hasLayout(view) ? { view: viewState(view) } : {}),
        ...counts(view),
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
      const url = text(params, 'url')
      if (!url) throw new Error('add_overlay needs a url.')
      const name = text(params, 'name') ?? nameFromUrl(url)
      const labels = text(params, 'labels')
      if (labels) knownLabelTable(labels)
      if (labels && !view.setColormapLabel)
        throw new Error("This page's NiiVue cannot draw label maps.")
      // A table from an address is fetched before anything is added, so a
      // bad address leaves the scene as it was.
      const table = labels ? await labelTable(labels) : undefined
      const opacity = clamp(
        number(params, 'opacity') ?? (labels ? 0.5 : 0.7),
        0,
        1,
      )
      const colormap = text(params, 'colormap') ?? (labels ? 'gray' : 'warm')
      // NiiVue keeps the crosshair as a fraction of the scene, and a volume
      // with a different box changes the scene, so the same fraction would
      // land somewhere else. It is read in millimetres first and put back.
      const before = Array.from(view.getCrosshairPos())
      // Added over what is shown, whoever loaded it: the page's own start-up
      // volume as much as one from load_volume. A failed add leaves the
      // scene as it was.
      try {
        await view.addVolume({ url, name, colormap, opacity })
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error)
        throw new Error(`The overlay at ${url} could not be loaded: ${why}`)
      }
      const index = view.volumes.length - 1
      const added = view.volumes[index]
      if (labels && table && added) {
        await view.setColormapLabel?.(index, table)
        labelled.set(added, labels)
      }
      view.crosshairPos = new Float32Array(
        view.model.mm2scene([before[0], before[1], before[2]]),
      )
      host.beforeAnswer?.()
      view.drawScene()
      return {
        volumes: volumesShown(),
        crosshair: { mm: Array.from(view.getCrosshairPos()) },
      }
    },

    async go_to_point(params) {
      requireVolume()
      host.beforeAnswer?.()
      const planeName = text(params, 'plane')
      const plane = resolvePlane(planeName, view.getClipPlaneDepthAziElev(0))
      if (!plane) throw new Error(`Unknown plane "${planeName}".`)
      const vox = pointIfGiven(params, 'vox')
      let mm = pointIfGiven(params, 'mm')
      let frac: [number, number, number]
      if (vox) {
        if (!view.vox2frac)
          throw new Error("This page's NiiVue cannot place a voxel.")
        if (vox.some((v) => !Number.isInteger(v)))
          throw new Error('vox must be three whole numbers, [i, j, k].')
        frac = view.vox2frac(vox)
        const at = view.model.scene2mm(frac)
        mm = [at[0], at[1], at[2]]
      } else {
        if (!mm) throw new Error('go_to_point needs mm or vox.')
        const at = view.model.mm2scene([mm[0], mm[1], mm[2]])
        frac = [at[0], at[1], at[2]]
      }
      if (frac.some((f) => !Number.isFinite(f) || f < 0 || f > 1)) {
        throw new Error(
          `${vox ? `Voxel [${vox.join(', ')}]` : `[${mm.join(', ')}] mm`} lies outside the loaded volume.`,
        )
      }
      const depth = moveTo(frac, plane)
      const label = text(params, 'label')
      const place = await describe()
      const description = label ? `${label}. ${place}` : place
      host.announce?.(description)
      return {
        landed: { mm, frac, ...(vox ? { vox } : {}) },
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

    nudge_crosshair(params) {
      requireVolume()
      host.beforeAnswer?.()
      if (!view.moveCrosshairInVox)
        throw new Error(
          "This page's NiiVue cannot step the crosshair by voxels.",
        )
      const by = numbers(params, 'vox', 3)
      if (!by || by.some((v) => !Number.isInteger(v)))
        throw new Error(
          'nudge_crosshair needs vox: three whole numbers, [di, dj, dk].',
        )
      view.moveCrosshairInVox(by[0], by[1], by[2])
      view.drawScene()
      const frac = Array.from(view.crosshairPos)
      host.moved?.(frac)
      return {
        crosshair: { mm: Array.from(view.getCrosshairPos()), frac },
      }
    },

    set_clip_plane(params) {
      requireVolume()
      host.beforeAnswer?.()
      const planes = params?.planes
      if (planes !== undefined && planes !== null) {
        if (!view.setClipPlanes)
          throw new Error("This page's NiiVue cannot set several clip planes.")
        if (
          !Array.isArray(planes) ||
          !planes.length ||
          planes.length > CLIP_PLANES ||
          planes.some(
            (p) =>
              !Array.isArray(p) ||
              p.length !== 3 ||
              p.some((v) => !Number.isFinite(Number(v))),
          )
        ) {
          throw new Error(
            `planes must be one to ${CLIP_PLANES} triples, [depth, azimuth, elevation] each.`,
          )
        }
        const set = planes.map((p: unknown[]) => p.map(Number))
        view.setClipPlanes(set)
        view.drawScene()
        return {
          planes: set.map(([depth, azimuth, elevation]) => ({
            name: namePlane(depth, azimuth, elevation),
            depth,
            azimuth,
            elevation,
          })),
          camera: camera(view),
        }
      }
      const index = integer(params, 'index') ?? 0
      if (index >= CLIP_PLANES)
        throw new Error(`index must be 0 to ${CLIP_PLANES - 1}.`)
      const setAt = (plane: [number, number, number]) => {
        if (index === 0) {
          view.setClipPlane(plane)
          return
        }
        if (!view.setClipPlaneDepthAziElev)
          throw new Error("This page's NiiVue has one clip plane only.")
        view.setClipPlaneDepthAziElev(plane[0], plane[1], plane[2], index)
      }
      const reported = (plane: [number, number, number], name?: string) => ({
        ...(index ? { index } : {}),
        plane: {
          name: name ?? namePlane(plane[0], plane[1], plane[2]),
          depth: plane[0],
          azimuth: plane[1],
          elevation: plane[2],
        },
        camera: camera(view),
      })
      const name = (text(params, 'plane') ?? '').toLowerCase()
      const azimuth = number(params, 'azimuth')
      const elevation = number(params, 'elevation')
      if (name === 'off') {
        setAt([PLANE_NONE, 0, 0])
        view.drawScene()
        host.announce?.('Cut plane: off.')
        return reported([PLANE_NONE, 0, 0])
      }
      let plane: { name: string; azimuth: number; elevation: number }
      if (azimuth !== undefined || elevation !== undefined) {
        if (azimuth === undefined || elevation === undefined)
          throw new Error('A plane by angle needs both azimuth and elevation.')
        plane = { name: '', azimuth, elevation }
      } else {
        if (!name)
          throw new Error(
            'set_clip_plane needs a plane name, an azimuth and elevation, or off.',
          )
        const named = resolvePlane(name, null)
        if (!named || name === 'current')
          throw new Error(`Unknown plane "${name}".`)
        plane = named
      }
      const depth = clamp(number(params, 'depth') ?? 0, -1.5, 1.5)
      if (!plane.name)
        plane.name = namePlane(depth, plane.azimuth, plane.elevation)
      if (flag(params, 'face') ?? true)
        facePlane(view, plane.azimuth, plane.elevation)
      setAt([depth, plane.azimuth, plane.elevation])
      view.drawScene()
      host.announce?.(`Cut plane: ${plane.name}.`)
      return reported([depth, plane.azimuth, plane.elevation], plane.name)
    },

    set_camera(params) {
      requireVolume()
      host.beforeAnswer?.()
      let changed = false
      const azimuth = number(params, 'azimuth')
      const elevation = number(params, 'elevation')
      if (azimuth !== undefined) {
        view.azimuth = ((azimuth % 360) + 360) % 360
        changed = true
      }
      if (elevation !== undefined) {
        view.elevation = clamp(elevation, -90, 90)
        changed = true
      }
      const pan = numbers(params, 'pan_2d', 4)
      if (pan) {
        if (view.pan2Dxyzmm === undefined)
          throw new Error("This page's NiiVue cannot pan its slices.")
        view.pan2Dxyzmm = new Float32Array(pan)
        changed = true
      }
      const renderPan = numbers(params, 'render_pan', 2)
      if (renderPan) {
        if (view.renderPan === undefined)
          throw new Error("This page's NiiVue cannot pan its render.")
        view.renderPan = new Float32Array(renderPan)
        changed = true
      }
      const pivot = params?.pivot
      if (pivot !== undefined) {
        if (view.renderPivotMM === undefined)
          throw new Error("This page's NiiVue cannot pivot its render.")
        view.renderPivotMM =
          pivot === null ? null : new Float32Array(point(params, 'pivot'))
        changed = true
      }
      const centre = pointIfGiven(params, 'center_on')
      if (centre) {
        if (!view.centerRenderOnMM)
          throw new Error(
            "This page's NiiVue cannot centre its render on a point.",
          )
        if (!view.centerRenderOnMM(centre))
          throw new Error(
            `The render could not be centred on [${centre.join(', ')}] mm.`,
          )
        changed = true
      }
      const placed = record(params, 'global')
      if (placed) {
        if (!view.setGlobalCamera)
          throw new Error("This page's NiiVue has no global camera to place.")
        const position = point(placed, 'position')
        const cam: GlobalCamera = { position }
        put(cam, 'yaw', number(placed, 'yaw'))
        put(cam, 'pitch', number(placed, 'pitch'))
        put(cam, 'fov', number(placed, 'fov'))
        put(cam, 'near', number(placed, 'near'))
        put(cam, 'far', number(placed, 'far'))
        view.setGlobalCamera(cam)
        changed = true
      }
      if (!changed) {
        throw new Error(
          'set_camera needs something to set: azimuth, elevation, pan_2d, render_pan, pivot, center_on or global.',
        )
      }
      view.drawScene()
      return {
        camera: camera(view),
        plane: planeState(host),
        ...(view.pan2Dxyzmm ? { pan2D: Array.from(view.pan2Dxyzmm) } : {}),
        ...(view.renderPan ? { renderPan: Array.from(view.renderPan) } : {}),
        ...(view.renderPivotMM
          ? { pivot: Array.from(view.renderPivotMM) }
          : {}),
      }
    },

    async set_volume(params) {
      requireVolume()
      host.beforeAnswer?.()
      const index = volumeIndex(params)
      const volume = view.volumes[index]
      // Only what was asked for goes to NiiVue: it assigns the update
      // onto the volume as it is, so an undefined field would wipe one.
      const update: VolumeUpdate = {}
      put(update, 'colormap', text(params, 'colormap'))
      put(update, 'colormapNegative', text(params, 'colormap_negative'))
      const opacity = number(params, 'opacity')
      if (opacity !== undefined) update.opacity = clamp(opacity, 0, 1)
      const calMin = number(params, 'cal_min')
      const calMax = number(params, 'cal_max')
      put(update, 'calMin', calMin)
      put(update, 'calMax', calMax)
      const low = calMin ?? volume.calMin
      const high = calMax ?? volume.calMax
      if (low !== undefined && high !== undefined && low > high) {
        throw new Error(
          `cal_min (${low}) must not be above cal_max (${high}); the window would be empty.`,
        )
      }
      put(update, 'calMinNeg', number(params, 'cal_min_neg'))
      put(update, 'calMaxNeg', number(params, 'cal_max_neg'))
      const type = text(params, 'colormap_type')?.toLowerCase()
      if (type !== undefined) {
        if (!Object.hasOwn(COLORMAP_TYPES, type)) {
          throw new Error(
            `Unknown colormap_type "${type}". One of: ${Object.keys(COLORMAP_TYPES).join(', ')}.`,
          )
        }
        update.colormapType =
          COLORMAP_TYPES[type as keyof typeof COLORMAP_TYPES]
      }
      put(
        update,
        'isTransparentBelowCalMin',
        flag(params, 'transparent_below_cal_min'),
      )
      const frame = number(params, 'frame')
      if (frame !== undefined) {
        if (!Number.isInteger(frame) || frame < 0)
          throw new Error('frame must be a whole number, counted from 0.')
        const frames = volume.nFrame4D ?? 1
        if (frame >= frames) {
          throw new Error(
            frames > 1
              ? `${volume.name} has ${frames} frames, numbered 0 to ${frames - 1}.`
              : `${volume.name} has one frame only.`,
          )
        }
        update.frame4D = frame
      }
      put(update, 'isColormapInverted', flag(params, 'invert'))
      put(update, 'isColorbarVisible', flag(params, 'colorbar'))
      put(update, 'isNearestInterpolation', flag(params, 'nearest'))
      const outline = number(params, 'atlas_outline')
      if (outline !== undefined) update.atlasOutline = clamp(outline, 0, 1)
      const modulateAlpha = number(params, 'modulate_alpha')
      if (modulateAlpha !== undefined)
        update.modulateAlpha = clamp(modulateAlpha, 0, 1)

      // What is not a field of the volume: each its own NiiVue call.
      const labels = text(params, 'labels')
      const modulate = params?.modulate
      const autoWindow = flag(params, 'auto_window')
      const allFrames = flag(params, 'load_all_frames')
      const affine = params?.affine
      const resetAffine = flag(params, 'reset_affine')
      const transform = record(params, 'transform')
      const extras = [
        labels,
        modulate,
        autoWindow,
        allFrames,
        affine,
        resetAffine,
        transform,
      ].some((v) => v !== undefined && v !== null)
      if (nothingIn(update) && !extras) {
        throw new Error(
          'set_volume needs something to set: colormap, opacity, cal_min, cal_max, frame, invert, or one of the others its schema lists.',
        )
      }
      if (!nothingIn(update)) {
        if (!view.setVolume)
          throw new Error(
            "This page's NiiVue cannot change a volume once loaded.",
          )
        await view.setVolume(index, update)
      }
      if (labels !== undefined) {
        if (!view.setColormapLabel)
          throw new Error("This page's NiiVue cannot draw label maps.")
        const table = await labelTable(labels)
        await view.setColormapLabel(index, table)
        labelled.set(volume, labels)
      }
      if (modulate !== undefined && modulate !== null) {
        if (!view.setModulationImage)
          throw new Error("This page's NiiVue cannot modulate a volume.")
        const by = record(params, 'modulate') ?? {}
        const other = pickIndex(view.volumes, by.volume, 'volume')
        const target = volume.id
        const modulator = view.volumes[other].id
        if (target === undefined || modulator === undefined)
          throw new Error("This page's NiiVue does not give its volumes ids.")
        const alpha = clamp(number(by, 'alpha') ?? 0, 0, 1)
        await view.setModulationImage(target, modulator, alpha)
      }
      if (allFrames) {
        if (!view.loadDeferred4DVolumes)
          throw new Error(
            "This page's NiiVue cannot load a volume's remaining frames.",
          )
        if (volume.id === undefined)
          throw new Error("This page's NiiVue does not give its volumes ids.")
        await view.loadDeferred4DVolumes(volume.id)
      }
      if (autoWindow) {
        if (!view.recalculateCalMinMax)
          throw new Error(
            "This page's NiiVue cannot recompute a volume's window.",
          )
        await view.recalculateCalMinMax(index, update.frame4D)
      }
      if (resetAffine) {
        if (!view.resetVolumeAffine)
          throw new Error("This page's NiiVue cannot move a volume.")
        await view.resetVolumeAffine(index)
      }
      if (affine !== undefined && affine !== null) {
        if (!view.setVolumeAffine)
          throw new Error("This page's NiiVue cannot move a volume.")
        await view.setVolumeAffine(index, matrix4(affine, 'affine'))
      }
      if (transform) {
        if (!view.applyVolumeTransform)
          throw new Error("This page's NiiVue cannot move a volume.")
        const moved: AffineTransform = {
          translation: pointIfGiven(transform, 'translation') ?? [0, 0, 0],
          rotation: pointIfGiven(transform, 'rotation') ?? [0, 0, 0],
          scale: pointIfGiven(transform, 'scale') ?? [1, 1, 1],
        }
        await view.applyVolumeTransform(index, moved)
      }
      view.drawScene()
      return { volume: describeVolume(volume, index) }
    },

    async transform_volume(params) {
      requireVolume()
      host.beforeAnswer?.()
      const index = volumeIndex(params)
      const volume = view.volumes[index]
      const name = text(params, 'name')
      const known = view.volumeTransforms ?? []
      if (!view.volumeTransform || !known.length)
        throw new Error("This page's NiiVue has no volume transforms.")
      if (!name || !Object.hasOwn(view.volumeTransform, name)) {
        throw new Error(
          `${name ? `Unknown transform "${name}"` : 'transform_volume needs a name'}. One of: ${known.join(', ')}.`,
        )
      }
      const replace = flag(params, 'replace') ?? false
      if (replace && !view.removeVolume)
        throw new Error("This page's NiiVue cannot remove a volume.")
      const options = record(params, 'options')
      const made = await view.volumeTransform[name](volume, options)
      // The source goes only once its replacement is in, so a failed add
      // leaves the stack as it was.
      await view.addVolume(made)
      if (replace) await view.removeVolume?.(index)
      view.drawScene()
      const added = view.volumes.length - 1
      return {
        transform: name,
        ...(options ? { options } : {}),
        volume: describeVolume(view.volumes[added], added),
        volumes: volumesShown(),
      }
    },

    async remove_volume(params) {
      requireVolume()
      host.beforeAnswer?.()
      if (flag(params, 'all')) {
        if (!view.removeAllVolumes)
          throw new Error("This page's NiiVue cannot remove its volumes.")
        await view.removeAllVolumes()
        view.drawScene()
        return { volumes: [] }
      }
      if (!view.removeVolume)
        throw new Error("This page's NiiVue cannot remove a volume.")
      const index = pickIndex(view.volumes, params?.volume, 'volume')
      const removed = view.volumes[index].name
      await view.removeVolume(index)
      view.drawScene()
      return { removed, volumes: volumesShown() }
    },

    async reorder_volume(params) {
      requireVolume()
      host.beforeAnswer?.()
      const index = pickIndex(view.volumes, params?.volume, 'volume')
      const move = text(params, 'move')?.toLowerCase()
      const moves: Record<
        string,
        ((index: number) => Promise<unknown>) | undefined
      > = {
        up: view.moveVolumeUp?.bind(view),
        down: view.moveVolumeDown?.bind(view),
        top: view.moveVolumeToTop?.bind(view),
        bottom: view.moveVolumeToBottom?.bind(view),
      }
      if (!move || !Object.hasOwn(moves, move))
        throw new Error('reorder_volume needs move: up, down, top or bottom.')
      const go = moves[move]
      if (!go) throw new Error("This page's NiiVue cannot reorder its volumes.")
      const name = view.volumes[index].name
      await go(index)
      view.drawScene()
      return {
        moved: name,
        index: view.volumes.findIndex((v) => v.name === name),
        volumes: volumesShown(),
      }
    },

    describe_volume(params) {
      requireVolume()
      host.beforeAnswer?.()
      const index = volumeIndex(params)
      const volume = view.volumes[index]
      const out: Record<string, unknown> = {
        volume: describeVolume(volume, index),
      }
      if (volume.dims) {
        const dims = Array.from(volume.dims)
        out.dims = dims.slice(1, 1 + Math.max(3, Math.min(dims[0] ?? 3, 4)))
      }
      if (volume.id !== undefined) out.id = volume.id
      if (flag(params, 'stats') ?? true) {
        if (!view.getDescriptives)
          throw new Error("This page's NiiVue cannot compute voxel statistics.")
        const masks = numbers(params, 'mask_labels')
        const mask = params?.mask
        const options: Parameters<NonNullable<View['getDescriptives']>>[0] = {
          volumeIndex: index,
        }
        if (mask !== undefined && mask !== null) {
          options.masks = [pickIndex(view.volumes, mask, 'volume')]
          if (masks) options.drawPenValues = masks
        } else if (flag(params, 'drawing')) {
          options.isDrawingMask = true
          if (masks) options.drawPenValues = masks
        }
        const stats = view.getDescriptives(options)
        if (stats) out.stats = stats
      }
      if (flag(params, 'affine')) {
        if (!view.getVolumeAffine)
          throw new Error("This page's NiiVue cannot report a volume's affine.")
        out.affine = view.getVolumeAffine(index)
      }
      return out
    },

    set_view(params) {
      host.beforeAnswer?.()
      if (!hasLayout(view))
        throw new Error("This page's NiiVue has no view layout to set.")
      let changed = false
      const slice = text(params, 'slice')?.toLowerCase()
      if (slice !== undefined) {
        const type = Object.hasOwn(SLICE_TYPES, slice)
          ? SLICE_TYPES[slice as keyof typeof SLICE_TYPES]
          : undefined
        if (type === undefined) {
          throw new Error(
            `Unknown slice "${slice}". One of: ${Object.keys(SLICE_TYPES).join(', ')}.`,
          )
        }
        view.sliceType = type
        changed = true
      }
      const layout = text(params, 'layout')?.toLowerCase()
      if (layout !== undefined) {
        const type = Object.hasOwn(LAYOUTS, layout)
          ? LAYOUTS[layout as keyof typeof LAYOUTS]
          : undefined
        if (type === undefined) {
          throw new Error(
            `Unknown layout "${layout}". One of: ${Object.keys(LAYOUTS).join(', ')}.`,
          )
        }
        view.multiplanarType = type
        changed = true
      }
      const showRender = text(params, 'show_render')?.toLowerCase()
      if (showRender !== undefined) {
        const when = Object.hasOwn(SHOW_RENDER, showRender)
          ? SHOW_RENDER[showRender as keyof typeof SHOW_RENDER]
          : undefined
        if (when === undefined) {
          throw new Error(
            `Unknown show_render "${showRender}". One of: ${Object.keys(SHOW_RENDER).join(', ')}.`,
          )
        }
        view.showRender = when
        changed = true
      }
      // An empty mosaic clears the one drawn, so this one is read raw.
      const mosaic = params?.mosaic
      if (mosaic !== undefined && mosaic !== null) {
        view.mosaicString = String(mosaic).trim()
        changed = true
      }
      const radiological = flag(params, 'radiological')
      if (radiological !== undefined) {
        view.isRadiological = radiological
        changed = true
      }
      const colorbar = flag(params, 'colorbar')
      if (colorbar !== undefined) {
        view.isColorbarVisible = colorbar
        changed = true
      }
      if (!changed) {
        throw new Error(
          'set_view needs something to set: slice, layout, mosaic, show_render, radiological or colorbar.',
        )
      }
      view.drawScene()
      return { view: viewState(view) }
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

/** How many clip planes NiiVue keeps. */
export const CLIP_PLANES = 6

/** How many of each other thing is on show, for `where_am_i`; only what the page's NiiVue keeps. */
function counts(view: View): Record<string, number> {
  const out: Record<string, number> = {}
  if (view.meshes) out.meshes = view.meshes.length
  return out
}

/** A 4 by 4 matrix, as four rows of four numbers or sixteen numbers row by row. */
export function matrix4(value: unknown, key: string): number[][] {
  const bad = () =>
    new Error(`${key} must be a 4 by 4 matrix: four rows of four numbers.`)
  if (!Array.isArray(value)) throw bad()
  const rows =
    value.length === 16 && value.every((v) => !Array.isArray(v))
      ? [0, 4, 8, 12].map((i) => value.slice(i, i + 4))
      : value
  if (
    rows.length !== 4 ||
    rows.some(
      (row) =>
        !Array.isArray(row) ||
        row.length !== 4 ||
        row.some((v) => !Number.isFinite(Number(v))),
    )
  )
    throw bad()
  return rows.map((row: unknown[]) => row.map(Number))
}

/** Whether a plane by NiiVue's numbers is cut at all. */
export function planeIsCut(plane: readonly [number, number, number]): boolean {
  return planeDepthCuts(plane[0])
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
