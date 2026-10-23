// Captures a thumbnail of every gallery example into static/img/gallery.
//
//   bunx nx screenshots docs-site                  # all examples
//   bunx nx screenshots docs-site -- vox-clip      # only these slugs
//
// Pages load from DOCS_EXAMPLES_BASE (default: the published examples site),
// so point it at a local `bun run dev` in packages/niivue to capture
// unpublished examples. Each thumbnail is the page's largest canvas, scaled
// down in the browser and saved as WebP.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { buildGraph, collectGallery } from '../plugins/gallery'

const WIDTH = 480
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 2500)
const LOAD_TIMEOUT_MS = 30000
// Examples that draw nothing until the user acts; show their whole page.
const PAGE_SHOT = new Set(['allen-atlas', 'benchmark', 'font'])
// Examples that stream for a while before their first useful frame.
const SLOW: Record<string, number> = {
  'vox-block-pick': 8000,
  'vox-block-pick-zarr': 15000,
}

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(siteDir, '../..')
const outDir = path.join(siteDir, 'static/img/gallery')
const base = process.env.DOCS_EXAMPLES_BASE ?? 'https://niivue.github.io/mono/'

const only = new Set(process.argv.slice(2))
const examples = collectGallery(repoRoot, buildGraph(repoRoot)).filter(
  (e) => only.size === 0 || only.has(e.slug),
)

async function capture(
  page: Page,
  url: string,
  whole: boolean,
  settleMs: number,
): Promise<Buffer> {
  await page.goto(url, { waitUntil: 'load', timeout: LOAD_TIMEOUT_MS })
  // Streaming examples never go idle; take what has drawn by the timeout.
  await page
    .waitForLoadState('networkidle', { timeout: LOAD_TIMEOUT_MS })
    .catch(() => {})
  await page.waitForTimeout(settleMs)
  if (whole) return page.screenshot()
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
      PAGE_SHOT.has(example.slug),
      SLOW[example.slug] ?? SETTLE_MS,
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
