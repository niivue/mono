// Shared WebGPU plumbing for uikit's renderers.

/**
 * An overlay pipeline for the open pass: a 4-vertex triangle strip, alpha
 * "over" blending (or none, to replace the frame), no depth write or test, and
 * a depth-stencil state only when the pass has a depth attachment (the main
 * NiiVue view does; the slide viewer does not).
 */
export function overlayPipeline(
  device: GPUDevice,
  module: GPUShaderModule,
  bindLayout: GPUBindGroupLayout,
  colorFormat: GPUTextureFormat,
  sampleCount: number,
  depthFormat: GPUTextureFormat | undefined,
  blend = true,
): GPURenderPipeline {
  return device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindLayout] }),
    multisample: { count: sampleCount },
    vertex: { module, entryPoint: 'vertex_main' },
    fragment: {
      module,
      entryPoint: 'fragment_main',
      targets: [
        {
          format: colorFormat,
          ...(blend
            ? {
                blend: {
                  color: {
                    srcFactor: 'src-alpha',
                    dstFactor: 'one-minus-src-alpha',
                  },
                  alpha: {
                    srcFactor: 'one',
                    dstFactor: 'one-minus-src-alpha',
                  },
                },
              }
            : {}),
        },
      ],
    },
    ...(depthFormat
      ? {
          depthStencil: {
            depthWriteEnabled: false,
            depthCompare: 'always' as const,
            format: depthFormat,
          },
        }
      : {}),
    primitive: { topology: 'triangle-strip' },
  })
}
