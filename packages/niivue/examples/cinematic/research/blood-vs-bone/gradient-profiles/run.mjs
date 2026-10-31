import assert from 'node:assert/strict'
import fs from 'node:fs'
import { chromium } from '../../node_modules/playwright/index.mjs'

const variant = process.argv[2] || 'baseline',
  sample = process.argv[3] || 'ct-philips'
const root = new URL(
  '../../packages/niivue/examples/cinematic/',
  import.meta.url,
)
const out = new URL('./', import.meta.url)
// profile mode-radius-low-high-strength; physical units mm and HU/mm^2 (or HU for endpoint).
const config = variant === 'baseline' ? null : variant.split('-').map(Number)
if (config) {
  assert.equal(config.length, 5)
  assert(config.every(Number.isFinite))
  assert(
    config[1] > 0 && config[3] > config[2] && config[4] >= 0 && config[4] <= 1,
  )
}
let shader = fs.readFileSync(new URL('cinematic.wgsl', root), 'utf8')
let extinction = fs.readFileSync(new URL('extinction.wgsl', root), 'utf8')
let gradient = fs.readFileSync(new URL('gradient.wgsl', root), 'utf8')
// W stores a baked opacity multiplier, with 1 exactly preserving the baseline.
gradient = gradient.replace('vec4f(g / 32.0, 0.0)', 'vec4f(g / 32.0, 1.0)')
shader = shader
  .replace('fn gradMM(pf: vec3f) -> vec3f {', 'fn gradMM(pf: vec3f) -> vec4f {')
  .replace(
    'textureSampleLevel(gradTex, samp, pf, 0.0).xyz',
    'textureSampleLevel(gradTex, samp, pf, 0.0)',
  )
  .replace(
    'return mat3x3f(P.gradToMM[0].xyz, P.gradToMM[1].xyz, P.gradToMM[2].xyz) * gv;',
    'return vec4f(mat3x3f(P.gradToMM[0].xyz, P.gradToMM[1].xyz, P.gradToMM[2].xyz) * gv.xyz, gv.w);',
  )
shader = shader
  .replace(
    'let g = gradMM(pf);',
    'let gradSample = gradMM(pf);\n    let g = gradSample.xyz;',
  )
  .replace(
    'c.a = classifyAlpha(id, c.a, hu, P.labelInfo);',
    'c.a = classifyAlpha(id, c.a, hu, P.labelInfo) * gradSample.w;',
  )
extinction = extinction
  .replace(
    'let g = length(toMM * textureLoad(gradTex, p, 0).xyz);',
    'let gradSample = textureLoad(gradTex, p, 0);\n    let g = length(toMM * gradSample.xyz);',
  )
  .replace(
    'a = classifyAlpha(id, a, hu, E.labelInfo);',
    'a = classifyAlpha(id, a, hu, E.labelInfo) * gradSample.w;',
  )
const b = await chromium.launch({
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal'],
})
const p = await b.newPage({
  viewport: { width: 800, height: 700 },
  deviceScaleFactor: 1,
})
const errors = []
p.on('pageerror', (e) => errors.push(e.message))
p.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
for (const [name, code] of [
  ['cinematic', shader],
  ['extinction', extinction],
  ['gradient', gradient],
])
  await p.route(`**/${name}.wgsl?*`, (r) =>
    r.fulfill({
      contentType: 'application/javascript',
      body: `export default ${JSON.stringify(code)}`,
    }),
  )
await p.route('**/cinematic/main.js*', async (r) => {
  let s = await (await r.fetch()).text()
  s = s.replaceAll('requestAnimationFrame(tick)', 'void 0')
  s += '\nwindow.audit={nv1,cr,syncCamera};'
  await r.fulfill({ contentType: 'application/javascript', body: s })
})
await p.route('https://raw.githubusercontent.com/**/CT_*.nii.gz', (r) =>
  r.fulfill({
    body: fs.readFileSync(
      `/Users/chris/src/cinematic/ct/${r.request().url().split('/').pop()}`,
    ),
  }),
)
await p.goto(
  'http://localhost:8080/examples/cinematic.html?sample=' +
    sample +
    '&tf=cr_angio&azimuth=110&elevation=10&maxFrames=32',
)
await p.waitForFunction(() => !!window.audit, { timeout: 60000 })
const result = await p.evaluate(
  async ({ config, feature }) => {
    const { cr, nv1, syncCamera } = window.audit
    let preprocessMs = 0
    cr.device.addEventListener('uncapturederror', (e) =>
      console.error(e.error.message),
    )
    const settle = async () => {
      while (cr._inFlight) await new Promise((r) => setTimeout(r, 1))
    }
    if (config) {
      await cr.device.queue.onSubmittedWorkDone()
      const start = performance.now()
      const d = cr.device
      const module = d.createShaderModule({ code: feature })
      const info = await module.getCompilationInfo()
      if (info.messages.some((m) => m.type === 'error'))
        throw new Error(info.messages.map((m) => m.message).join('\n'))
      const pipeline = d.createComputePipeline({
        layout: 'auto',
        compute: { module, entryPoint: 'main' },
      })
      const params = new Float32Array(40)
      params.set(cr.mm2frac, 0)
      params.set(cr.gradToMM, 16)
      params.set([config[1], config[2], config[3], config[4]], 32)
      params[36] = config[0]
      const uniform = d.createBuffer({
        size: 160,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      })
      d.queue.writeBuffer(uniform, 0, params)
      const texture = d.createTexture({
        size: cr.dims,
        dimension: '3d',
        format: 'rgba16float',
        usage:
          GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
      })
      cr._dispatch3D([
        [
          pipeline,
          [
            { binding: 0, resource: cr.huTex.createView() },
            { binding: 1, resource: cr.gradTex.createView() },
            { binding: 2, resource: cr.sampler },
            { binding: 3, resource: { buffer: uniform } },
            { binding: 4, resource: texture.createView() },
          ],
          cr.dims,
        ],
      ])
      await d.queue.onSubmittedWorkDone()
      preprocessMs = performance.now() - start
      cr.gradTex.destroy()
      uniform.destroy()
      cr.gradTex = texture
      cr._extDirty = true
      cr._bindGroup = null
    }
    syncCamera()
    const timings = []
    for (let trial = 0; trial < 3; trial++) {
      cr.reset()
      for (let i = 0; i < 32; i++) {
        cr.render()
        await settle()
      }
      timings.push(cr.averageMs)
    }
    cr.redisplay()
    const c = document.createElement('canvas')
    c.width = cr.canvas.width
    c.height = cr.canvas.height
    const ctx = c.getContext('2d')
    ctx.drawImage(cr.canvas, 0, 0)
    const data = ctx.getImageData(0, 0, c.width, c.height).data
    let red = 0
    for (let i = 0; i < data.length; i += 4)
      if (
        data[i] > 40 &&
        data[i] > data[i + 1] * 1.5 &&
        data[i] > data[i + 2] * 1.5
      )
        red++
    return {
      png: c.toDataURL(),
      red,
      timings,
      preprocessMs,
      width: c.width,
      height: c.height,
      adapter: cr.device.adapterInfo?.architecture,
      dim: nv1.volumes[0].dimsRAS,
    }
  },
  { config, feature: fs.readFileSync(new URL('feature.wgsl', out), 'utf8') },
)
assert.deepEqual(errors, [])
assert.equal(result.width, 800)
fs.writeFileSync(
  new URL(`${sample}-${variant}.png`, out),
  Buffer.from(result.png.split(',')[1], 'base64'),
)
delete result.png
fs.writeFileSync(
  new URL(`${sample}-${variant}.json`, out),
  JSON.stringify(result, null, 2),
)
console.log(variant, sample, result)
await b.close()
