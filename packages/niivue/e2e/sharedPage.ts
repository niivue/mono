import type { Page } from '@playwright/test'
import { test as base } from './coverage'

// One page per worker: NiiVue's module graph loads once, not per test. After each test the reset destroys every attached NiiVue,
// frees its WebGL context (Chrome caps live contexts at ~16), and restores the
// DOM and window globals. A failed test restarts the worker, so it gets a
// fresh page anyway. Specs that rely on page-level state (navigation, init
// scripts, viewport or deviceScaleFactor) keep the default `page`.
const PAGE_EVENTS = [
  'console',
  'pageerror',
  'request',
  'requestfinished',
  'requestfailed',
  'response',
] as const

// Wraps attachToCanvas to track live instances; snapshots the DOM and window
// keys so the reset can restore them.
const INSTALL = `(async () => {
  const { default: NiiVue } = await import('/src/index.ts')
  const live = new Set()
  for (const name of ['attachTo', 'attachToCanvas']) {
    const attach = NiiVue.prototype[name]
    NiiVue.prototype[name] = function (...args) {
      live.add(this)
      return attach.apply(this, args)
    }
  }
  const html = document.body.innerHTML
  window.__e2eReset = () => {
    // destroy() frees resources but drops the context/device to GC; release
    // them now so they do not pile up within one page.
    for (const nv of live) {
      const { gl, device } = nv.view ?? {}
      nv.destroy()
      gl?.getExtension('WEBGL_lose_context')?.loseContext()
      device?.destroy()
    }
    live.clear()
    document.body.innerHTML = html
    document.body.removeAttribute('style')
    for (const k of Object.keys(window)) if (!globals.has(k)) delete window[k]
    window.scrollTo(0, 0)
  }
  const globals = new Set(Object.keys(window))
})()`

export const test = base.extend<object, { sharedPage: Page }>({
  sharedPage: [
    async ({ browser }, use, workerInfo) => {
      const { baseURL, viewport, userAgent, deviceScaleFactor } =
        workerInfo.project.use
      const page = await browser.newPage({
        baseURL,
        viewport,
        userAgent,
        deviceScaleFactor,
      })
      await page.goto('/examples/index.html', { waitUntil: 'load' })
      await page.evaluate(INSTALL)
      await use(page)
      await page.close()
    },
    { scope: 'worker' },
  ],
  page: async ({ sharedPage }, use) => {
    const before = PAGE_EVENTS.map((e) => new Set(sharedPage.listeners(e)))
    await use(sharedPage)
    PAGE_EVENTS.forEach((e, i) => {
      for (const l of sharedPage.listeners(e))
        if (!before[i].has(l)) sharedPage.off(e, l as () => void)
    })
    await sharedPage.unrouteAll({ behavior: 'ignoreErrors' })
    await sharedPage.evaluate('window.__e2eReset()')
  },
})
