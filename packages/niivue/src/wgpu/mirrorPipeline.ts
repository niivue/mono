/**
 * Front-face twins for render pipelines drawn into mirrored 2D slice tiles.
 *
 * A radiological slice tile mirrors screen X in its projection (see
 * `calculateMvpMatrix2D`), which reverses the screen-space winding of every
 * triangle. WebGL2 handles that with `gl.frontFace(gl.CW)` for the tile;
 * WebGPU bakes the front face into the pipeline, so a culled pipeline needs a
 * twin that is identical except for `primitive.frontFace`.
 *
 * Pipelines created through {@link createMirrorablePipeline} remember their
 * descriptor; {@link mirroredPipeline} builds the twin on first use and caches
 * it. Twins are only ever needed while radiological convention is on, so they
 * are not created up front.
 */

const descriptors = new WeakMap<
  GPURenderPipeline,
  GPURenderPipelineDescriptor
>()
const twins = new WeakMap<GPURenderPipeline, GPURenderPipeline>()

/** `device.createRenderPipeline`, remembering the descriptor for a twin. */
export function createMirrorablePipeline(
  device: GPUDevice,
  descriptor: GPURenderPipelineDescriptor,
): GPURenderPipeline {
  const pipeline = device.createRenderPipeline(descriptor)
  descriptors.set(pipeline, descriptor)
  return pipeline
}

/**
 * The pipeline to draw with: `pipeline` itself, or (when `isMirrored`) its twin
 * with the opposite front face. A pipeline that does not cull is returned as
 * is, since winding does not affect it.
 */
export function mirroredPipeline(
  device: GPUDevice,
  pipeline: GPURenderPipeline,
  isMirrored: boolean,
): GPURenderPipeline {
  if (!isMirrored) return pipeline
  const cached = twins.get(pipeline)
  if (cached) return cached
  const descriptor = descriptors.get(pipeline)
  const primitive = descriptor?.primitive ?? {}
  if (!descriptor || (primitive.cullMode ?? 'none') === 'none') return pipeline
  const twin = device.createRenderPipeline({
    ...descriptor,
    primitive: {
      ...primitive,
      frontFace: (primitive.frontFace ?? 'ccw') === 'ccw' ? 'cw' : 'ccw',
    },
  })
  twins.set(pipeline, twin)
  return twin
}
