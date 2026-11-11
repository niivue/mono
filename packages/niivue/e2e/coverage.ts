import { posix } from 'node:path'
import { test as base, type Page } from '@playwright/test'
import type { CoverageReportOptions } from 'monocart-coverage-reports'

// Opt-in browser JS coverage (`E2E_COVERAGE=1`, `bun run test:e2e:coverage`).
// Off by default: every hook below returns before touching the page, so the
// a normal run is unaffected.
//
// Covered pages: the worker-scoped shared page (e2e/sharedPage.ts), the
// default per-test `page` fixture, and any page a spec opens itself with
// `browser.newPage()`. Each page's V8 coverage starts when the page is created
// and is taken when it closes, then handed to monocart-coverage-reports, which
// maps it back to `src/**/*.ts` through the source maps Vite serves (inline on
// the dev server, `.map` files in an E2E_BUNDLE build) and caches it on disk.
// e2e/coverageGlobalSetup.ts clears that cache before the run and writes
// `coverage-e2e/lcov.info` after it.
//
// Not covered: Web Worker code (V8 coverage here is per page; worker targets
// are not reached), a page opened with `context.newPage()` (no spec does), and
// a page a failing test leaves open.

export const coverageEnabled = process.env.E2E_COVERAGE === '1'

/** Shared by every worker's `add()` and the teardown's `generate()`. */
export const coverageOptions: CoverageReportOptions = {
  name: 'niivue e2e coverage',
  outputDir: './coverage-e2e',
  reports: ['lcovonly', 'console-summary'],
  // Page scripts NiiVue source is in: dev-server modules under /src/ and, in
  // an E2E_BUNDLE build, its chunks and entries. Pre-bundled dependencies
  // (/node_modules/.vite/), /@vite/ and /@fs/ modules and demo pages are not.
  entryFilter: (entry) => {
    const { pathname } = new URL(entry.url)
    return pathname.startsWith('/src/') || pathname.startsWith('/assets/')
  },
  // Dependencies a build inlines into NiiVue's chunks.
  sourceFilter: (sourcePath) => !sourcePath.includes('node_modules'),
  // To the path Bun's lcov uses (`src/x.ts`), so the two merge file by file.
  // A build's maps name `../src/x.ts`; the dev server's name the bare file,
  // relative to the module URL (`localhost-5273/src/dir/x.ts`, its distFile).
  sourcePath: (filePath, { distFile }) => {
    const local =
      filePath.includes('src/') || !distFile
        ? filePath
        : posix.join(posix.dirname(distFile), filePath)
    const i = local.lastIndexOf('src/')
    return i < 0 ? local : local.slice(i)
  },
  // Only NiiVue's TypeScript source (not JSON imports, tests or other files).
  outputFilter: (file) =>
    /^src\/.*\.ts$/.test(file.sourcePath) &&
    !/\.(test|spec)\.ts$/.test(file.sourcePath),
}

const started = new WeakSet<Page>()

/** Starts coverage on a page before it navigates. No-op unless enabled. */
async function startCoverage(page: Page): Promise<void> {
  if (!coverageEnabled || started.has(page)) return
  started.add(page)
  // resetOnNavigation off: the shared page navigates once, but a spec may
  // navigate its own page, and a reset would drop what ran before.
  await page.coverage.startJSCoverage({ resetOnNavigation: false })
}

/** Takes a page's coverage and adds it to the on-disk cache. */
async function stopCoverage(page: Page): Promise<void> {
  if (!started.has(page) || page.isClosed()) return
  started.delete(page)
  const entries = await page.coverage.stopJSCoverage()
  const { CoverageReport } = await import('monocart-coverage-reports')
  await new CoverageReport(coverageOptions).add(entries)
}

/**
 * The base `test` for every spec. With coverage on, it wraps
 * `browser.newPage` (which the shared page and spec-opened pages use) and the
 * default `page` fixture; with it off, both are the stock fixtures.
 */
export const test = base.extend<object, object>({
  browser: [
    async ({ browser }, use) => {
      if (coverageEnabled) {
        const newPage = browser.newPage.bind(browser)
        browser.newPage = async (options) => {
          const page = await newPage(options)
          await startCoverage(page)
          const close = page.close.bind(page)
          page.close = async (closeOptions) => {
            await stopCoverage(page)
            return close(closeOptions)
          }
          return page
        }
      }
      await use(browser)
    },
    { scope: 'worker' },
  ],
  page: async ({ page }, use) => {
    await startCoverage(page)
    await use(page)
    await stopCoverage(page)
  },
})
