// Compiles and runs the WebGPU overlay blend shaders from src/wgpu/orient.ts
// in the system Chrome (needs a real GPU) and compares every mode
// (alphaBlend, colorBlend) with the CPU blendOverlayData, allowing 1 for
// rounding. Each case blends a 1x1x2 volume as two z-slabs, one pass per
// overlay as blendOverlaysGPU does; the reversed and three-overlay cases show
// that the passes keep overlay order, which colour OVER depends on.
// Run: bun packages/niivue/scripts/check-blend-wgsl.mjs (exits 1 on a mismatch)
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { blendOverlayData } from '../src/volume/overlayBlend.ts'

// Each overlay is [z0 rgba, z1 rgba]. z0: disjoint red and green. z1: gray
// under green, whose channels overlap, so colour MAX and ADDITIVE differ.
const red = [
  [255, 0, 0, 153],
  [128, 128, 128, 255],
]
const green = [
  [0, 255, 0, 102],
  [0, 255, 0, 204],
]
const blue = [
  [0, 0, 255, 128],
  [0, 0, 255, 51],
]
const CASES = {
  'red, green': [red, green],
  'green, red': [green, red],
  'red, green, blue': [red, green, blue],
  'blue, red, green': [blue, red, green],
}
const MODES = []
for (let a = 0; a < 3; a++) for (let c = 0; c < 4; c++) MODES.push([a, c])

const src = readFileSync(
  new URL('../src/wgpu/orient.ts', import.meta.url),
  'utf8',
)
const grab = (n) => src.match(new RegExp(`const ${n} = \`([\\s\\S]*?)\``))[1]
const accum = grab('blendAccumShaderCode'),
  norm = grab('blendNormShaderCode')
const b = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--enable-unsafe-webgpu'],
})
const p = await b.newPage()
// WebGPU needs a secure context; about:blank may not expose navigator.gpu
await p.route('https://blend.check/', (r) =>
  r.fulfill({ contentType: 'text/html', body: '<!doctype html>' }),
)
await p.goto('https://blend.check/')
const r = await p.evaluate(
  async ([accum, norm, cases, modes]) => {
    const ad = await navigator.gpu?.requestAdapter()
    if (!ad)
      return `no adapter (secureContext=${isSecureContext}, navigator.gpu=${!!navigator.gpu})`
    const d = await ad.requestDevice()
    const out = []
    const mk = (a, b) => {
      const t = d.createTexture({
        size: [1, 1, 2],
        dimension: '3d',
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      })
      d.queue.writeTexture(
        { texture: t },
        new Uint8Array([...a, ...b]),
        { bytesPerRow: 4, rowsPerImage: 1 },
        [1, 1, 2],
      )
      return t
    }
    for (const [name, overlays] of Object.entries(cases)) {
      const tex = overlays.map(([z0, z1]) => mk(z0, z1))
      for (const [A, C] of modes) {
        d.pushErrorScope('validation')
        const ap = d.createComputePipeline({
          layout: 'auto',
          compute: {
            module: d.createShaderModule({ code: accum }),
            entryPoint: 'main',
            constants: { COLOR_BLEND: C },
          },
        })
        const np = d.createComputePipeline({
          layout: 'auto',
          compute: {
            module: d.createShaderModule({ code: norm }),
            entryPoint: 'main',
            constants: { ALPHA_BLEND: A, COLOR_BLEND: C },
          },
        })
        const buf = d.createBuffer({
          size: 24,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        })
        const outT = d.createTexture({
          size: [1, 1, 2],
          dimension: '3d',
          format: 'rgba8unorm',
          usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
        })
        const rb = d.createBuffer({
          size: 512,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        })
        const e = d.createCommandEncoder()
        for (let z0 = 0; z0 < 2; z0++) {
          const sb = d.createBuffer({
            size: 8,
            usage: GPUBufferUsage.UNIFORM,
            mappedAtCreation: true,
          })
          new Uint32Array(sb.getMappedRange()).set([z0, 1])
          sb.unmap()
          const ents = [
            { binding: 0, resource: { buffer: buf } },
            { binding: 1, resource: { buffer: sb } },
          ]
          if (z0 > 0) e.clearBuffer(buf)
          for (const t of tex) {
            const pass = e.beginComputePass()
            pass.setPipeline(ap)
            pass.setBindGroup(
              0,
              d.createBindGroup({
                layout: ap.getBindGroupLayout(0),
                entries: ents,
              }),
            )
            pass.setBindGroup(
              1,
              d.createBindGroup({
                layout: ap.getBindGroupLayout(1),
                entries: [{ binding: 0, resource: t.createView() }],
              }),
            )
            pass.dispatchWorkgroups(1, 1, 1)
            pass.end()
          }
          const pass = e.beginComputePass()
          pass.setPipeline(np)
          pass.setBindGroup(
            0,
            d.createBindGroup({
              layout: np.getBindGroupLayout(0),
              entries: ents,
            }),
          )
          pass.setBindGroup(
            1,
            d.createBindGroup({
              layout: np.getBindGroupLayout(1),
              entries: [{ binding: 0, resource: outT.createView() }],
            }),
          )
          pass.dispatchWorkgroups(1, 1, 1)
          pass.end()
        }
        e.copyTextureToBuffer(
          { texture: outT },
          { buffer: rb, bytesPerRow: 256, rowsPerImage: 1 },
          [1, 1, 2],
        )
        d.queue.submit([e.finish()])
        const err = await d.popErrorScope()
        await rb.mapAsync(GPUMapMode.READ)
        const v = new Uint8Array(rb.getMappedRange())
        out.push({
          name,
          A,
          C,
          z0: Array.from(v.slice(0, 4)),
          z1: Array.from(v.slice(256, 260)),
          err: err?.message ?? '',
        })
      }
    }
    return out
  },
  [accum, norm, CASES, MODES],
)
await b.close()
if (typeof r === 'string') {
  console.error(r)
  process.exit(1)
}
let bad = 0
for (const { name, A, C, z0, z1, err } of r) {
  const cpu = (z) =>
    Array.from(
      blendOverlayData(
        CASES[name].map((o) => new Uint8Array(o[z])),
        [1, 1, 1],
        A,
        C,
      ),
    )
  const want = [cpu(0), cpu(1)]
  const ok =
    !err &&
    [z0, z1].every((got, z) =>
      got.every((x, i) => Math.abs(x - want[z][i]) <= 1),
    )
  if (!ok) bad++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${A},${C} ${name}: z0 ${z0} z1 ${z1}${ok ? '' : `  (CPU z0 ${want[0]} z1 ${want[1]})`} ${err}`,
  )
}
console.log(
  bad
    ? `${bad} of ${r.length} differ from the CPU blend`
    : `all ${r.length} match the CPU blend`,
)
process.exit(bad ? 1 : 0)
