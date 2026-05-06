/**
 * Headless driver for examples/benchmark.html (autorun mode).
 *
 * Usage: bun run bench <url> <out.json>
 *
 *   <url>      The benchmark URL including ?autorun=1 and any frame/scenario
 *              overrides. The script does not modify the URL.
 *   <out.json> Where to write the JSON result (niivue-benchmark-v1 schema).
 *
 * The dev/preview server is expected to be running already — this script
 * just connects to it. That keeps the runner composable for both local use
 * and CI workflows.
 *
 * Default mode is headless Chromium, which uses Google's SwiftShader on
 * every platform — Chromium does not expose hardware GPUs in headless
 * mode (no Metal on macOS, no Vulkan ICD on Linux without setup). This
 * is good for CI: deterministic numbers, no GPU-driver variance. PR vs
 * main on the same SwiftShader still detects real regressions.
 *
 * Set `BENCH_HEADED=1` to launch a visible browser window — only then
 * do you get real-GPU numbers (Metal on macOS, etc.). Use for local
 * "what's my actual fps" runs, not for CI comparison.
 */

import { writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const TIMEOUT_MS = 10 * 60 * 1000

const [, , url, outPath] = process.argv
if (!url || !outPath) {
  console.error('usage: bun run bench <url> <out.json>')
  process.exit(2)
}

const headed = process.env.BENCH_HEADED === '1'
console.log(
  `[bench] mode: ${headed ? 'headed (real GPU)' : 'headless (SwiftShader)'}`,
)

const browser = await chromium.launch({
  headless: !headed,
  args: ['--enable-unsafe-webgpu', '--no-sandbox'],
})

let exitCode = 0
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })

  page.on('console', (msg) => {
    const t = msg.type()
    if (t === 'error' || t === 'warning')
      console.error(`[page ${t}]`, msg.text())
  })
  page.on('pageerror', (err) => console.error('[page error]', err.message))

  console.log(`[bench] navigating: ${url}`)
  await page.goto(url, { waitUntil: 'load', timeout: 60_000 })

  console.log(`[bench] waiting for __benchDone (timeout ${TIMEOUT_MS / 1000}s)`)
  await page.waitForFunction(
    () =>
      'window' in globalThis &&
      (globalThis as { __benchDone?: boolean }).__benchDone === true,
    null,
    { timeout: TIMEOUT_MS },
  )

  const error = await page.evaluate(
    () => (globalThis as { __benchError?: string }).__benchError ?? null,
  )
  if (error) {
    console.error(`[bench] page reported error: ${error}`)
    exitCode = 1
  }

  const result = await page.evaluate(
    () => (globalThis as { __bench?: unknown }).__bench ?? null,
  )
  if (result == null) {
    console.error(
      '[bench] window.__bench is missing — bench did not produce results',
    )
    exitCode = 1
  } else {
    const json = JSON.stringify(result, null, 2)
    await writeFile(outPath, json, 'utf8')
    console.log(
      `[bench] wrote ${json.length.toLocaleString()} bytes to ${outPath}`,
    )

    const r = result as {
      env?: {
        gpu?: {
          vendor?: string
          architecture?: string
          device?: string
          description?: string
        }
        platform?: string
      }
      renderer?: unknown[]
      compute?: unknown[]
    }
    const gpu = r.env?.gpu
    const gpuLabel = gpu
      ? [gpu.vendor, gpu.architecture, gpu.device, gpu.description]
          .filter(Boolean)
          .join(' / ') || 'unknown'
      : 'unknown'
    const rn = Array.isArray(r.renderer) ? r.renderer.length : 0
    const cn = Array.isArray(r.compute) ? r.compute.length : 0
    console.log(
      `[bench] gpu="${gpuLabel}" platform=${r.env?.platform ?? 'unknown'} renderer=${rn} compute=${cn}`,
    )
  }
} finally {
  await browser.close()
}

process.exit(exitCode)
