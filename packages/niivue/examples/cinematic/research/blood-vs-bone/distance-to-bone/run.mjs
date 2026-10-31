// Render a sample with the cr_angio preset before and after the prep-time
// blood weight (edt.wgsl x6 + blood.wgsl), via the dev server on 5274.
// node run.mjs ct-philips [azimuth] [elevation] [T] [d0] [d1] [rc]
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { chromium } from '../../node_modules/playwright/index.mjs'

const [
  sample = 'ct-philips',
  azimuth = '110',
  elevation = '10',
  T = '600',
  d0 = '2',
  d1 = '8',
  rc = '20',
] = process.argv.slice(2)
const root = new URL(
  '../../packages/niivue/examples/cinematic/',
  import.meta.url,
)
const out = new URL('./', import.meta.url)
const read = (f) => fs.readFileSync(new URL(f, root), 'utf8')
let march = read('cinematic.wgsl')
let extinction = read('extinction.wgsl')
// w = 1 until the blood pass runs, so the baseline render is unchanged.
const gradient = read('gradient.wgsl').replace(
  'vec4f(g / 32.0, 0.0)',
  'vec4f(g / 32.0, 1.0)',
)
march = march
  .replace('fn gradMM(pf: vec3f) -> vec3f {', 'fn gradMM(pf: vec3f) -> vec4f {')
  .replace(
    'textureSampleLevel(gradTex, samp, pf, 0.0).xyz',
    'textureSampleLevel(gradTex, samp, pf, 0.0)',
  )
  .replace(
    'return mat3x3f(P.gradToMM[0].xyz, P.gradToMM[1].xyz, P.gradToMM[2].xyz) * gv;',
    'return vec4f(mat3x3f(P.gradToMM[0].xyz, P.gradToMM[1].xyz, P.gradToMM[2].xyz) * gv.xyz, gv.w);',
  )
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
assert(
  march.includes('gradSample.w') &&
    extinction.includes('gradSample.w') &&
    gradient.includes('1.0))'),
)

const b = await chromium.launch({
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal'],
})
const p = await b.newPage({
  viewport: { width: 900, height: 700 },
  deviceScaleFactor: 1,
})
const errors = []
p.on('pageerror', (e) => errors.push(e.message))
p.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
for (const [name, code] of [
  ['cinematic', march],
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
  s = `${s
    .replaceAll('requestAnimationFrame(tick)', 'void 0')
    .replace(
      'cr.setVolume(hu, vol.dimsRAS.slice(1, 4), vol.frac2mm)',
      'cr.setVolume(hu, vol.dimsRAS.slice(1, 4), vol.frac2mm); window.huRAS = hu',
    )}\nwindow.audit={nv1,cr,syncCamera};`
  await r.fulfill({ contentType: 'application/javascript', body: s })
})
await p.route('**/CT_WholeBody.nii.gz*', (r) =>
  r.fulfill({
    body: fs.readFileSync(
      '/Users/chris/src/cinematic/TotalSegmentator/s1749/ct.nii.gz',
    ),
  }),
)
await p.route('https://raw.githubusercontent.com/**/CT_*.nii.gz', (r) =>
  r.fulfill({
    body: fs.readFileSync(
      `/Users/chris/src/cinematic/ct/${r.request().url().split('/').pop()}`,
    ),
  }),
)
await p.goto(
  `http://localhost:5274/examples/cinematic.html?sample=${sample}&tf=cr_angio&azimuth=${azimuth}&elevation=${elevation}&maxFrames=48`,
)
await p.waitForFunction(() => !!window.audit, { timeout: 60000 })

const result = await p.evaluate(
  async ({ edt, blood, T, d0, d1, rc }) => {
    const { cr, nv1, syncCamera } = window.audit
    const d = cr.device
    d.addEventListener('uncapturederror', (e) => console.error(e.error.message))
    const settle = async () => {
      while (cr._inFlight) await new Promise((r) => setTimeout(r, 1))
    }
    const shot = async () => {
      syncCamera()
      cr.reset()
      for (let i = 0; i < 48; i++) {
        cr.render()
        await settle()
      }
      cr.redisplay()
      const c = document.createElement('canvas')
      c.width = cr.canvas.width
      c.height = cr.canvas.height
      const ctx = c.getContext('2d')
      ctx.drawImage(cr.canvas, 0, 0)
      const px = ctx.getImageData(0, 0, c.width, c.height).data
      let red = 0
      for (let i = 0; i < px.length; i += 4)
        if (px[i] > 40 && px[i] > px[i + 1] * 1.5 && px[i] > px[i + 2] * 1.5)
          red++
      return { png: c.toDataURL(), red, ms: cr.averageMs }
    }
    const before = await shot()

    const vol = nv1.volumes[0]
    const dims = cr.dims
    const spacing = [0, 1, 2].map(
      (a) => Math.hypot(...vol.frac2mm.slice(a * 4, a * 4 + 3)) / dims[a],
    )
    const compile = async (code) => {
      const module = d.createShaderModule({ code })
      const info = await module.getCompilationInfo()
      if (info.messages.some((m) => m.type === 'error'))
        throw new Error(info.messages.map((m) => m.message).join('\n'))
      return d.createComputePipeline({
        layout: 'auto',
        compute: { module, entryPoint: 'main' },
      })
    }
    const edtPipe = await compile(edt)
    const bloodPipe = await compile(blood)
    const tex = (format) =>
      d.createTexture({
        size: dims,
        dimension: '3d',
        format,
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.STORAGE_BINDING |
          GPUTextureUsage.COPY_SRC,
      })
    const [A, B, C] = [tex('r32float'), tex('r32float'), tex('r32float')]
    const newGrad = tex('rgba16float')
    const cap = Math.max(rc, d1)
    const uniforms = []
    const edtPass = (src, dst, axis, mode, thresh) => {
      const u = d.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      })
      d.queue.writeBuffer(
        u,
        0,
        new Uint32Array([axis, mode, Math.ceil(cap / spacing[axis]), 0]),
      )
      d.queue.writeBuffer(
        u,
        16,
        new Float32Array([spacing[axis], thresh, cap * cap, 0]),
      )
      uniforms.push(u)
      return [
        edtPipe,
        [
          { binding: 0, resource: src.createView() },
          { binding: 1, resource: dst.createView() },
          { binding: 2, resource: { buffer: u } },
        ],
        dims,
      ]
    }
    // Everything cr_angio colours red: alpha starts at HU 100, ivory from 450.
    const bandUniforms = d.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    d.queue.writeBuffer(
      uniforms,
      0,
      new Float32Array([d0, d1, rc * rc, 0, 50, 100, 400, 450]),
    )
    await d.queue.onSubmittedWorkDone()
    const start = performance.now()
    cr._dispatch3D([
      edtPass(cr.huTex, A, 0, 0, T),
      edtPass(A, B, 1, 1, 0),
      edtPass(B, A, 2, 1, 0), // A = dist^2 to dense
      edtPass(A, B, 0, 0, rc * rc - 1e-3),
      edtPass(B, C, 1, 1, 0),
      edtPass(C, B, 2, 1, 0), // B = dist^2 to outside the dilation (A is capped at rc^2)
      [
        bloodPipe,
        [
          { binding: 0, resource: A.createView() },
          { binding: 1, resource: B.createView() },
          { binding: 2, resource: cr.gradTex.createView() },
          { binding: 3, resource: newGrad.createView() },
          { binding: 4, resource: { buffer: bandUniforms } },
          { binding: 5, resource: cr.huTex.createView() },
        ],
        dims,
      ],
    ])
    await d.queue.onSubmittedWorkDone()
    const prepMs = performance.now() - start
    // Read back HU and w: fraction of band voxels (150-450 HU) suppressed (w < 0.5), as rule.py reports.
    const readback = async (texture, bpp) => {
      const bytesPerRow = Math.ceil((dims[0] * bpp) / 256) * 256
      const buf = d.createBuffer({
        size: bytesPerRow * dims[1] * dims[2],
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      })
      const enc = d.createCommandEncoder()
      enc.copyTextureToBuffer(
        { texture },
        { buffer: buf, bytesPerRow, rowsPerImage: dims[1] },
        dims,
      )
      d.queue.submit([enc.finish()])
      await buf.mapAsync(GPUMapMode.READ)
      return {
        data: new Float16Array(buf.getMappedRange()),
        stride: bytesPerRow / 2,
      }
    }
    const hu = window.huRAS
    const gw = await readback(newGrad, 8)
    let band = 0,
      suppressed = 0,
      core = 0,
      coreSup = 0
    for (let z = 0; z < dims[2]; z++)
      for (let y = 0; y < dims[1]; y++) {
        const ho = (z * dims[1] + y) * dims[0],
          go = (z * dims[1] + y) * gw.stride
        for (let x = 0; x < dims[0]; x++) {
          const v = hu[ho + x]
          if (v >= 150 && v <= 450) {
            band++
            if (gw.data[go + 4 * x + 3] < 0.5) suppressed++
          }
          if (v >= 150 && v <= 400) {
            core++
            if (gw.data[go + 4 * x + 3] < 0.5) coreSup++
          }
        }
      }
    cr.gradTex.destroy()
    cr.gradTex = newGrad
    cr._extDirty = true
    cr._bindGroup = null
    for (const t of [A, B, C]) t.destroy()
    const after = await shot()
    return {
      before,
      after,
      prepMs,
      band,
      suppressed: suppressed / band,
      core,
      coreSuppressed: coreSup / core,
      dims,
      spacing,
      voxels: dims[0] * dims[1] * dims[2],
    }
  },
  {
    edt: fs.readFileSync(new URL('edt.wgsl', out), 'utf8'),
    blood: fs.readFileSync(new URL('blood.wgsl', out), 'utf8'),
    T: +T,
    d0: +d0,
    d1: +d1,
    rc: +rc,
  },
)
assert.deepEqual(errors, [])
const tag = `${sample}-az${azimuth}-T${T}-${d0}-${d1}-rc${rc}`
for (const k of ['before', 'after']) {
  fs.writeFileSync(
    new URL(`${tag}-${k}.png`, out),
    Buffer.from(result[k].png.split(',')[1], 'base64'),
  )
  delete result[k].png
}
console.log(tag, JSON.stringify(result))
await b.close()
