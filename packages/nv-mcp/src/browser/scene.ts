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
import {
  LAYOUTS,
  nameFor,
  SHOW_RENDER,
  SLICE_TYPES,
  type ViewState,
} from '../views'
import {
  clamp,
  flag,
  integer,
  nameFromUrl,
  number,
  numbers,
  point,
  pointIfGiven,
  put,
  record,
  text,
} from './params'
import type {
  AtlasLike,
  GlobalCamera,
  Handlers,
  NiiVueHost,
  View,
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
        crosshair: { mm, frac },
        plane: planeState(host),
        camera: camera(view),
        ...(hasLayout(view) ? { view: viewState(view) } : {}),
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
