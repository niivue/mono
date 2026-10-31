import march from '../../packages/niivue/examples/cinematic/cinematic.wgsl?raw'
import extinction from '../../packages/niivue/examples/cinematic/extinction.wgsl?raw'
import gradient from '../../packages/niivue/examples/cinematic/gradient.wgsl?raw'
import { CinematicRenderer } from '../../packages/niivue/examples/cinematic/renderer.js'
import common from '../../packages/niivue/examples/cinematic/tfcommon.wgsl?raw'
import feature from './feature.wgsl?raw'

// Experimental adapter: no changes to the normal cinematic demo or public API.
export class BoundaryRenderer extends CinematicRenderer {
  constructor(canvas, device) {
    super(canvas, device)
    const compute = (code) =>
      device.createComputePipeline({
        layout: 'auto',
        compute: {
          module: device.createShaderModule({ code }),
          entryPoint: 'main',
        },
      })
    const sample4 = march
      .replace(
        'fn gradMM(pf: vec3f) -> vec3f {',
        'fn gradMM(pf: vec3f) -> vec4f {',
      )
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
    this.marchPipeline = compute(common + sample4)
    this.extinctionPipeline = compute(
      common +
        extinction
          .replace(
            'let g = length(toMM * textureLoad(gradTex, p, 0).xyz);',
            'let gradSample = textureLoad(gradTex, p, 0);\n    let g = length(toMM * gradSample.xyz);',
          )
          .replace(
            'a = classifyAlpha(id, a, hu, E.labelInfo);',
            'a = classifyAlpha(id, a, hu, E.labelInfo) * gradSample.w;',
          ),
    )
    this.gradientPipeline = compute(
      gradient.replace('vec4f(g / 32.0, 0.0)', 'vec4f(g / 32.0, 1.0)'),
    )
    this.featurePipeline = compute(feature)
  }

  async prepare(profile) {
    await this.device.queue.onSubmittedWorkDone()
    this.sourceGradient ??= this.gradTex
    if (this.gradTex !== this.sourceGradient) this.gradTex.destroy()
    this.gradTex = this.sourceGradient
    if (profile && profile.strength > 0) {
      const d = this.device
      const params = new Float32Array(40)
      params.set(this.mm2frac, 0)
      params.set(this.gradToMM, 16)
      params.set([profile.scaleMM, ...profile.range, profile.strength], 32)
      params[36] = profile.feature
      const uniform = d.createBuffer({
        size: 160,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      })
      d.queue.writeBuffer(uniform, 0, params)
      const texture = d.createTexture({
        size: this.dims,
        dimension: '3d',
        format: 'rgba16float',
        usage:
          GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
      })
      this._dispatch3D([
        [
          this.featurePipeline,
          [
            { binding: 0, resource: this.huTex.createView() },
            { binding: 1, resource: this.sourceGradient.createView() },
            { binding: 2, resource: this.sampler },
            { binding: 3, resource: { buffer: uniform } },
            { binding: 4, resource: texture.createView() },
          ],
          this.dims,
        ],
      ])
      await d.queue.onSubmittedWorkDone()
      uniform.destroy()
      this.gradTex = texture
    }
    this._bindGroup = null
    this._extDirty = true
    this.reset()
  }
}
