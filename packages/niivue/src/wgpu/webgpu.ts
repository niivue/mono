import type { NVImage } from "@/NVTypes";
import { reorientRGBA } from "@/volume/utils";
import volume2rgbaWGSL from "./orient.wgsl?raw";
import * as wgpu from "./wgpu";

type PipelineCacheEntry = {
  pipeline: GPUComputePipeline;
  layout: GPUBindGroupLayout;
};
const _deviceCache = new WeakMap<
  GPUDevice,
  Record<string, PipelineCacheEntry>
>();

function ensureVolume2RGBAPipeline(
  device: GPUDevice,
  pipelineType: string,
): PipelineCacheEntry {
  let perDevice = _deviceCache.get(device);
  if (!perDevice) {
    perDevice = {};
    _deviceCache.set(device, perDevice);
  }
  if (perDevice[pipelineType]) {
    return perDevice[pipelineType];
  }
  let shaderSource = volume2rgbaWGSL;
  let sampleType: GPUTextureSampleType = "uint";
  if (pipelineType === "float") {
    shaderSource = shaderSource.replaceAll(
      "texture_3d<u32>",
      "texture_3d<f32>",
    );
    sampleType = "unfilterable-float";
  } else if (pipelineType === "sint") {
    shaderSource = shaderSource.replaceAll(
      "texture_3d<u32>",
      "texture_3d<i32>",
    );
    sampleType = "sint";
  }
  const module = device.createShaderModule({ code: shaderSource });
  const layout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "uniform" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        texture: {
          sampleType: sampleType,
          viewDimension: "3d",
        },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        texture: { viewDimension: "2d" },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: { format: "rgba8unorm", viewDimension: "3d" },
      },
      {
        binding: 4,
        visibility: GPUShaderStage.COMPUTE,
        sampler: { type: "filtering" },
      },
    ],
  });
  const pipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    compute: { module, entryPoint: "main" },
  });
  perDevice[pipelineType] = { pipeline, layout };
  return perDevice[pipelineType];
}

function rgba2Texture(device: GPUDevice, nvimage: NVImage): GPUTexture {
  if (!nvimage.dimsRAS || !nvimage.img2RASstep || !nvimage.img2RASstart) {
    throw new Error("rgba2Texture: missing RAS info");
  }
  const isRAS =
    nvimage.img2RASstep[0] === 1 &&
    nvimage.img2RASstep[1] === nvimage.dimsRAS[1] &&
    nvimage.img2RASstep[2] === nvimage.dimsRAS[1] * nvimage.dimsRAS[2];
  const dimsIn = [nvimage.dims[1], nvimage.dims[2], nvimage.dims[3]];
  const dimsOut = [nvimage.dimsRAS[1], nvimage.dimsRAS[2], nvimage.dimsRAS[3]];
  const nVox3D = dimsIn[0] * dimsIn[1] * dimsIn[2];
  const dt = nvimage.hdr.datatypeCode;
  if (!nvimage.img) {
    throw new Error("rgba2Texture: missing image data");
  }
  const raw = new Uint8Array(
    nvimage.img.buffer,
    nvimage.img.byteOffset,
    nvimage.img.byteLength,
  );
  let rgbaData: Uint8Array;
  // RGB (DT = 128) with 3 bytes per voxel -> pad to 4
  if (dt === 128 && nvimage.img.byteLength === nVox3D * 3) {
    const rgb = isRAS
      ? raw
      : reorientRGBA(
          raw,
          3,
          nvimage.dimsRAS,
          nvimage.img2RASstart,
          nvimage.img2RASstep,
        );
    const nVoxOut = isRAS ? nVox3D : dimsOut[0] * dimsOut[1] * dimsOut[2];
    rgbaData = new Uint8Array(nVoxOut * 4);
    for (
      let i = 0, ridx = 0, didx = 0;
      i < nVoxOut;
      ++i, ridx += 3, didx += 4
    ) {
      const r = rgb[ridx];
      const g = rgb[ridx + 1];
      const b = rgb[ridx + 2];
      const a = Math.floor((r + g + b) / 3);
      rgbaData[didx] = r;
      rgbaData[didx + 1] = g;
      rgbaData[didx + 2] = b;
      rgbaData[didx + 3] = a;
    }
    // RGBA (DT = 2304) with 4 bytes per voxel
  } else if (dt === 2304 && raw.byteLength === nVox3D * 4) {
    rgbaData = isRAS
      ? raw
      : reorientRGBA(
          raw,
          4,
          nvimage.dimsRAS,
          nvimage.img2RASstart,
          nvimage.img2RASstep,
        );
  } else {
    throw new Error(
      `Unexpected size or datatype for NIfTI RGB/RGBA (expected ${nVox3D * 3} or ${nVox3D * 4} bytes).`,
    );
  }
  const texDims = isRAS ? dimsIn : dimsOut;
  const rgbaTexture = device.createTexture({
    size: texDims,
    format: "rgba8unorm",
    dimension: "3d",
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC,
  });
  device.queue.writeTexture(
    { texture: rgbaTexture },
    new Uint8Array(rgbaData),
    { bytesPerRow: texDims[0] * 4, rowsPerImage: texDims[1] },
    texDims,
  );
  return rgbaTexture;
}

export async function volume2Texture(
  device: GPUDevice,
  nvimage: NVImage,
): Promise<GPUTexture> {
  if (!nvimage.dimsRAS || !nvimage.img2RASstart || !nvimage.img2RASstep) {
    throw new Error("volume2Texture: missing RAS mapping");
  }
  if (!nvimage.img) {
    throw new Error("volume2Texture: missing image data");
  }
  const dt = nvimage.hdr.datatypeCode;
  let format: GPUTextureFormat = "r8uint";
  let pipelineType = "uint";
  let bytesPerVoxel = 1;
  if (dt === 2) {
    // UINT8
    format = "r8uint";
  } else if (dt === 4 || dt === 8) {
    // INT16 or INT32
    format = dt === 4 ? "r16sint" : "r32sint";
    pipelineType = "sint";
    bytesPerVoxel = dt === 4 ? 2 : 4;
  } else if (dt === 16 || dt === 32) {
    // FLOAT32 or COMPLEX
    format = "r32float";
    pipelineType = "float";
    bytesPerVoxel = 4;
  } else if (dt === 512 || dt === 768) {
    // UINT16 or UINT32
    format = dt === 512 ? "r16uint" : "r32uint";
    bytesPerVoxel = dt === 512 ? 2 : 4;
  } else if (dt === 2304 || dt === 128) {
    return rgba2Texture(device, nvimage);
  } else {
    throw new Error(`Unsupported NIfTI datatype ${dt}`);
  }
  const dimsIn = [nvimage.dims[1], nvimage.dims[2], nvimage.dims[3]];
  const dimsOut = [nvimage.dimsRAS[1], nvimage.dimsRAS[2], nvimage.dimsRAS[3]];
  const [vxIn, vyIn, vzIn] = dimsIn;
  const [vxOut, vyOut, vzOut] = dimsOut;
  const cached = ensureVolume2RGBAPipeline(device, pipelineType);
  const scalarTexture = device.createTexture({
    size: dimsIn,
    format: format,
    dimension: "3d",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const imgData = new Uint8Array(
    nvimage.img.buffer,
    nvimage.img.byteOffset,
    nvimage.img.byteLength,
  );
  const imgUpload = new Uint8Array(imgData);
  device.queue.writeTexture(
    { texture: scalarTexture },
    imgUpload,
    {
      bytesPerRow: Math.floor(dimsIn[0] * bytesPerVoxel),
      rowsPerImage: dimsIn[1],
    },
    dimsIn,
  );
  // 2) Prepare uniform buffer
  const uniformBufferSize = 16 * 4;
  const uniformBuffer = device.createBuffer({
    size: uniformBufferSize,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  // Build an ArrayBuffer and fill with start/step/dims/params
  const ab = new ArrayBuffer(uniformBufferSize);
  const dv = new DataView(ab);
  // Helper to set int32 vec4 at byteOffset
  function setVec4i32(offsetBytes: number, arr: number[]): void {
    dv.setInt32(offsetBytes + 0, arr[0], true);
    dv.setInt32(offsetBytes + 4, arr[1], true);
    dv.setInt32(offsetBytes + 8, arr[2], true);
    dv.setInt32(offsetBytes + 12, 0, true); // pad
  }
  // Helper to set float32 vec4 at byteOffset
  function setVec4f32(offsetBytes: number, arr: number[]): void {
    dv.setFloat32(offsetBytes + 0, arr[0], true);
    dv.setFloat32(offsetBytes + 4, arr[1], true);
    dv.setFloat32(offsetBytes + 8, arr[2], true);
    dv.setFloat32(offsetBytes + 12, arr[3], true);
  }
  const start = nvimage.img2RASstart;
  const step = nvimage.img2RASstep;
  setVec4i32(0, start);
  setVec4i32(16, step);
  setVec4i32(32, [vxIn, vyIn, vzIn]); // dims
  const slope = nvimage.hdr.scl_slope;
  const inter = nvimage.hdr.scl_inter;
  const calmin = nvimage.calMin;
  const calmax = nvimage.calMax;
  setVec4f32(48, [slope, inter, calmin, calmax]);
  // Upload uniform buffer content
  device.queue.writeBuffer(uniformBuffer, 0, ab);
  // 3) Create RGBA storage texture sized dimsOut (this is what we will return)
  const rgbaTexture = device.createTexture({
    size: dimsOut,
    format: "rgba8unorm",
    dimension: "3d",
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.COPY_SRC,
  });
  // 4) Colormap texture and sampler
  // const colormapTex = await wgpu.lut2texture(device, lutName)
  const lut = (nvimage.gpu as { lut?: Uint8ClampedArray } | undefined)?.lut;
  if (!lut) {
    throw new Error("volume2Texture: missing LUT");
  }
  const colormapTex = await wgpu.lutBytes2texture(device, lut);
  const sampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
  });
  // 5) Create bind group
  const bindGroup = device.createBindGroup({
    layout: cached.layout,
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: scalarTexture.createView() },
      { binding: 2, resource: colormapTex.createView() },
      { binding: 3, resource: rgbaTexture.createView() },
      { binding: 4, resource: sampler },
    ],
  });
  // 6) Dispatch compute with dimsOut
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(cached.pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(
    Math.ceil(vxOut / 8),
    Math.ceil(vyOut / 8),
    Math.ceil(vzOut / 4),
  );
  pass.end();
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  // Cleanup intermediate resources (keep rgbaTexture for caller)
  scalarTexture.destroy();
  colormapTex.destroy();
  uniformBuffer.destroy();
  return rgbaTexture;
}

export function destroy(device: GPUDevice): void {
  _deviceCache.delete(device);
}
