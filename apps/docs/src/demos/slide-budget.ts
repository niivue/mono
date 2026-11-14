import {
  createSlideView,
  DRAG_MODE,
  NVSlide,
  type SlideView,
} from '@niivue/niivue'
import type { Demo } from './types'

// A CPTAC breast H&E (53783 x 49534 px) served with HTTP Range and CORS.
const MANIFEST =
  'https://niivue.github.io/niivue-demo-images/wsi/cptac-brca/manifest.json'
const MiB = 1024 * 1024

const demo: Demo = async (canvas, { ui }) => {
  let cacheMiB = 96
  let gpuMiB = 128
  let loads = 12
  let view = null as SlideView | null
  // The limits of the slide on screen, which lag the menus until a build lands.
  let shown = { cpu: cacheMiB, gpu: gpuMiB }
  const say = ui.status()

  const report = () => {
    const slide = view?.slide
    const tiles = slide?.lastVisibleTiles
    if (!slide || !tiles?.level) return
    const asked = tiles.requestedLevel
      ? ` (L${tiles.requestedLevel.index} asked; limited by ${tiles.limitedBy})`
      : ''
    const capped = tiles.capped ? ', centre only: zoom in' : ''
    say(
      `Drawing L${tiles.level.index}${asked}${capped}. ` +
        `CPU cache ${Math.round(slide.cacheBytes / MiB)} of ${shown.cpu} MiB, ` +
        `GPU tiles ${shown.gpu} MiB, ${slide.pendingCount} tiles loading.`,
    )
  }

  // The caches and the load cap are set when the slide and its view are made,
  // so a change rebuilds both where the view is, keeping detail and level.
  // Only the latest build installs, so a slower earlier one cannot leave
  // settings running that the menus no longer show.
  let token = 0
  const build = async () => {
    const mine = ++token
    const old = view?.slide
    const keep = old && {
      viewport: { ...old.viewport },
      detail: old.targetScreenPixelsPerTilePixel,
      level: old.levelChoice,
    }
    const want = { cpu: cacheMiB, gpu: gpuMiB }
    const slide = await NVSlide.fromManifestUrl(MANIFEST, {
      maxCacheBytes: want.cpu * MiB,
      maxConcurrentLoads: loads,
      ...(keep ? { viewport: keep.viewport } : {}),
    })
    if (mine !== token) return slide.dispose()
    if (keep) {
      slide.targetScreenPixelsPerTilePixel = keep.detail
      slide.levelChoice = keep.level
    }
    view?.destroy()
    // Drag pans, the wheel zooms, a right drag zooms to its box (as the slides demo).
    view = await createSlideView(canvas, {
      maxTileTextureBytes: want.gpu * MiB,
      controller: { secondaryDragMode: DRAG_MODE.roiSelection },
    })
    view.setSlide(slide, { fit: !keep })
    view.addRenderListener(report)
    shown = want
  }
  await build()

  ui.select(
    'CPU cache',
    ['12', '24', '48', '96', '192'].map((m) => [`${m} MiB`, m]),
    '96',
    (v) => {
      cacheMiB = Number(v)
      void build()
    },
  )
  ui.select(
    'GPU cache',
    ['16', '32', '64', '128', '256'].map((m) => [`${m} MiB`, m]),
    '128',
    (v) => {
      gpuMiB = Number(v)
      void build()
    },
  )
  ui.select('Parallel loads', ['2', '6', '12'], '12', (v) => {
    loads = Number(v)
    void build()
  })
  ui.select(
    'Detail',
    [
      ['fine (0.25)', '0.25'],
      ['0.5', '0.5'],
      ['default (0.75)', '0.75'],
      ['1', '1'],
      ['coarse (1.5)', '1.5'],
    ],
    '0.75',
    (v) => {
      if (!view?.slide) return
      view.slide.targetScreenPixelsPerTilePixel = Number(v)
      view.requestRender()
    },
  )
  const levels = view?.slide?.manifest.levels ?? []
  ui.select(
    'Level',
    [
      'auto',
      ...levels.map((l): [string, string] => [`L${l.index}`, String(l.index)]),
    ],
    'auto',
    (v) => view?.slide?.setLevelChoice(v === 'auto' ? 'auto' : Number(v)),
  )
  return view as SlideView
}

export default demo
