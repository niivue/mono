import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

// Load every demo page and report anything that would greet a visitor as broken:
// an uncaught exception, a console error, or a missing asset on the dev server.
// This is a breadth check, not a rendering check.

const examplesDir = join(import.meta.dirname, '..', 'examples')
const pages = readdirSync(examplesDir)
  .filter((f) => f.endsWith('.html') && f !== 'index.html')
  .sort()

// Headless Chromium has no WebGPU adapter, so every page that asks for the
// default backend logs this before `attachToCanvas` falls back to WebGL2. That
// fallback is the behavior under test elsewhere, not a demo fault. Two pages
// rethrow rather than log it: the WebGPU-only distribution has no fallback, and
// the fallback is declined for a shared canvas.
const HEADLESS_WEBGPU = /WebGPU adapter|Failed to initialize webgpu view/

const isLocal = (url: string) => url.includes('localhost:5273')

test.describe('demo pages load cleanly', () => {
  for (const name of pages) {
    test(name, async ({ page }) => {
      const problems: string[] = []
      const remote: string[] = []
      page.on('pageerror', (err) => {
        if (HEADLESS_WEBGPU.test(err.message)) return
        // A demo that fetches its data from a third-party host surfaces the
        // outage as a rejected fetch; that is the network, not the page.
        if (/Failed to fetch/.test(err.message) && remote.length > 0) {
          remote.push(`uncaught: ${err.message}`)
          return
        }
        problems.push(`uncaught: ${err.message}`)
      })
      page.on('console', (msg) => {
        if (msg.type() !== 'error') return
        const text = msg.text()
        if (HEADLESS_WEBGPU.test(text)) return
        // Chromium's own resource-failure line carries no URL; the matching
        // request event already recorded which host it was.
        if (/Failed to load resource|net::ERR_/.test(text)) {
          remote.push(`console: ${text}`)
          return
        }
        // A demo reporting its own fetch failure follows from a remote outage
        // that is already noted.
        if (/Failed to fetch/.test(text) && remote.length > 0) {
          remote.push(`console: ${text}`)
          return
        }
        problems.push(`console: ${text}`)
      })
      page.on('requestfailed', (req) => {
        const line = `request failed: ${req.url()}`
        if (isLocal(req.url())) problems.push(line)
        else remote.push(line)
      })
      page.on('response', (res) => {
        if (res.status() < 400) return
        const line = `HTTP ${res.status()}: ${res.url()}`
        if (isLocal(res.url())) problems.push(line)
        else remote.push(line)
      })

      await page.goto(`/examples/${name}`)
      // Give the volume/mesh loads a chance to finish and the first frames to draw.
      await page.waitForTimeout(6000)

      const hasCanvas = await page.evaluate(
        () => document.querySelectorAll('canvas').length > 0,
      )
      expect(hasCanvas, 'page should have a canvas').toBe(true)
      if (remote.length > 0) {
        test.info().annotations.push({
          type: 'remote-asset',
          description: remote.join('\n'),
        })
      }
      expect(problems.join('\n')).toBe('')
    })
  }
})
