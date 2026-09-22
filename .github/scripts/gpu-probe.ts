#!/usr/bin/env bun
// Which GPU does a GitHub-hosted runner expose to headless Chromium?
//
// The e2e workflow (niivue-e2e.yml) runs a deliberately narrow list of specs
// because the Ubuntu runners only have SwiftShader, and WebGPU on it dies
// partway through a run. This probe answers whether another runner does
// better: it launches Chromium a few ways, asks WebGL2 for its renderer
// string and WebGPU for its adapter, then checks that a WebGPU device can
// actually clear a texture, run a compute shader and read both back -- the
// three things the volume renderer and gradient pass need.
//
// On a macOS runner the hoped-for answers are "ANGLE (Apple, ... Metal ...)"
// for WebGL2 and an adapter whose description mentions Apple (the VM exposes
// a paravirtual GPU backed by the host's Metal). On Ubuntu, SwiftShader.
//
// The probe never fails the job: every variant is reported, working or not,
// and the verdict goes to the job summary. Only a script error exits non-zero.
//
// The page is served from a throwaway local HTTP server rather than opened as
// about:blank: `navigator.gpu` only exists in a secure context, and a
// top-level about:blank is not one, so probing there reports WebGPU as
// missing on every machine (verified locally before this comment was written).
//
// Usage:
//   bun .github/scripts/gpu-probe.ts
//
// Environment:
//   GITHUB_STEP_SUMMARY       when set, a markdown report is appended to it
//   PLAYWRIGHT_CHROMIUM_PATH  optional browser override for local runs (the
//                             same escape hatch the e2e config takes); the
//                             full-Chromium variant is skipped when set,
//                             because `channel` and `executablePath` conflict

import { appendFileSync } from 'node:fs'
import { chromium, type LaunchOptions } from 'playwright'

type Variant = { name: string; launch: LaunchOptions }

const WEBGPU = ['--enable-unsafe-webgpu']
// The e2e config's current setup, for a same-runner baseline.
const SWIFTSHADER = [
  '--enable-unsafe-swiftshader',
  '--enable-unsafe-webgpu',
  '--use-angle=swiftshader',
  '--enable-features=Vulkan',
]

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH
const VARIANTS: Variant[] = [
  { name: 'headless shell', launch: { args: WEBGPU } },
  {
    name: 'headless shell, --ignore-gpu-blocklist',
    launch: { args: [...WEBGPU, '--ignore-gpu-blocklist'] },
  },
  // Full Chromium in its new headless mode. GPU acceleration is gated
  // differently from the headless shell, so this is the variant most likely
  // to reach a hardware adapter.
  ...(executablePath
    ? []
    : [
        {
          name: 'full chromium (new headless), --ignore-gpu-blocklist',
          launch: {
            channel: 'chromium',
            args: [...WEBGPU, '--ignore-gpu-blocklist'],
          } as LaunchOptions,
        },
      ]),
  { name: 'swiftshader (current e2e flags)', launch: { args: SWIFTSHADER } },
]

/**
 * Runs in the page. A string, not a function: it uses WebGPU globals this
 * Bun script has no types for, and nothing here needs to be transpiled.
 */
const PROBE_JS = `(async () => {
  const out = { secure: window.isSecureContext, webgl2: null, webgpu: null }
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl2')
  if (gl) {
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    out.webgl2 = {
      renderer: gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
      vendor: gl.getParameter(ext ? ext.UNMASKED_VENDOR_WEBGL : gl.VENDOR),
      max3D: gl.getParameter(gl.MAX_3D_TEXTURE_SIZE),
    }
  }
  if (!navigator.gpu) return out
  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter) { out.webgpu = { adapter: null }; return out }
  const info = adapter.info ?? {}
  const w = {
    vendor: info.vendor ?? '',
    architecture: info.architecture ?? '',
    device: info.device ?? '',
    description: info.description ?? '',
    isFallbackAdapter: adapter.isFallbackAdapter ?? false,
    max3D: adapter.limits.maxTextureDimension3D,
    features: [...adapter.features].sort(),
    renderOk: false,
    computeOk: false,
    deviceState: 'not requested',
  }
  out.webgpu = w
  try {
    const device = await adapter.requestDevice()
    const lost = device.lost.then((l) => 'lost: ' + l.reason + ' ' + l.message)
    // Render: clear a 1x1 texture and read the pixel back.
    const tex = device.createTexture({
      size: [1, 1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    })
    const pix = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })
    // Compute: one invocation writes a constant to a storage buffer.
    const module = device.createShaderModule({
      code: '@group(0) @binding(0) var<storage, read_write> o: array<u32>;\\n' +
        '@compute @workgroup_size(1) fn main() { o[0] = 42u; }',
    })
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    })
    const storage = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    })
    const readback = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })
    const enc = device.createCommandEncoder()
    const rp = enc.beginRenderPass({
      colorAttachments: [{
        view: tex.createView(),
        loadOp: 'clear',
        clearValue: { r: 1, g: 0.5, b: 0, a: 1 },
        storeOp: 'store',
      }],
    })
    rp.end()
    enc.copyTextureToBuffer({ texture: tex }, { buffer: pix, bytesPerRow: 256 }, [1, 1, 1])
    const cp = enc.beginComputePass()
    cp.setPipeline(pipeline)
    cp.setBindGroup(0, device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: storage } }],
    }))
    cp.dispatchWorkgroups(1)
    cp.end()
    enc.copyBufferToBuffer(storage, 0, readback, 0, 4)
    device.queue.submit([enc.finish()])
    await Promise.all([pix.mapAsync(GPUMapMode.READ), readback.mapAsync(GPUMapMode.READ)])
    const px = Array.from(new Uint8Array(pix.getMappedRange()).subarray(0, 4))
    const n = new Uint32Array(readback.getMappedRange())[0]
    w.clearReadback = px
    w.renderOk = px[0] === 255 && Math.abs(px[1] - 128) <= 1 && px[2] === 0 && px[3] === 255
    w.computeReadback = n
    w.computeOk = n === 42
    w.deviceState = await Promise.race([
      lost,
      new Promise((r) => setTimeout(() => r('alive'), 500)),
    ])
    device.destroy()
  } catch (e) {
    w.deviceState = 'error: ' + String(e)
  }
  return out
})()`

type Webgl2 = { renderer: string; vendor: string; max3D: number } | null
type Webgpu = {
  adapter?: null
  vendor?: string
  architecture?: string
  device?: string
  description?: string
  isFallbackAdapter?: boolean
  max3D?: number
  features?: string[]
  renderOk?: boolean
  computeOk?: boolean
  clearReadback?: number[]
  computeReadback?: number
  deviceState?: string
} | null
type Probe = { secure: boolean; webgl2: Webgl2; webgpu: Webgpu }
type Result = {
  variant: string
  probe?: Probe
  gpuPage?: string
  error?: string
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${what} timed out after ${ms} ms`)),
        ms,
      ),
    ),
  ])

/** chrome://gpu, trimmed to the lines that name the backend. Best effort. */
const readGpuPage = async (
  browser: Awaited<ReturnType<typeof chromium.launch>>,
): Promise<string | undefined> => {
  try {
    const page = await browser.newPage()
    await page.goto('chrome://gpu', { timeout: 15_000 })
    const text = await withTimeout(
      page.evaluate('document.body.innerText'),
      15_000,
      'chrome://gpu',
    )
    await page.close()
    const wanted =
      /GL_RENDERER|GL_VENDOR|ANGLE|Dawn|Metal|Vulkan|SwiftShader|WebGL2?:|WebGPU:/
    return String(text)
      .split('\n')
      .filter((l) => wanted.test(l))
      .slice(0, 20)
      .join('\n')
  } catch {
    return undefined
  }
}

const probeVariant = async (v: Variant, url: string): Promise<Result> => {
  const launch: LaunchOptions = {
    ...v.launch,
    ...(executablePath ? { executablePath } : {}),
  }
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    browser = await withTimeout(chromium.launch(launch), 60_000, 'launch')
    const page = await browser.newPage()
    await page.goto(url)
    const probe = (await withTimeout(
      page.evaluate(PROBE_JS),
      60_000,
      'probe',
    )) as Probe
    const gpuPage = launch.channel ? await readGpuPage(browser) : undefined
    return { variant: v.name, probe, gpuPage }
  } catch (err) {
    return {
      variant: v.name,
      error: err instanceof Error ? err.message.split('\n')[0] : String(err),
    }
  } finally {
    await browser?.close().catch(() => {})
  }
}

const code = (s: string | undefined): string => (s ? `\`${s}\`` : '')
const yesNo = (b: boolean | undefined): string => (b ? 'yes' : 'no')

const summarize = (results: Result[]): string => {
  const rows = results.map((r) => {
    if (r.error)
      return `| ${r.variant} | launch/probe failed: ${r.error} | | | | |`
    if (r.probe && !r.probe.secure)
      return `| ${r.variant} | page was not a secure context, so WebGPU is hidden; probe bug | | | | |`
    const gl = r.probe?.webgl2
    const gpu = r.probe?.webgpu
    const adapter =
      gpu === null || gpu === undefined
        ? 'navigator.gpu missing'
        : gpu.adapter === null
          ? 'no adapter'
          : [gpu.vendor, gpu.architecture, gpu.device, gpu.description]
              .filter(Boolean)
              .join(' / ') || '(adapter with empty info)'
    const cells = [
      r.variant,
      gl ? code(gl.renderer) : 'no WebGL2 context',
      code(adapter) + (gpu?.isFallbackAdapter ? ' (fallback)' : ''),
      yesNo(gpu?.renderOk),
      yesNo(gpu?.computeOk),
      gpu?.deviceState ?? '',
    ]
    return `| ${cells.join(' | ')} |`
  })
  const hardware = results.find(
    (r) =>
      r.probe?.webgpu?.renderOk &&
      r.probe.webgpu.computeOk &&
      !r.probe.webgpu.isFallbackAdapter &&
      !/swiftshader|llvmpipe|software/i.test(
        `${r.probe.webgl2?.renderer ?? ''} ${r.probe.webgpu.description ?? ''} ${r.probe.webgpu.vendor ?? ''}`,
      ),
  )
  const verdict = hardware
    ? `A hardware (non-software) WebGPU adapter rendered and computed correctly: "${hardware.variant}". This runner can run the full e2e suite on both backends.`
    : 'No variant reached a working hardware adapter. Only the SwiftShader path is usable here.'
  const details = results
    .filter((r) => r.probe)
    .map((r) =>
      [
        `<details><summary>${r.variant}: adapter features and chrome://gpu</summary>`,
        '',
        '```',
        `WebGL2 vendor: ${r.probe?.webgl2?.vendor ?? ''}`,
        `WebGL2 MAX_3D_TEXTURE_SIZE: ${r.probe?.webgl2?.max3D ?? ''}`,
        `WebGPU maxTextureDimension3D: ${r.probe?.webgpu?.max3D ?? ''}`,
        `WebGPU clear readback: ${JSON.stringify(r.probe?.webgpu?.clearReadback ?? null)} (want [255,128,0,255])`,
        `WebGPU compute readback: ${r.probe?.webgpu?.computeReadback ?? ''} (want 42)`,
        `WebGPU features: ${(r.probe?.webgpu?.features ?? []).join(', ')}`,
        ...(r.gpuPage ? ['', 'chrome://gpu:', r.gpuPage] : []),
        '```',
        '</details>',
        '',
      ].join('\n'),
    )
  return [
    `## GPU probe: ${process.env.RUNNER_OS ?? process.platform} (${process.env.RUNNER_NAME ?? 'local'})`,
    '',
    `**Verdict:** ${verdict}`,
    '',
    '| Chromium variant | WebGL2 renderer | WebGPU adapter | clear ok | compute ok | device |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    ...details,
  ].join('\n')
}

const main = async (): Promise<void> => {
  // A secure context for navigator.gpu; see the header. Ephemeral port.
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response('<!doctype html><title>gpu probe</title>', {
        headers: { 'content-type': 'text/html' },
      }),
  })
  const url = `http://localhost:${server.port}/`
  const results: Result[] = []
  try {
    for (const v of VARIANTS) {
      console.log(`--- ${v.name}`)
      const r = await probeVariant(v, url)
      console.log(JSON.stringify(r, null, 2))
      results.push(r)
    }
  } finally {
    server.stop(true)
  }
  const report = summarize(results)
  console.log(`\n${report}`)
  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (summaryPath) appendFileSync(summaryPath, `${report}\n`)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
