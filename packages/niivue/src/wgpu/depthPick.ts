// Depth-pick module for WebGPU
// Renders to a 1x1 offscreen texture with depth packed into RGBA,
// then reads back via copyTextureToBuffer + mapAsync.

import { mat4 } from "gl-matrix"
import { log } from "@/logger"
import { volumeShaderPreamble } from "./volumeShaderLib"

// --- Volume depth-pick WGSL ---
// Preamble (structs, bindings, vertex shader, helpers) from volumeShaderLib.
// Fragment exits on first non-transparent voxel and packs depth.
const volumeDepthPickFragment = /* wgsl */ `
fn packDepth(d_in: f32) -> vec4f {
  let d = clamp(d_in, 0.0, 1.0);
  var enc = fract(vec3f(1.0, 255.0, 65025.0) * d);
  enc -= enc.yzz * vec3f(1.0 / 255.0, 1.0 / 255.0, 0.0);
  return vec4f(enc, 1.0);
}

@fragment
fn fragment_main(in: VertexOutput) -> FragmentOutput {
  var start = in.vColor;
  let backPosition = GetBackPosition(start);
  let dirVec = backPosition - start;
  var len = length(dirVec);
  let dir = dirVec / len;
  let texVox = vec3f(textureDimensions(volume, 0));
  let lenVox = length(dirVec * texVox);
  if (lenVox < 0.5 || len > 3.0) {
    discard;
    var dummy: FragmentOutput;
    return dummy;
  }
  // Save original ray for overlay passes (overlay ignores clip planes)
  let origStart = start;
  let origLen = len;
  let stepSize = len / lenVox;
  let deltaDir = vec4f(dir * stepSize, stepSize);
  var sampleRange = vec2f(0.0, len);
  let cutaway = params.isClipCutaway > 0.5;
  var hasClip = false;
  for (var i: i32 = 0; i < MAX_CLIP_PLANES; i++) {
    clipSampleRange(dir, vec4f(start, 0.0), params.clipPlanes[i], &sampleRange, &hasClip);
  }
  let isClip = (sampleRange.x > 0.0) || ((sampleRange.y < len) && (sampleRange.y > 0.0));
  // Check if clip plane configuration eliminates background entirely
  var skipBackground = false;
  if (cutaway) {
    if (hasClip && sampleRange.x <= 0.0 && sampleRange.y >= len) {
      skipBackground = true;
    }
  } else {
    if (sampleRange.x >= sampleRange.y) {
      skipBackground = true;
    }
  }
  // Shared values
  let ran = fract(sin(in.position.x * 12.9898 + in.position.y * 78.233) * 43758.5453);
  let stepSizeFast = stepSize * 1.9;
  let deltaDirFast = vec4f(dir * stepSizeFast, stepSizeFast);
  // --- Background depth pick ---
  var bgDepth = 1.0;  // far sentinel
  var bgHit = false;
  if (!skipBackground) {
    if (!cutaway && isClip) {
      start += dir * sampleRange.x;
      len = sampleRange.y - sampleRange.x;
    }
    var samplePos = vec4f(start + dir * (stepSize * ran), stepSize * ran);
    let samplePosStart = samplePos;
    // Fast pass
    for (var j: i32 = 0; j < 1024; j++) {
      if (samplePos.a > len) { break; }
      if (cutaway && isClip && samplePos.a >= sampleRange.x && samplePos.a <= sampleRange.y) {
        samplePos += deltaDirFast;
        continue;
      }
      let alpha = textureSampleLevel(volume, tex_sampler, samplePos.xyz, 0.0).a;
      if (alpha >= 0.01) { break; }
      samplePos += deltaDirFast;
    }
    if (samplePos.a >= len) {
      // Fast pass found nothing — use clip plane depth as fallback
      if (!cutaway && isClip) {
        bgDepth = frac2ndc(start);
        bgHit = true;
      }
    } else {
      // Retract and fine pass
      samplePos -= deltaDirFast;
      if (samplePos.a < 0.0) { samplePos = samplePosStart; }
      for (var fi: i32 = 0; fi < 2048; fi++) {
        if (samplePos.a > len) { break; }
        if (cutaway && isClip && samplePos.a >= sampleRange.x && samplePos.a <= sampleRange.y) {
          samplePos += deltaDir;
          continue;
        }
        let alpha = textureSampleLevel(volume, tex_sampler, samplePos.xyz, 0.0).a;
        if (alpha >= 0.01) {
          bgDepth = frac2ndc(samplePos.xyz);
          bgHit = true;
          break;
        }
        samplePos += deltaDir;
      }
      // If fine pass found nothing, use clip plane as fallback
      if (!bgHit && !cutaway && isClip) {
        bgDepth = frac2ndc(start);
        bgHit = true;
      }
    }
  }
  // --- Overlay depth pick (no clip plane) ---
  var overDepth = 1.0;
  var overHit = false;
  if (params.numVolumes > 1.0) {
    var overSamplePos = vec4f(origStart + dir * (stepSize * ran), stepSize * ran);
    let overSamplePosStart = overSamplePos;
    // Overlay fast pass
    for (var oj: i32 = 0; oj < 1024; oj++) {
      if (overSamplePos.a > origLen) { break; }
      let alpha = textureSampleLevel(overlay, tex_sampler, overSamplePos.xyz, 0.0).a;
      if (alpha >= 0.01) { break; }
      overSamplePos += deltaDirFast;
    }
    if (overSamplePos.a < origLen) {
      overSamplePos -= deltaDirFast;
      if (overSamplePos.a < 0.0) { overSamplePos = overSamplePosStart; }
      // Overlay fine pass
      for (var oi: i32 = 0; oi < 2048; oi++) {
        if (overSamplePos.a > origLen) { break; }
        let alpha = textureSampleLevel(overlay, tex_sampler, overSamplePos.xyz, 0.0).a;
        if (alpha >= 0.01) {
          overDepth = frac2ndc(overSamplePos.xyz);
          overHit = true;
          break;
        }
        overSamplePos += deltaDir;
      }
    }
  }
  // Output nearest depth from background or overlay
  if (!bgHit && !overHit) {
    discard;
    var dummy: FragmentOutput;
    return dummy;
  }
  var finalDepth = 1.0;
  if (bgHit && overHit) {
    finalDepth = min(bgDepth, overDepth);
  } else if (bgHit) {
    finalDepth = bgDepth;
  } else {
    finalDepth = overDepth;
  }
  var output: FragmentOutput;
  output.color = packDepth((finalDepth + 1.0) / 2.0);
  output.fragDepth = finalDepth;
  return output;
}
`

// --- Mesh depth-pick WGSL ---
// Same Params struct as mesh.wgsl, simple fragment that packs hardware depth.
const meshDepthPickWGSL = /* wgsl */ `
struct Params {
  mvpMtx: mat4x4f,
  normMtx: mat4x4f,
  clipPlane: vec4f,
  opacity: f32,
  _pad1: f32,
  _pad2: f32,
  _pad3: f32,
  crosscutMM: vec4f,
};

@group(0) @binding(0) var<uniform> params: Params;

struct VertexInput {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) color: vec4f,
};

struct VertexOutput {
  @builtin(position) position: vec4f,
};

@vertex
fn vertex_main(vert: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  out.position = params.mvpMtx * vec4f(vert.position, 1.0);
  return out;
}

fn packDepth(d_in: f32) -> vec4f {
  let d = clamp(d_in, 0.0, 1.0);
  var enc = fract(vec3f(1.0, 255.0, 65025.0) * d);
  enc -= enc.yzz * vec3f(1.0 / 255.0, 1.0 / 255.0, 0.0);
  return vec4f(enc, 1.0);
}

@fragment
fn fragment_main(in: VertexOutput) -> @location(0) vec4f {
  // gl_FragCoord.z is in [0,1] for WebGPU. Map to [0.5,1.0] for unprojectScreen.
  let packed = packDepth((in.position.z + 1.0) / 2.0);
  // alpha=0.5 signals "mesh" hit (volume uses alpha=1.0)
  return vec4f(packed.xyz, 0.5);
}
`

// --- Offscreen resources and pipelines ---

interface DepthPickResources {
  colorTexture: GPUTexture
  depthTexture: GPUTexture
  readbackBuffer: GPUBuffer
  volumePipeline: GPURenderPipeline | null
  meshPipeline: GPURenderPipeline | null
}

const _deviceCache = new WeakMap<GPUDevice, DepthPickResources>()

export function init(
  device: GPUDevice,
  volumeBindLayout: GPUBindGroupLayout | null,
  meshBindLayout: GPUBindGroupLayout | null,
): void {
  // 1x1 offscreen color target (rgba8unorm for packed depth)
  const colorTexture = device.createTexture({
    size: [1, 1],
    format: "rgba8unorm",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  })
  // 1x1 depth target (needed for proper depth testing between volume and meshes)
  const depthTexture = device.createTexture({
    size: [1, 1],
    format: "depth24plus",
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  })
  // Readback buffer: 4 bytes (one RGBA pixel), 256-byte aligned for mapAsync
  const readbackBuffer = device.createBuffer({
    size: 256,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })

  // Volume depth-pick pipeline (reuses volumeRenderer's bind group layout)
  let volumePipeline: GPURenderPipeline | null = null
  if (volumeBindLayout) {
    const shaderModule = device.createShaderModule({
      code: volumeShaderPreamble + volumeDepthPickFragment,
    })
    volumePipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [volumeBindLayout],
      }),
      vertex: {
        module: shaderModule,
        entryPoint: "vertex_main",
        buffers: [
          {
            arrayStride: 12,
            attributes: [
              {
                format: "float32x3" as GPUVertexFormat,
                offset: 0,
                shaderLocation: 0,
              },
            ],
          },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fragment_main",
        targets: [{ format: "rgba8unorm" as GPUTextureFormat }],
      },
      depthStencil: {
        depthWriteEnabled: true,
        depthCompare: "less",
        format: "depth24plus",
      },
      primitive: {
        topology: "triangle-strip",
        stripIndexFormat: "uint16",
        cullMode: "back",
      },
      multisample: { count: 1 },
    })
  }

  // Mesh depth-pick pipeline (reuses mesh bind group layout)
  let meshPipeline: GPURenderPipeline | null = null
  if (meshBindLayout) {
    const shaderModule = device.createShaderModule({ code: meshDepthPickWGSL })
    meshPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [meshBindLayout],
      }),
      vertex: {
        module: shaderModule,
        entryPoint: "vertex_main",
        buffers: [
          {
            arrayStride: 28,
            attributes: [
              {
                format: "float32x3" as GPUVertexFormat,
                offset: 0,
                shaderLocation: 0,
              },
              {
                format: "float32x3" as GPUVertexFormat,
                offset: 12,
                shaderLocation: 1,
              },
              {
                format: "unorm8x4" as GPUVertexFormat,
                offset: 24,
                shaderLocation: 2,
              },
            ],
          },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fragment_main",
        targets: [{ format: "rgba8unorm" as GPUTextureFormat }],
      },
      depthStencil: {
        depthWriteEnabled: true,
        depthCompare: "less",
        format: "depth24plus",
      },
      primitive: {
        topology: "triangle-list",
        cullMode: "back",
      },
      multisample: { count: 1 },
    })
  }

  _deviceCache.set(device, {
    colorTexture,
    depthTexture,
    readbackBuffer,
    volumePipeline,
    meshPipeline,
  })
}

export interface DepthPickDrawParams {
  device: GPUDevice
  // Volume
  volumeBindGroup: GPUBindGroup | null
  volumeVertexBuffer: GPUBuffer | null
  volumeIndexBuffer: GPUBuffer | null
  volumeIndexCount: number
  volumeParamsBuffer: GPUBuffer | null
  volumeUniformData: Float32Array | null
  // Meshes (array)
  meshes: {
    bindGroup: GPUBindGroup | null
    vertexBuffer: GPUBuffer | null
    indexBuffer: GPUBuffer | null
    indexCount: number
    uniformBuffer: GPUBuffer | null
    uniformData: Float32Array
    alignedSize: number
  }[]
}

export interface DepthPickResult {
  depth: number
  isMesh: boolean
}

export async function pick(
  params: DepthPickDrawParams,
): Promise<DepthPickResult | null> {
  const { device } = params
  const _resources = _deviceCache.get(device)
  if (!_resources) return null
  const {
    colorTexture,
    depthTexture,
    readbackBuffer,
    volumePipeline,
    meshPipeline,
  } = _resources

  const commandEncoder = device.createCommandEncoder()
  const pass = commandEncoder.beginRenderPass({
    colorAttachments: [
      {
        view: colorTexture.createView(),
        loadOp: "clear",
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        storeOp: "store",
      },
    ],
    depthStencilAttachment: {
      view: depthTexture.createView(),
      depthClearValue: 1.0,
      depthLoadOp: "clear",
      depthStoreOp: "store",
    },
  })
  pass.setViewport(0, 0, 1, 1, 0.0, 1.0)

  // Draw volume
  if (
    volumePipeline &&
    params.volumeBindGroup &&
    params.volumeVertexBuffer &&
    params.volumeIndexBuffer &&
    params.volumeParamsBuffer &&
    params.volumeUniformData
  ) {
    // Write uniforms at offset 0 (we use tileIndex=0 for the pick)
    device.queue.writeBuffer(
      params.volumeParamsBuffer,
      0,
      params.volumeUniformData as Float32Array<ArrayBuffer>,
    )
    pass.setPipeline(volumePipeline)
    pass.setBindGroup(0, params.volumeBindGroup, [0])
    pass.setVertexBuffer(0, params.volumeVertexBuffer)
    pass.setIndexBuffer(params.volumeIndexBuffer, "uint16")
    pass.drawIndexed(params.volumeIndexCount)
  }

  // Draw meshes
  if (meshPipeline) {
    for (const m of params.meshes) {
      if (!m.bindGroup || !m.vertexBuffer || !m.indexBuffer || !m.uniformBuffer)
        continue
      device.queue.writeBuffer(
        m.uniformBuffer,
        0,
        m.uniformData as Float32Array<ArrayBuffer>,
      )
      pass.setPipeline(meshPipeline)
      pass.setBindGroup(0, m.bindGroup, [0])
      pass.setVertexBuffer(0, m.vertexBuffer)
      pass.setIndexBuffer(m.indexBuffer, "uint32")
      pass.drawIndexed(m.indexCount)
    }
  }

  pass.end()

  // Copy 1x1 pixel to readback buffer
  commandEncoder.copyTextureToBuffer(
    { texture: colorTexture },
    { buffer: readbackBuffer, bytesPerRow: 256 },
    [1, 1],
  )
  device.queue.submit([commandEncoder.finish()])

  // Read back
  await readbackBuffer.mapAsync(GPUMapMode.READ)
  const data = new Uint8Array(readbackBuffer.getMappedRange(0, 4))
  const r = data[0]
  const g = data[1]
  const b = data[2]
  const a = data[3]
  readbackBuffer.unmap()

  if (a === 0) {
    log.debug("depthPick: miss (alpha=0)")
    return null
  }

  const depth = r / 255.0 + g / 65025.0 + b / 16581375.0
  // Volume writes alpha=1.0 (255), mesh writes alpha=0.5 (~128)
  const isMesh = a < 200
  log.debug(
    `depthPick: pixel=[${r},${g},${b},${a}] depth=${depth} isMesh=${isMesh}`,
  )
  return { depth, isMesh }
}

// Build a pick matrix that zooms the frustum so only the target pixel fills the 1x1 viewport.
// normalizedX/Y are [0,1] within the tile, tileW/H are tile dimensions in pixels.
export function buildPickMVP(
  normalizedX: number,
  normalizedY: number,
  tileW: number,
  tileH: number,
  mvpMatrix: mat4 | Float32Array,
): Float32Array {
  // NDC of the target pixel center
  const ndcX = normalizedX * 2 - 1
  const ndcY = 1 - normalizedY * 2 // WebGPU viewport Y is top-down, NDC Y is up

  // Pick matrix: scale(tileW, tileH, 1) * translate(-ndcX, -ndcY, 0)
  const pickMtx = mat4.create()
  mat4.translate(pickMtx, pickMtx, [-ndcX, -ndcY, 0])
  const scaleMtx = mat4.create()
  mat4.scale(scaleMtx, scaleMtx, [tileW, tileH, 1])
  mat4.multiply(pickMtx, scaleMtx, pickMtx)

  // pickMVP = pickMatrix * MVP
  const result = mat4.create()
  mat4.multiply(result, pickMtx, mvpMatrix as mat4)
  return result as Float32Array
}

export function destroy(device: GPUDevice): void {
  const res = _deviceCache.get(device)
  if (!res) return
  res.colorTexture.destroy()
  res.depthTexture.destroy()
  res.readbackBuffer.destroy()
  _deviceCache.delete(device)
}
