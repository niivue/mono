/**
 * A page without a browser, for the end-to-end test.
 *
 * Connects to a server with the real client over a fake NiiVue: a volume
 * 200 mm across centred on the origin, a four-region atlas, a canvas that
 * hands back a fixed PNG, and one piece of app state (a light that can be
 * on or off) so the reload note has something of the app's to report.
 * Bun's own `WebSocket` carries the socket, so this runs in the test's
 * process; a real page would be one per tab.
 */

import {
  AgentClient,
  type AtlasLike,
  type AtlasRegion,
  coreHandlers,
  type Handlers,
  type ShownVolume,
  sceneState,
  type View,
  type VolumeToLoad,
  type VolumeUpdate,
} from '../browser/index'

export const REGIONS: AtlasRegion[] = [
  {
    label: 'Insula_L',
    name: 'left insula',
    centroid: [-36, 6, 2],
    voxels: 100,
    value: 29,
  },
  {
    label: 'Insula_R',
    name: 'right insula',
    centroid: [38, 6, 2],
    voxels: 100,
    value: 30,
  },
  {
    label: 'Precentral_L',
    name: 'left precentral gyrus',
    centroid: [-40, -6, 50],
    voxels: 300,
    value: 1,
  },
  {
    label: 'Hippocampus_L',
    name: 'left hippocampus',
    centroid: [-24, -20, -14],
    voxels: 200,
    value: 37,
  },
]

const near = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 10

const atlas: AtlasLike = {
  regions: () => REGIONS,
  regionAt: (mm) => REGIONS.find((r) => near(r.centroid, mm))?.name ?? null,
  valueAt: (mm) => {
    const region = REGIONS.find((r) => near(r.centroid, mm))
    return !region || region.label === 'Hippocampus_L' ? 0 : region.value
  },
  nearestIn: (value, mm) => (value === 37 ? [mm[0], mm[1] - 6, mm[2]] : null),
}

/** A 1 by 1 transparent PNG. */
export const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

export interface FakePageOptions {
  /** The server's page socket, `ws://host:port/app`. */
  url: string
  /** The id to say hello with; or leave it to `search`. */
  id?: string
  /** The page's query string, `?tab=<id>`, when the id comes from the address. */
  search?: string
  title: string
}

export interface FakePage {
  client: AgentClient
  /** Closes the socket for good, as closing the tab would. */
  close(): void
}

export function fakePage(options: FakePageOptions): FakePage {
  let plane: [number, number, number] = [2, 0, 0]
  const volumes: ShownVolume[] = []
  const shown = (volume: VolumeToLoad): ShownVolume => ({
    name: volume.name ?? volume.url,
    url: volume.url,
    ...(volume.colormap === undefined ? {} : { colormap: volume.colormap }),
    ...(volume.opacity === undefined ? {} : { opacity: volume.opacity }),
    calMin: 0,
    calMax: 100,
    globalMin: 0,
    globalMax: 255,
  })
  const fetching = async (volume: VolumeToLoad): Promise<void> => {
    if (volume.url.includes('missing')) throw new Error('404 Not Found')
  }
  const view: View = {
    canvas: {
      width: 320,
      height: 240,
      toDataURL: () => `data:image/png;base64,${PNG}`,
    } as unknown as HTMLCanvasElement,
    volumes,
    azimuth: 110,
    elevation: 15,
    crosshairPos: [0.5, 0.5, 0.5],
    getCrosshairPos: () =>
      Array.from(view.crosshairPos).map((f) => (f - 0.5) * 200) as [
        number,
        number,
        number,
      ],
    getClipPlaneDepthAziElev: () => plane,
    setClipPlane: (next) => {
      plane = [next[0], next[1], next[2]]
    },
    loadVolumes: async (next) => {
      for (const volume of next) await fetching(volume)
      volumes.splice(0, volumes.length, ...next.map(shown))
    },
    addVolume: async (volume) => {
      if (!('url' in volume)) {
        volumes.push({ name: volume.name ?? 'transformed' })
        return
      }
      await fetching(volume)
      volumes.push(shown(volume))
    },
    setVolume: async (index: number, update: VolumeUpdate) => {
      Object.assign(volumes[index], update)
    },
    sliceType: 4,
    multiplanarType: 0,
    mosaicString: '',
    showRender: 2,
    isRadiological: false,
    isColorbarVisible: false,
    drawScene: () => {},
    model: {
      mm2scene: (mm) =>
        mm.map((v) => v / 200 + 0.5) as [number, number, number],
      scene2mm: (frac) =>
        frac.map((f) => (f - 0.5) * 200) as [number, number, number],
    },
  }

  let mni = true
  let light = false
  const announced: string[] = []

  const host = {
    view,
    atlas: async () => atlas,
    atlasApplies: () => mni,
    describe: () => {
      const mm = view.getCrosshairPos()
      const region = atlas.regionAt(Array.from(mm))
      const at = Array.from(mm)
        .map((v) => Math.round(v))
        .join(', ')
      return `${region ?? 'no region'} at ${at} mm.`
    },
    announce: (text: string) => announced.push(text),
    loaded: ({ mni: isMni }: { mni: boolean }) => {
      mni = isMni
    },
    extraState: () => ({ light }),
  }

  /** An extension's handlers: what an app adds beside the core tools. */
  const extra: Handlers = {
    set_light: (params) => {
      light = params.on === true
      return { light }
    },
  }

  const client = new AgentClient(
    { ...coreHandlers(host), ...extra },
    {
      urls: [options.url],
      ...(options.id === undefined
        ? { storage: null, search: options.search ?? '' }
        : { id: options.id }),
      title: () => options.title,
      url: () => `http://fake/${options.id ?? options.search ?? ''}`,
      state: () => sceneState(host),
    },
  )
  client.attach()
  return { client, close: () => client.detach() }
}
