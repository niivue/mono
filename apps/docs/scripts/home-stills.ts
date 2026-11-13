// Renders the stills on the home page (MRI, CT, microscopy, surfaces and
// tractography) with NiiVue on this machine's GPU, into public/img/home.
//
//   bunx nx home-stills docs-site                 # all five
//   bunx nx home-stills docs-site -- ct mri       # only these
//
// The scenes are in home-stills.scenes.js. They load through the NiiVue
// example server (packages/niivue/vite.config.js), which serves the library
// source and the sample images; CT and microscopy data come from the web.
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { createServer } from 'vite'

// Drawn at 480 CSS pixels and twice that density, then saved at 640 pixels:
// enough for a tile up to 320 pixels wide on a high-density screen.
const SIZE = 480
const SAVED = 640
const SETTLE_MS = 2000

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const niivueDir = path.resolve(siteDir, '../../packages/niivue')
const outDir = path.join(siteDir, 'public/img/home')
const scenesFile = path.join(siteDir, 'scripts/home-stills.scenes.js')
const NAMES = ['mri', 'ct', 'microscopy', 'surfaces', 'tractography']

const only = process.argv.slice(2)
const names = only.length > 0 ? only : NAMES

const server = await createServer({
  configFile: path.join(niivueDir, 'vite.config.js'),
  root: niivueDir,
  logLevel: 'warn',
  server: { port: 5280 },
  plugins: [
    {
      name: 'home-stills-page',
      configureServer(vite) {
        vite.middlewares.use('/__home-stills', (_req, res) => {
          res.setHeader('Content-Type', 'text/html')
          res.end(
            `<!doctype html><body style="margin:0;background:#000">` +
              `<canvas id="c" style="display:block;width:${SIZE}px;height:${SIZE}px"></canvas>`,
          )
        })
      },
    },
  ],
})
await server.listen()
const origin = server.resolvedUrls?.local[0]?.replace(/\/$/, '')
// Full Chromium draws on the real GPU; the default headless shell does not.
const browser = await chromium.launch({ channel: 'chromium' })
const page = await browser.newPage({
  viewport: { width: SIZE, height: SIZE },
  deviceScaleFactor: 2,
})
page.on('pageerror', (e) => console.error(`  page error: ${e.message}`))
mkdirSync(outDir, { recursive: true })

// Vite pre-bundles dependencies the first time a page imports them and then
// reloads the page, which aborts that run; the next one finds them ready.
async function draw(name: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    await page.goto(`${origin}/__home-stills`)
    try {
      await page.evaluate(
        async ({ module, name }) => {
          const { scenes } = await import(module)
          const canvas = document.getElementById('c') as HTMLCanvasElement
          await scenes[name](canvas)
        },
        { module: `/@fs${scenesFile}`, name },
      )
      return
    } catch (e) {
      if (attempt === 3) throw e
      await page.waitForTimeout(3000)
    }
  }
}

try {
  for (const name of names) {
    process.stdout.write(`${name}... `)
    await draw(name)
    await page.waitForTimeout(SETTLE_MS)
    const png = await page.locator('#c').screenshot()
    const file = path.join(outDir, `${name}.webp`)
    await sharp(png).resize(SAVED, SAVED).webp({ quality: 80 }).toFile(file)
    console.log(path.relative(siteDir, file))
  }
} finally {
  await browser.close()
  await server.close()
}
