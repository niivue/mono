// Capture PR-ready screenshots of every live demo page.
//
// Spawns the IIIF Volumetric Server and the Vite demo dev server,
// waits for both to be reachable, then drives a headless Chromium
// through each page and writes PNGs under `screenshots/`.
//
// Run from the repo root:
//
//   bunx nx run iiif-volumetric-demo:capture-screenshots
//
// Or directly: `bun apps/iiif-volumetric-demo/scripts/capture-screenshots.ts`.
//
// Requires fixtures to be present in `apps/iiif-volumetric-server/fixtures/`
// (run `bunx nx run iiif-volumetric-server:fetch-fixtures` first if not).

import { type ChildProcess, spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import url from 'node:url'
import { chromium, type Page } from 'playwright'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const DEMO_DIR = path.resolve(__dirname, '..')
const SERVER_DIR = path.resolve(DEMO_DIR, '../iiif-volumetric-server')
const OUT_DIR = path.resolve(DEMO_DIR, 'docs/screenshots')

const IIIF_ORIGIN = 'http://127.0.0.1:8080'
const DEMO_ORIGIN = 'http://127.0.0.1:8087'

// 1600×1000 at DPR 2 produces ~3200×2000 PNGs — large enough for a PR
// reviewer to zoom in on the multiplanar tiles without aliasing.
const VIEWPORT = { width: 1600, height: 1000 }
const DEVICE_SCALE_FACTOR = 2
// After page load the dev demos kick off async volume/mesh loads; give
// the WebGL2 scene a couple of seconds to reach a steady-state frame
// before snapping. Slow enough to be reliable, fast enough that the
// whole capture run finishes under a minute.
const STEADY_STATE_MS = 3500

type ServerHandle = { name: string; child: ChildProcess }

function startServer(
  name: string,
  cwd: string,
  cmd: string,
  args: string[],
): ServerHandle {
  const child = spawn(cmd, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0' },
  })
  child.stdout?.on('data', (b: Buffer) => {
    process.stdout.write(`[${name}] ${b.toString()}`)
  })
  child.stderr?.on('data', (b: Buffer) => {
    process.stderr.write(`[${name}] ${b.toString()}`)
  })
  child.on('exit', (code) => {
    if (code !== null && code !== 0) {
      process.stderr.write(`[${name}] exited with ${code}\n`)
    }
  })
  return { name, child }
}

async function waitForUrl(
  target: string,
  label: string,
  timeoutMs = 60_000,
): Promise<void> {
  const start = Date.now()
  let attempts = 0
  while (Date.now() - start < timeoutMs) {
    attempts++
    try {
      const res = await fetch(target)
      if (res.ok || res.status === 404) {
        // 404 is fine — we only need the server to be answering at all
        // (the demo's root doesn't always serve a 200 mid-dev).
        console.log(`[${label}] up after ${attempts} attempts`)
        return
      }
    } catch {
      // server not listening yet
    }
    await sleep(500)
  }
  throw new Error(`${label} did not come up at ${target} within ${timeoutMs}ms`)
}

async function dismissIntroPanels(page: Page): Promise<void> {
  // Every demo page ships with a `<details class="intro" open>` callout.
  // Collapse it so it doesn't obscure the canvas in the screenshot.
  await page.evaluate(() => {
    for (const d of document.querySelectorAll<HTMLDetailsElement>(
      'details.intro',
    )) {
      d.open = false
    }
  })
}

async function captureSheet(page: Page): Promise<void> {
  await page.goto(`${DEMO_ORIGIN}/sheet.html`, { waitUntil: 'networkidle' })
  await page.waitForSelector('#nv-canvas')
  await dismissIntroPanels(page)
  await sleep(STEADY_STATE_MS)
  await page.screenshot({
    path: path.join(OUT_DIR, 'sheet.jpg'),
    fullPage: false,
    type: 'jpeg',
    quality: 85,
  })
  console.log('  -> sheet.jpg')

  // Two zoom-in clicks lands at ~2.25x — between LOD_START (1.6) and
  // LOD_END (3.2), so the gutters widen and label strips fade in while
  // multiple cells are still visible. Going further zooms past a single
  // cell and the LOD-vs-multi-cell tradeoff disappears.
  for (let i = 0; i < 2; i++) {
    await page.click('#zoomIn')
    await sleep(400)
  }
  await sleep(STEADY_STATE_MS)
  await page.screenshot({
    path: path.join(OUT_DIR, 'sheet-zoomed.jpg'),
    fullPage: false,
    type: 'jpeg',
    quality: 85,
  })
  console.log('  -> sheet-zoomed.jpg')
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true })

  console.log('starting IIIF server + demo dev server…')
  const servers: ServerHandle[] = [
    startServer('iiif', SERVER_DIR, 'bun', ['src/server.ts']),
    startServer('demo', DEMO_DIR, 'bunx', [
      '--bun',
      'vite',
      '--port',
      '8087',
      '--strictPort',
    ]),
  ]

  let browserClosed = false
  const teardown = (): void => {
    if (browserClosed) return
    browserClosed = true
    for (const s of servers) {
      try {
        s.child.kill('SIGTERM')
      } catch (err) {
        console.warn(`failed to stop ${s.name}:`, err)
      }
    }
  }
  process.on('SIGINT', () => {
    teardown()
    process.exit(130)
  })

  try {
    await waitForUrl(`${IIIF_ORIGIN}/api`, 'iiif')
    await waitForUrl(`${DEMO_ORIGIN}/index.html`, 'demo')

    const browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
    })
    const page = await context.newPage()
    page.on('pageerror', (err) => console.warn(`[page] ${err.message}`))
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.warn(`[console] ${msg.text()}`)
    })

    console.log('capturing index.html…')
    await page.goto(`${DEMO_ORIGIN}/index.html`, { waitUntil: 'networkidle' })
    await page.waitForSelector('canvas')
    await dismissIntroPanels(page)
    await sleep(STEADY_STATE_MS)
    await page.screenshot({
      path: path.join(OUT_DIR, 'index.jpg'),
      fullPage: false,
      type: 'jpeg',
      quality: 85,
    })
    console.log('  -> index.jpg')

    console.log('capturing sheet.html…')
    await captureSheet(page)

    console.log('capturing stitch.html…')
    await page.goto(`${DEMO_ORIGIN}/stitch.html`, { waitUntil: 'networkidle' })
    await page.waitForSelector('canvas')
    await dismissIntroPanels(page)
    await sleep(STEADY_STATE_MS)
    await page.screenshot({
      path: path.join(OUT_DIR, 'stitch.jpg'),
      fullPage: false,
      type: 'jpeg',
      quality: 85,
    })
    console.log('  -> stitch.jpg')

    await browser.close()
    console.log(`\ndone — screenshots written to ${OUT_DIR}`)
  } finally {
    teardown()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
