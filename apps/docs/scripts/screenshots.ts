// Captures a thumbnail of every gallery example into public/img/gallery.
//
//   bunx nx screenshots docs-site                  # all examples
//   bunx nx screenshots docs-site -- vox-clip      # only these slugs
//
// Pages load from DOCS_EXAMPLES_BASE (default: the published examples site),
// so point it at a local `bun run dev` in packages/niivue to capture
// unpublished examples. Give the server root
// (DOCS_EXAMPLES_BASE=http://localhost:5273/), not /examples/: page paths
// already start with examples/, and a doubled one captures a blank 404.
// Each thumbnail is the page's largest canvas, scaled down in the browser
// and saved as WebP.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { buildGraph, collectGallery } from '../src/lib/gallery'

const WIDTH = 480
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 2500)
const LOAD_TIMEOUT_MS = 30000
type Clip = { x: number; y: number; width: number; height: number }
async function canvasBox(page: Page): Promise<Clip> {
  const box = await page.locator('canvas').first().boundingBox()
  if (!box) throw new Error('no canvas')
  return box
}

// Examples that draw nothing until the user acts; act for them, then wait.
// A step may return the page region to frame when the drawing is small.
const PREPARE: Record<string, (page: Page) => Promise<Clip | undefined>> = {
  font: async (page) => {
    await page.waitForSelector('#fontSelect option:nth-child(2)', {
      state: 'attached',
    })
    await page.selectOption('#fontSelect', 'GaramondBold')
    await page.locator('#fontSlide').fill('20')
    return { x: 260, y: 0, width: 480, height: 360 }
  },
  // The extension demos all open on the same MNI152 view; show each tool's result.
  'demo-ext-image-processing-imgproc': async (page) => {
    await page.selectOption('#transformSelect', 'otsu')
    await page.click('#applyBtn') // the options dialog, left at its defaults
    return undefined
  },
  'demo-ext-niimath': async (page) => {
    await page.click('.tab-btn[data-tab="tools"]')
    await page.selectOption('#operatorSelect', '-s') // Gaussian smoothing, 3 mm
    await page.click('#addOperatorBtn')
    await page.click('#runBtn:not([disabled])')
    return undefined
  },
  'demo-ext-save-html': async (page) => {
    await page.selectOption('#sliceType', '2') // a single sagittal slice
    return undefined
  },
  'demo-ext-drawing-magic-wand': async (page) => {
    await page.selectOption('#sliceType', '0') // one axial slice
    await page.waitForTimeout(500)
    const r = await canvasBox(page)
    // The default tolerance floods the whole brain; a tight one stays in
    // the white matter around the seed (left frontal).
    await page.locator('#toleranceSlider').fill('12')
    await page.mouse.click(r.x + r.width * 0.45, r.y + r.height * 0.3)
    return undefined
  },
  'demo-ext-drawing-drawing': async (page) => {
    await page.selectOption('#sliceType', '0')
    await page.click('#enableDrawBtn')
    await page.check('#penFilled')
    await page.waitForTimeout(500)
    const r = await canvasBox(page)
    const loop = async (cx: number, cy: number, rad: number) => {
      const pt = (a: number) => [
        r.x + r.width * (cx + rad * Math.cos(a)),
        r.y + r.height * (cy + rad * Math.sin(a)),
      ]
      const [x0, y0] = pt(0)
      await page.mouse.move(x0, y0)
      await page.mouse.down()
      for (let i = 1; i <= 24; i++) {
        const [x, y] = pt((i / 24) * 2 * Math.PI)
        await page.mouse.move(x, y)
      }
      await page.mouse.up()
    }
    // Two outlines eight slices apart; Interpolate fills the slices between.
    await loop(0.42, 0.4, 0.06)
    for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -100)
    await loop(0.46, 0.45, 0.09)
    await page.click('#interpolateBtn')
    await page.selectOption('#sliceType', '3') // A+C+S+R shows the filled run
    return undefined
  },
  'demo-ext-dcm2niix': async (page) => {
    await page.click('#loadManifestBtn')
    return undefined
  },
  'demo-nv-web-component': async (page) => {
    await page.click('#loadViewerBtn')
    await page.click('#loadSceneBtn')
    // Its canvases are in shadow roots, so the whole page is captured.
    await page.evaluate(() => window.scrollTo(0, 0))
    return undefined
  },
  // Just the slide: no stats panels, range log or tile grid.
  slides: async (page) => {
    await page.click('#hudToggle')
    await page.uncheck('#showGrid')
    return undefined
  },
  // A short renderer-only run; it ends on the opaque brain mesh.
  benchmark: async (page) => {
    await page.fill('#frameCount', '30')
    await page.uncheck('#runCompute')
    await page.click('#runBtn')
    await page.waitForFunction(() => '__benchDone' in window, null, {
      timeout: 180000,
    })
    // The canvas is a wide strip; frame a 4:3 area around its centre to fit the card.
    const r = await canvasBox(page)
    const width = Math.min(r.width, (r.height * 4) / 3)
    return { x: r.x + (r.width - width) / 2, y: r.y, width, height: r.height }
  },
}

// Examples that stream for a while before their first useful frame.
const SLOW: Record<string, number> = {
  'demo-ext-niimath': 10000,
  // Path-traced: give the progressive render time to converge.
  'cinematic-mr-siam': 10000,
  'cinematic-mr-mni152-tract': 10000,
  // Fetches a DICOM series and converts it in WASM.
  'demo-ext-dcm2niix': 15000,
  // The DICOM-WSI slide streams its tiles from the network.
  slides: 8000,
  'vox-block-pick': 8000,
}

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(siteDir, '../..')
const outDir = path.join(siteDir, 'public/img/gallery')
const base = process.env.DOCS_EXAMPLES_BASE ?? 'https://niivue.github.io/mono/'

const only = new Set(process.argv.slice(2))
const examples = collectGallery(repoRoot, buildGraph(repoRoot)).filter(
  (e) => only.size === 0 || only.has(e.slug),
)

async function capture(
  page: Page,
  url: string,
  settleMs: number,
  prepare?: (page: Page) => Promise<Clip | undefined>,
): Promise<Buffer> {
  await page.goto(url, { waitUntil: 'load', timeout: LOAD_TIMEOUT_MS })
  // Streaming examples never go idle; take what has drawn by the timeout.
  await page
    .waitForLoadState('networkidle', { timeout: LOAD_TIMEOUT_MS })
    .catch(() => {})
  const clip = await prepare?.(page)
  await page.waitForTimeout(settleMs)
  if (clip) return page.screenshot({ clip })
  const canvas = await page.evaluateHandle(() => {
    let best: HTMLCanvasElement | null = null
    let area = 0
    for (const c of Array.from(document.querySelectorAll('canvas'))) {
      const r = c.getBoundingClientRect()
      if (r.width * r.height > area) {
        area = r.width * r.height
        best = c
      }
    }
    return area > 200 * 150 ? best : null
  })
  const el = canvas.asElement()
  return el ? el.screenshot() : page.screenshot()
}

// Scale the PNG down and encode it as WebP with the browser's own encoder.
async function toWebp(page: Page, png: Buffer): Promise<Buffer> {
  const dataUrl = await page.evaluate(
    async ({ b64, width }) => {
      const img = new Image()
      img.src = `data:image/png;base64,${b64}`
      await img.decode()
      const c = document.createElement('canvas')
      c.width = Math.min(width, img.width)
      c.height = Math.round((img.height * c.width) / img.width)
      c.getContext('2d')?.drawImage(img, 0, 0, c.width, c.height)
      return c.toDataURL('image/webp', 0.8)
    },
    { b64: png.toString('base64'), width: WIDTH },
  )
  return Buffer.from(dataUrl.split(',')[1], 'base64')
}

mkdirSync(outDir, { recursive: true })
const browser = await chromium.launch({
  args: [
    '--ignore-gpu-blocklist',
    '--enable-unsafe-webgpu',
    '--use-angle=metal',
    '--enable-gpu',
  ],
})
const context = await browser.newContext({
  viewport: { width: 1000, height: 750 },
  deviceScaleFactor: 1,
})
const encoder = await context.newPage()
const failed: string[] = []
for (const example of examples) {
  const page = await context.newPage()
  try {
    const png = await capture(
      page,
      new URL(example.page, base).href,
      SLOW[example.slug] ?? SETTLE_MS,
      PREPARE[example.slug],
    )
    const webp = await toWebp(encoder, png)
    writeFileSync(path.join(outDir, `${example.slug}.webp`), webp)
    console.log(`${example.slug} ${(webp.length / 1024).toFixed(0)} KB`)
  } catch (err) {
    failed.push(example.slug)
    console.error(`${example.slug} failed: ${(err as Error).message}`)
  } finally {
    await page.close()
  }
}
await browser.close()
if (failed.length) {
  console.error(`Failed: ${failed.join(' ')}`)
  process.exit(1)
}
