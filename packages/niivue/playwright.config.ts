import { defineConfig, devices } from '@playwright/test'
import { defaultLaunchOptions } from './e2e/launchOptions'

// End-to-end tests that need a real browser: rendering, a GPU context, DOM
// image decoding, real Workers and canvas input. State and logic tests drive a
// headless controller under bun test instead (src/testing/headless.ts). These
// run against the Vite dev server (source is served directly, same as the
// demos). Kept OUT of the hermetic unit `test` target — run with
// `bun run test:e2e` (or `nx e2e niivue`).
//
// Two projects. `chromium` is every spec but the demo-page smoke test; it is
// the fast development loop (`bun run test:e2e`). `demo-smoke` loads every
// examples/*.html page (~80 tests, most of the suite's time) and runs only
// in the full tier (`test:e2e:full`, `test:e2e:metal`, a bare
// `playwright test`).

const PORT = 5273
const BASE_URL = `http://localhost:${PORT}`
const DEMO_SMOKE = '**/demo-smoke.spec.ts'

export default defineConfig({
  testDir: './e2e',
  // Reference images (e2e/render-reference.spec.ts) are shared by every
  // platform and GPU (Metal, SwiftShader): no {platform} in the path.
  snapshotPathTemplate: '{testDir}/__snapshots__/{testFilePath}/{arg}{ext}',
  expect: {
    // The one tolerance for every reference image, Metal and SwiftShader.
    // Each renderer is bit-stable run to run. Metal against SwiftShader, at
    // this threshold (about 4 grey levels), differs in at most 21 pixels
    // (colorbar text), 2 elsewhere (silhouette and crosshair edges); the
    // ratio allows 64 of 25600. A looser threshold hides real regressions: at
    // 0.1, a 10% dimmer mesh diffuse term still passed.
    toMatchSnapshot: { threshold: 0.02, maxDiffPixelRatio: 0.0025 },
  },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // The JSON report feeds .github/scripts/check-no-skipped-tests.ts.
  reporter: process.env.CI
    ? [
        ['list'],
        ['html', { open: 'never' }],
        ['json', { outputFile: 'test-results/results.json' }],
      ]
    : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    launchOptions: defaultLaunchOptions,
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: DEMO_SMOKE,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'demo-smoke',
      testMatch: DEMO_SMOKE,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // E2E_BUNDLE=1 tests a build; much faster per test, see vite.config.e2e.ts.
    command: process.env.E2E_BUNDLE
      ? 'bun run e2e:serve:bundle'
      : 'bun run e2e:serve',
    url: `${BASE_URL}/examples/index.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
