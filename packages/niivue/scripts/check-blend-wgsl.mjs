// Compiles and runs the WebGPU overlay blend shaders from src/wgpu/orient.ts on
// a 1x1x2 volume blended as two z-slabs, in the system Chrome (needs a real GPU).
// Run: bun packages/niivue/scripts/check-blend-wgsl.mjs
// Expected, both z, per mode (alphaBlend,colorBlend):
//   0,0: 255,170,0,153   1,0: 153,102,0,255   2,1: 153,102,0,194
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'

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
  async ([accum, norm]) => {
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
    const tex = [
      mk([255, 0, 0, 153], [255, 0, 0, 153]),
      mk([0, 255, 0, 102], [0, 255, 0, 102]),
    ]
    for (const [A, C] of [
      [0, 0],
      [1, 0],
      [2, 1],
    ]) {
      d.pushErrorScope('validation')
      const ap = d.createComputePipeline({
        layout: 'auto',
        compute: {
          module: d.createShaderModule({ code: accum }),
          entryPoint: 'main',
          constants: { ALPHA_BLEND: A },
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
        size: 20,
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
      out.push(
        `${A},${C}: z0 ${Array.from(v.slice(0, 4))}  z1 ${Array.from(v.slice(256, 260))} ${err ? err.message : ''}`,
      )
    }
    return out.join('\n')
  },
  [accum, norm],
)
console.log(r)
await b.close()
