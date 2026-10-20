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

import { namePlane, planeDepthCuts } from '../planes'
import type { PlaneState, TabState } from '../protocol'
import {
  LAYOUTS,
  nameFor,
  SHOW_RENDER,
  SLICE_TYPES,
  type ViewState,
} from '../views'
import { flag, nameFromUrl, text } from './params'
import type { Handlers, NiiVueHost, View } from './view'

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

/** Whether a volume's name says it is in MNI space, when nobody said. */
export function looksMni(name: string): boolean {
  return /mni/i.test(name)
}

/** Three finite numbers, or a message saying what is wrong. */
/** The handlers for the core tools, over this host. */
export function coreHandlers(host: NiiVueHost): Handlers {
  const { view } = host

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
  }
}

/** Whether a plane by NiiVue's numbers is cut at all. */
export function planeIsCut(plane: readonly [number, number, number]): boolean {
  return planeDepthCuts(plane[0])
}
