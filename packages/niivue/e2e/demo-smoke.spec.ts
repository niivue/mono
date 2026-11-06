import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from '@playwright/test'
import { test } from './coverage'

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

// A page is settled after QUIET_MS with no request open and two frames drawn.
// Playwright's networkidle is a fixed 500 ms. Loads come in stages (modules,
// then the demo's fetches, then decode and draw), so a much shorter window can
// pass before a later stage starts. Accepted gap: work with no request open is
// not counted, so an error raised after the window is missed. That covers a
// timer and, more often, a volume decode in the volumeLoad worker after its
// download: a decode longer than QUIET_MS and two frames can fail unseen. So
// can a demo whose init (attachToCanvas, no requests) outlasts the window
// before its first fetch. The old fixed wait caught all three. MAX_WAIT_MS caps
// slow pages.
const QUIET_MS = 250
const MAX_WAIT_MS = 6000

// vox.modulate.afni.html passes only .HEAD URLs, so NiiVue probes for the
// paired data file: a GET for .BRIK (a 404, the dev images ship .BRIK.gz),
// then .BRIK.gz. Each probe is aborted once its status arrives, and the
// worker then fetches .BRIK.gz for real.
const isAfniProbe = (demo: string, url: string) =>
  demo === 'vox.modulate.afni.html' &&
  /^\/volumes\/afni\/[^/]+\.BRIK(\.gz)?$/.test(new URL(url).pathname)

// vox.4d.html loads this volume with limitFrames4D, a partial 4D load that
// cancels its fetch once it has the frames. Any other abort is a real failure.
const isExpectedAbort = (
  demo: string,
  url: string,
  errorText: string | undefined,
) =>
  errorText === 'net::ERR_ABORTED' &&
  ((demo === 'vox.4d.html' &&
    new URL(url).pathname === '/volumes/mpld_asl.nii.gz') ||
    isAfniProbe(demo, url))

// The AFNI .BRIK probe above is the only expected error status.
const isExpectedStatus = (demo: string, url: string, status: number) =>
  status === 404 && isAfniProbe(demo, url) && url.endsWith('.BRIK')

test.describe('demo pages load cleanly', () => {
  for (const name of pages) {
    test(name, async ({ page }) => {
      const problems: string[] = []
      const remote: string[] = []
      let inFlight = 0
      let lastActivity = Date.now()
      page.on('request', () => {
        inFlight++
        lastActivity = Date.now()
      })
      const settle = () => {
        inFlight--
        lastActivity = Date.now()
      }
      page.on('requestfinished', settle)
      page.on('requestfailed', settle)
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
        if (isExpectedAbort(name, req.url(), req.failure()?.errorText)) return
        const line = `request failed: ${req.url()}`
        if (isLocal(req.url())) problems.push(line)
        else remote.push(line)
      })
      page.on('response', (res) => {
        if (res.status() < 400) return
        if (isExpectedStatus(name, res.url(), res.status())) return
        const line = `HTTP ${res.status()}: ${res.url()}`
        if (isLocal(res.url())) problems.push(line)
        else remote.push(line)
      })

      await page.goto(`/examples/${name}`)
      // Wait for the loads to finish and the first frames to draw, or the
      // first problem. Frames can start more requests, so recheck after them.
      const deadline = Date.now() + MAX_WAIT_MS
      while (Date.now() < deadline && problems.length === 0) {
        if (inFlight > 0 || Date.now() - lastActivity < QUIET_MS) {
          await page.waitForTimeout(50)
          continue
        }
        const before = lastActivity
        // A busy page (cinematic accumulating frames) can hold frames for
        // seconds, so the frame wait shares the deadline too.
        await Promise.race([
          page
            .evaluate(
              () =>
                new Promise((done) =>
                  requestAnimationFrame(() => requestAnimationFrame(done)),
                ),
            )
            .catch(() => {}),
          page.waitForTimeout(Math.max(0, deadline - Date.now())),
        ])
        if (inFlight === 0 && lastActivity === before) break
      }

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
