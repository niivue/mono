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
  let detail = 0.75
  let level: 'auto' | number = 'auto'
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
  // so a change rebuilds both where the view is. One rebuild runs at a time;
  // changes made meanwhile run one more, with the latest settings, so the
  // canvas never holds two views or settings the menus no longer show.
  const rebuild = async () => {
    const want = { cpu: cacheMiB, gpu: gpuMiB }
    const old = view?.slide
    const slide = await NVSlide.fromManifestUrl(MANIFEST, {
      maxCacheBytes: want.cpu * MiB,
      maxConcurrentLoads: loads,
    })
    // Read the view where it is now, not where it was when the fetch began.
    if (old) slide.setViewport(old.viewport)
    view?.destroy()
    view = null
    // Drag pans, the wheel zooms, a right drag zooms to its box (as the slides demo).
    view = await createSlideView(canvas, {
      maxTileTextureBytes: want.gpu * MiB,
      controller: { secondaryDragMode: DRAG_MODE.roiSelection },
    })
    canvas = view.canvas
    view.setSlide(slide, { fit: !old })
    // After the last await, so a Detail or Level change made during it holds.
    slide.targetScreenPixelsPerTilePixel = detail
    slide.levelChoice = level
    view.addRenderListener(report)
    shown = want
  }
  let running: Promise<void> | null = null
  let again = false
  const build = async () => {
    if (running) {
      again = true
      return running
    }
    running = (async () => {
      do {
        again = false
        await rebuild()
      } while (again)
    })()
    try {
      await running
    } catch (e) {
      // A failed fetch or GPU start: say so, and let the next change retry.
      say(`Rebuild failed: ${e instanceof Error ? e.message : e}`)
    } finally {
      running = null
      again = false
    }
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
      detail = Number(v)
      if (!view?.slide) return
      view.slide.targetScreenPixelsPerTilePixel = detail
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
    (v) => {
      level = v === 'auto' ? 'auto' : Number(v)
      view?.slide?.setLevelChoice(level)
    },
  )
  return view as SlideView
}

export default demo
