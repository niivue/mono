import { mat4, vec3 } from 'gl-matrix'
import marchWGSL from './cinematic.wgsl?raw'
import displayWGSL from './display.wgsl?raw'
import downsampleWGSL from './downsample.wgsl?raw'
import extinctionWGSL from './extinction.wgsl?raw'
import gradientWGSL from './gradient.wgsl?raw'
import { TF_H, TF_W } from './tf.js'
import tfCommonWGSL from './tfcommon.wgsl?raw'

const PARAM_BYTES = 3 * 64 + 6 * 16 + 14 * 16
// Label 255 marks a hidden structure, so at most 254 labels.
const HIDDEN_LABEL = 255
// Empty-space skip reads this extinction mip (4 extinction voxels per texel).
const SKIP_LOD = 2

export const DEFAULT_SETTINGS = {
  lightElevation: 20, // degrees above the view direction
  lightAzimuth: 0,
  lightConeDeg: 4, // soft shadow penumbra
  lightIntensity: 1.2,
  ambient: 0.3,
  shadow: 1,
  ao: 0.6,
  aoRadiusMM: 12,
  aoConeDeg: 30,
  volumetricDiffuse: 0.5,
  exposure: 1,
  stepVoxels: 0.5,
  maxFrames: 256,
  scale: 1,
  specular: 1,
}

const deg2tan = (deg) => Math.tan((deg * Math.PI) / 180)

export class CinematicRenderer {
  static async create(canvas) {
    const adapter = await navigator.gpu?.requestAdapter()
    if (!adapter) throw new Error('WebGPU is unavailable')
    // Large CTs (512^2 x 600) need more than the 256 MiB default staging buffer.
    const { maxBufferSize, maxStorageBufferBindingSize } = adapter.limits
    // Timestamps time the march pass itself; onSubmittedWorkDone resolves on
    // the browser's schedule and reads ~16 ms for a 4 ms frame.
    const requiredFeatures = adapter.features.has('timestamp-query')
      ? ['timestamp-query']
      : []
    const device = await adapter.requestDevice({
      requiredFeatures,
      requiredLimits: { maxBufferSize, maxStorageBufferBindingSize },
    })
    return new CinematicRenderer(canvas, device)
  }

  constructor(canvas, device) {
    this.canvas = canvas
    this.device = device
    this.context = canvas.getContext('webgpu')
    this.format = navigator.gpu.getPreferredCanvasFormat()
    this.context.configure({ device, format: this.format, alphaMode: 'opaque' })
    this.settings = { ...DEFAULT_SETTINGS }
    this.background = [0, 0, 0, 1]
    this.frame = 0
    this.frameTimes = []
    this._generation = 0
    this._inFlight = false
    this.clipPlanes = []
    this.isClipCutaway = false
    this.labels = null
    this.unlabeledScale = 1
    this.hiddenLabels = new Set()
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    })
    const uniform = (size) =>
      device.createBuffer({
        size,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      })
    this.paramBuffer = uniform(PARAM_BYTES)
    this.extParamBuffer = uniform(96)
    // Two vec4 per label: rgb + opacity, then HU ramp lo/hi, specular, surfaceness floor.
    this.materialBuffer = device.createBuffer({
      size: 256 * 32,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    this._uploadMaterialIds(new Uint8Array(1), [1, 1, 1])
    this.displayBuffer = uniform(32)
    if (device.features.has('timestamp-query')) {
      this.querySet = device.createQuerySet({ type: 'timestamp', count: 2 })
      this.queryResolve = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      })
      this.queryRead = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      })
    }
    const compute = (code) =>
      device.createComputePipeline({
        layout: 'auto',
        compute: {
          module: device.createShaderModule({ code }),
          entryPoint: 'main',
        },
      })
    this.marchPipeline = compute(tfCommonWGSL + marchWGSL)
    this.extinctionPipeline = compute(tfCommonWGSL + extinctionWGSL)
    this.downsamplePipeline = compute(downsampleWGSL)
    this.gradientPipeline = compute(gradientWGSL)
    const displayModule = device.createShaderModule({ code: displayWGSL })
    this.displayPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: displayModule, entryPoint: 'vs' },
      fragment: {
        module: displayModule,
        entryPoint: 'fs',
        targets: [{ format: this.format }],
      },
    })
  }

  // Run 3D compute passes in one submit; each pass is [pipeline, entries, size].
  _dispatch3D(passes) {
    const d = this.device
    const enc = d.createCommandEncoder()
    const pass = enc.beginComputePass()
    for (const [pipeline, entries, size] of passes) {
      pass.setPipeline(pipeline)
      pass.setBindGroup(
        0,
        d.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }),
      )
      pass.dispatchWorkgroups(...size.map((n) => Math.ceil(n / 4)))
    }
    pass.end()
    d.queue.submit([enc.finish()])
  }

  /** hu: Float32Array in RAS voxel order; frac2mm: NVImage.frac2mm. */
  setVolume(hu, dims, frac2mm) {
    const d = this.device
    this.huTex?.destroy()
    this.gradTex?.destroy()
    const texture = (format, usage) =>
      d.createTexture({ size: dims, dimension: '3d', format, usage })
    this.huTex = texture(
      'r16float',
      GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    )
    d.queue.writeTexture(
      { texture: this.huTex },
      new Float16Array(hu),
      { bytesPerRow: dims[0] * 2, rowsPerImage: dims[1] },
      dims,
    )
    this.gradTex = texture(
      'rgba16float',
      GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    )
    this._dispatch3D([
      [
        this.gradientPipeline,
        [
          { binding: 0, resource: this.huTex.createView() },
          { binding: 1, resource: this.gradTex.createView() },
        ],
        dims,
      ],
    ])

    this.dims = dims
    this.mm2frac = mat4.invert(mat4.create(), frac2mm)
    // dHU/dvoxel -> dHU/dmm: grad_mm = L^T * diag(dims) * grad_vox, L = linear part of mm2frac.
    const L = this.mm2frac
    this.gradToMM = mat4.create()
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        // column-major: element (row r, col c) at c*4+r; (L^T)[r][c] = L[c][r] = L[r*4+c]
        this.gradToMM[c * 4 + r] = L[r * 4 + c] * dims[c]
      }
    }
    this.voxelMM = Math.min(
      ...[0, 1, 2].map(
        (a) => vec3.length(frac2mm.slice(a * 4, a * 4 + 3)) / dims[a],
      ),
    )
    this.extVoxelMM = 2 * this.voxelMM
    // Labels belong to the previous grid.
    this.labels = null
    this._applyMaterials()
  }

  // Half-resolution extinction (per mm) with a full mip chain; rebuilt when
  // the volume or transfer function changes, not when the camera moves.
  _buildExtinction() {
    const size = this.dims.map((n) => Math.ceil(n / 2))
    const mips = Math.floor(Math.log2(Math.max(...size))) + 1
    this.extTex?.destroy()
    this.extTex = this.device.createTexture({
      size,
      dimension: '3d',
      format: 'rgba16float',
      mipLevelCount: mips,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    })
    const level = (l) =>
      this.extTex.createView({ baseMipLevel: l, mipLevelCount: 1 })
    const ep = new Float32Array(24)
    ep.set(this.gradToMM, 0)
    ep.set([this.tf.huMin, this.tf.huMax, this.tf.gMax, this.voxelMM], 16)
    ep.set(this._labelInfo(), 20)
    this.device.queue.writeBuffer(this.extParamBuffer, 0, ep)
    const passes = [
      [
        this.extinctionPipeline,
        [
          { binding: 0, resource: this.huTex.createView() },
          { binding: 1, resource: this.gradTex.createView() },
          { binding: 2, resource: this.tfColor.createView() },
          { binding: 3, resource: this.sampler },
          { binding: 4, resource: { buffer: this.extParamBuffer } },
          { binding: 5, resource: level(0) },
          { binding: 6, resource: this.matTex.createView() },
          { binding: 7, resource: { buffer: this.materialBuffer } },
        ],
        size,
      ],
    ]
    for (let l = 1; l < mips; l++) {
      passes.push([
        this.downsamplePipeline,
        [
          { binding: 0, resource: level(l - 1) },
          { binding: 1, resource: level(l) },
        ],
        size.map((n) => Math.max(1, n >> l)),
      ])
    }
    this._dispatch3D(passes)
    this._extDirty = false
    this._bindGroup = null
  }

  setTransferFunction(tf) {
    const d = this.device
    const make = (data, format, channels, h) => {
      const tex = d.createTexture({
        size: [TF_W, h],
        format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      })
      d.queue.writeTexture(
        { texture: tex },
        data,
        { bytesPerRow: TF_W * channels },
        [TF_W, h],
      )
      return tex
    }
    for (const t of [this.tfColor, this.tfMat, this.tfMaxA]) t?.destroy()
    this.tfColor = make(tf.color, 'rgba8unorm', 4, TF_H)
    this.tfMat = make(tf.material, 'rg8unorm', 2, TF_H)
    this.tfMaxA = make(tf.maxAlpha, 'r8unorm', 1, 1)
    this.tf = tf
    this._extDirty = true
    this._bindGroup = null
    this.reset()
  }

  /** mvp, model: NiiVue's calculateMvpMatrix output for this canvas. */
  setCamera(mvp, model) {
    this.invMVP = mat4.invert(mat4.create(), mvp)
    this.model = mat4.clone(model)
    this.reset()
  }

  /** labels: Uint8Array in RAS voxel order on the volume's grid, or null. */
  setLabels(labels) {
    this.labels = labels
    this._applyMaterials()
  }

  /**
   * table: label colormap extended with per-label S (specular) and lo/hi (HU
   * ramp of the surface) and surface (surfaceness floor, 0-255), all indexed
   * like `labels`. unlabeledScale scales
   * the base transfer function for label 0 (0 hides unlabeled tissue).
   */
  setLabelMaterials(table, unlabeledScale) {
    this.labelTable = table
    this.unlabeledScale = unlabeledScale
    this._applyMaterials()
  }

  /** Label values hidden from view, e.g. NiiVue's volume.hiddenLabels from the legend. */
  setHiddenLabels(values) {
    this.hiddenLabels = new Set(values)
    this._applyMaterials()
  }

  _applyMaterials() {
    const t = this.labelTable
    const isOn = !!(this.labels && t)
    const m = new Float32Array(256 * 8)
    const isVisible = new Uint8Array(256)
    if (isOn) {
      for (let i = 1; i < t.labels.length && i < HIDDEN_LABEL; i++) {
        const k = t.I?.[i] ?? i
        const opacity = this.hiddenLabels.has(k) ? 0 : t.A[i] / 255
        m.set([t.R[i] / 255, t.G[i] / 255, t.B[i] / 255, opacity], k * 8)
        const surface = (t.surface?.[i] ?? 0) / 255
        m.set([t.lo[i], t.hi[i], (t.S?.[i] ?? 0) / 255, surface], k * 8 + 4)
        isVisible[k] = opacity > 0 ? 1 : 0
      }
    }
    this.device.queue.writeBuffer(this.materialBuffer, 0, m)
    if (isOn) this._uploadMaterialIds(this._dilate(isVisible), this.dims)
    else this._uploadMaterialIds(new Uint8Array(1), [1, 1, 1])
    this.isLabelOn = isOn
    this._extDirty = true
    this._bindGroup = null
    this.reset()
  }

  // Material id per voxel: a visible label spreads one voxel (6-neighbours)
  // into unlabeled or hidden neighbours, so a structure's surface comes from
  // the intensity ramp across its partial-volume voxels rather than stopping
  // at the categorical label boundary. Hidden labels left over become 255.
  _dilate(isVisible) {
    const src = this.labels
    const [nx, ny, nz] = this.dims
    const out = new Uint8Array(src.length)
    const steps = [1, -1, nx, -nx, nx * ny, -nx * ny]
    for (let z = 0, i = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++, i++) {
          const l = src[i]
          if (isVisible[l]) {
            out[i] = l
            continue
          }
          out[i] = l === 0 ? 0 : HIDDEN_LABEL
          const inside = [
            x < nx - 1,
            x > 0,
            y < ny - 1,
            y > 0,
            z < nz - 1,
            z > 0,
          ]
          for (let k = 0; k < 6; k++) {
            if (inside[k] && isVisible[src[i + steps[k]]]) {
              out[i] = src[i + steps[k]]
              break
            }
          }
        }
      }
    }
    return out
  }

  _uploadMaterialIds(ids, dims) {
    this.matTex?.destroy()
    this.matTex = this.device.createTexture({
      size: dims,
      dimension: '3d',
      format: 'r8uint',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    this.device.queue.writeTexture(
      { texture: this.matTex },
      ids,
      { bytesPerRow: dims[0], rowsPerImage: dims[1] },
      dims,
    )
  }

  // (labels on, unlabeled scale, label colour blend, -). A transfer function
  // with labelBlend > 0 shapes labelled tissue itself; labels only tint it.
  _labelInfo() {
    return [
      this.isLabelOn ? 1 : 0,
      this.unlabeledScale,
      this.tf?.labelBlend ?? 0,
      0,
    ]
  }

  /** planes: NiiVue model.clipPlanes (flat [nx, ny, nz, depth] x 6, |depth| > 1 = off). */
  setClip(planes, isCutaway) {
    this.clipPlanes = Array.from(planes)
    this.isClipCutaway = isCutaway
    this.reset()
  }

  // NiiVue keeps dot(n, p - 0.5) - depth >= 0 (p in texture space). Rescale each
  // active plane so the same expression, dot(n', p) - d', is distance in mm.
  _clipParams() {
    const L = this.mm2frac
    const out = new Float32Array(52)
    let count = 0
    for (let i = 0; i < this.clipPlanes.length; i += 4) {
      const [nx, ny, nz, depth] = this.clipPlanes.slice(i, i + 4)
      if (!(Math.abs(depth) <= 1) || nx * nx + ny * ny + nz * nz < 1e-12)
        continue
      // L^T n: the plane's gradient in mm, so its length converts frac to mm.
      const g = [0, 1, 2].map(
        (c) => L[c * 4] * nx + L[c * 4 + 1] * ny + L[c * 4 + 2] * nz,
      )
      const len = Math.hypot(...g)
      const d = (depth + 0.5 * (nx + ny + nz)) / len
      out.set([nx / len, ny / len, nz / len, d], count * 4)
      out.set([g[0] / len, g[1] / len, g[2] / len, 0], 24 + count * 4)
      count++
    }
    out.set([count, this.isClipCutaway ? 1 : 0, 0, 0], 48)
    return out
  }

  setSettings(s) {
    Object.assign(this.settings, s)
    this.reset()
  }

  reset() {
    this.frame = 0
    this.frameTimes = []
    this._generation++
  }

  /** Mean GPU time (ms) of the march pass over the first 10 frames after a scene change; null until then. */
  get averageMs() {
    // With few frames the untimed build frame can leave fewer than 10 samples.
    const isDone = this.frameTimes.length >= 10 || this.isConverged
    if (!isDone || this.frameTimes.length === 0) return null
    return this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length
  }

  get isConverged() {
    return this.frame >= this.settings.maxFrames
  }

  _resize() {
    const px = (css) =>
      Math.max(1, Math.round(css * devicePixelRatio * this.settings.scale))
    const w = px(this.canvas.clientWidth)
    const h = px(this.canvas.clientHeight)
    if (this.canvas.width !== w || this.canvas.height !== h || !this.accum) {
      this.canvas.width = w
      this.canvas.height = h
      this.accum?.destroy()
      this.accum = this.device.createBuffer({
        size: w * h * 16,
        usage: GPUBufferUsage.STORAGE,
      })
      this._bindGroup = null
      this._displayBindGroup = null
      this.reset()
    }
  }

  _writeParams() {
    const s = this.settings
    // Light is fixed to the camera: rotate its view-space direction into world
    // (mm) space with the transpose of the model rotation.
    const m = this.model
    const le = (s.lightElevation * Math.PI) / 180
    const la = (s.lightAzimuth * Math.PI) / 180
    const v = [
      Math.sin(la) * Math.cos(le),
      Math.sin(le),
      Math.cos(la) * Math.cos(le),
    ]
    const light = [0, 1, 2].map(
      (i) => m[i * 4] * v[0] + m[i * 4 + 1] * v[1] + m[i * 4 + 2] * v[2],
    )
    const w = this.canvas.width
    const h = this.canvas.height
    const p = new Float32Array(PARAM_BYTES / 4)
    p.set(this.mm2frac, 0)
    p.set(this.gradToMM, 16)
    p.set(this.invMVP, 32)
    p.set([w, h, s.volumetricDiffuse, s.specular], 48)
    p.set([...light, deg2tan(s.lightConeDeg)], 52)
    p.set([this.tf.huMin, this.tf.huMax, this.tf.gMax, this.voxelMM], 56)
    p.set([s.stepVoxels * this.voxelMM, this.frame, s.shadow, s.ambient], 60)
    p.set([s.ao, s.aoRadiusMM, s.lightIntensity, this.tf.shininess], 64)
    // A trilinear zero at SKIP_LOD guarantees half a texel of empty space ahead.
    p.set(
      [
        this.extVoxelMM,
        SKIP_LOD,
        0.5 * this.extVoxelMM * 2 ** SKIP_LOD,
        deg2tan(s.aoConeDeg),
      ],
      68,
    )
    p.set(this._clipParams(), 72)
    p.set(this._labelInfo(), 124)
    this.device.queue.writeBuffer(this.paramBuffer, 0, p)
    this.device.queue.writeBuffer(
      this.displayBuffer,
      0,
      new Float32Array([w, h, this.frame + 1, s.exposure, ...this.background]),
    )
  }

  _encodeDisplay(enc) {
    // 'clear' only skips loading old contents: the triangle covers every pixel.
    const rp = enc.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    })
    rp.setPipeline(this.displayPipeline)
    rp.setBindGroup(0, this._displayBindGroup)
    rp.draw(3)
    rp.end()
  }

  /** Redraw the current mean without adding a sample (e.g. before toDataURL). */
  redisplay() {
    if (!this._displayBindGroup) return
    const enc = this.device.createCommandEncoder()
    this._encodeDisplay(enc)
    this.device.queue.submit([enc.finish()])
  }

  /** Adds one progressive sample per pixel, until converged. */
  render() {
    // One frame in flight: queued frames would add latency while dragging and
    // make the timing include queue wait.
    if (this._inFlight || !this.huTex || !this.tf || !this.invMVP) return
    // A frame that waits on the volume upload or extinction build is not timed.
    const isTimed = !this._extDirty
    if (this._extDirty) this._buildExtinction()
    this._resize()
    if (this.isConverged) return
    const d = this.device
    this._writeParams()
    this._bindGroup ??= d.createBindGroup({
      layout: this.marchPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.huTex.createView() },
        { binding: 1, resource: this.gradTex.createView() },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: this.tfColor.createView() },
        { binding: 4, resource: this.tfMat.createView() },
        { binding: 5, resource: this.tfMaxA.createView() },
        { binding: 6, resource: { buffer: this.paramBuffer } },
        { binding: 7, resource: { buffer: this.accum } },
        { binding: 8, resource: this.extTex.createView() },
        { binding: 9, resource: this.matTex.createView() },
        { binding: 10, resource: { buffer: this.materialBuffer } },
      ],
    })
    this._displayBindGroup ??= d.createBindGroup({
      layout: this.displayPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.accum } },
        { binding: 1, resource: { buffer: this.displayBuffer } },
      ],
    })
    const enc = d.createCommandEncoder()
    const cp = enc.beginComputePass(
      this.querySet && {
        timestampWrites: {
          querySet: this.querySet,
          beginningOfPassWriteIndex: 0,
          endOfPassWriteIndex: 1,
        },
      },
    )
    cp.setPipeline(this.marchPipeline)
    cp.setBindGroup(0, this._bindGroup)
    cp.dispatchWorkgroups(
      Math.ceil(this.canvas.width / 8),
      Math.ceil(this.canvas.height / 8),
    )
    cp.end()
    if (this.querySet) {
      enc.resolveQuerySet(this.querySet, 0, 2, this.queryResolve, 0)
      enc.copyBufferToBuffer(this.queryResolve, 0, this.queryRead, 0, 16)
    }
    this._encodeDisplay(enc)
    d.queue.submit([enc.finish()])
    this._inFlight = true
    const generation = this._generation
    const t0 = performance.now()
    const done = this.querySet
      ? this.queryRead.mapAsync(GPUMapMode.READ).then(() => {
          const [begin, end] = new BigUint64Array(
            this.queryRead.getMappedRange(),
          )
          this.queryRead.unmap()
          return Number(end - begin) / 1e6
        })
      : d.queue.onSubmittedWorkDone().then(() => performance.now() - t0)
    done
      .then((ms) => {
        // Drop frames that finish after a scene change.
        if (
          isTimed &&
          generation === this._generation &&
          this.frameTimes.length < 10
        ) {
          this.frameTimes.push(ms)
        }
      })
      .finally(() => {
        this._inFlight = false
      })
    this.frame++
  }
}
