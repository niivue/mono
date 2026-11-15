import {
  createSlideView,
  DRAG_MODE,
  NVSlide,
  type NVSlideViewport,
} from '@niivue/niivue'
import type { Demo } from './types'

// A CPTAC breast H&E (53783 x 49534 px) served with HTTP Range and CORS.
const MANIFEST =
  'https://niivue.github.io/niivue-demo-images/wsi/cptac-brca/manifest.json'
const MiB = 1024 * 1024

const demo: Demo = async (canvas, { ui }) => {
  let cacheMiB = 96
  let loads = 12
  const open = (viewport?: NVSlideViewport) =>
    NVSlide.fromManifestUrl(MANIFEST, {
      maxCacheBytes: cacheMiB * MiB,
      maxConcurrentLoads: loads,
      ...(viewport ? { viewport } : {}),
    })
  let slide = await open()
  // The limit of the slide on screen, which lags the menu until a reopen lands.
  let shownMiB = cacheMiB
  // Drag pans, the wheel zooms, a right drag zooms to its box (as the slides demo).
  const view = await createSlideView(canvas, {
    slide,
    controller: { secondaryDragMode: DRAG_MODE.roiSelection },
  })

  // The cache size and load cap are construction options: reopen the slide
  // where the view is, keeping the settings that can change live.
  // Only the latest reopen installs its slide, so a slower earlier one cannot
  // leave settings running that the menus no longer show.
  let token = 0
  const reopen = async () => {
    const mine = ++token
    const next = await open(slide.viewport)
    if (mine !== token) {
      next.dispose()
      return
    }
    next.targetScreenPixelsPerTilePixel = slide.targetScreenPixelsPerTilePixel
    next.levelChoice = slide.levelChoice
    slide = next
    shownMiB = cacheMiB
    view.setSlide(slide, { fit: false })
  }
  ui.select(
    'CPU cache',
    ['12', '24', '48', '96', '192'].map((m) => [`${m} MiB`, m]),
    '96',
    (v) => {
      cacheMiB = Number(v)
      void reopen()
    },
  )
  ui.select('Parallel loads', ['2', '6', '12'], '12', (v) => {
    loads = Number(v)
    void reopen()
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
      slide.targetScreenPixelsPerTilePixel = Number(v)
      view.requestRender()
    },
  )
  ui.select(
    'Level',
    [
      'auto',
      ...slide.manifest.levels.map((l): [string, string] => [
        `L${l.index}`,
        String(l.index),
      ]),
    ],
    'auto',
    (v) => slide.setLevelChoice(v === 'auto' ? 'auto' : Number(v)),
  )

  const say = ui.status()
  view.addRenderListener(() => {
    const shown = slide.lastVisibleTiles
    if (!shown?.level) return
    const asked = shown.requestedLevel
      ? ` (L${shown.requestedLevel.index} asked; limited by ${shown.limitedBy})`
      : ''
    const capped = shown.capped ? ', centre only: zoom in' : ''
    say(
      `Drawing L${shown.level.index}${asked}${capped}. ` +
        `CPU cache ${Math.round(slide.cacheBytes / MiB)} of ${shownMiB} MiB, ` +
        `${slide.pendingCount} tiles loading.`,
    )
  })
  return view
}

export default demo
