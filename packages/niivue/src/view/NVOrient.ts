import { COLORMAP_TYPE } from "@/NVConstants";
import type { NVImage } from "@/NVTypes";
import { reorientRGBA } from "@/volume/utils";

export function computeNegRange(nvimage: NVImage): {
  mnNeg: number;
  mxNeg: number;
} {
  let mnNeg = 0;
  let mxNeg = 0;
  if (nvimage.colormapNegative && nvimage.colormapNegative.length > 0) {
    mnNeg = Math.min(-nvimage.calMin, -nvimage.calMax);
    mxNeg = Math.max(-nvimage.calMin, -nvimage.calMax);
    const calMinNeg = nvimage.calMinNeg as number;
    const calMaxNeg = nvimage.calMaxNeg as number;
    if (Number.isFinite(calMinNeg) && Number.isFinite(calMaxNeg)) {
      mnNeg = Math.min(calMinNeg, calMaxNeg);
      mxNeg = Math.max(calMinNeg, calMaxNeg);
    }
  }
  return { mnNeg, mxNeg };
}

export type OrientUniforms = {
  slope: number;
  intercept: number;
  calMin: number;
  calMax: number;
  mnNeg: number;
  mxNeg: number;
  isAlphaThreshold: number;
  isColorbarFromZero: number;
  overlayOpacity: number;
  isLabel: number;
  labelMin: number;
  labelWidth: number;
};

/** Compute orient shader uniform values from an NVImage. Shared by both backends. */
export function buildOrientUniforms(
  nvimage: NVImage,
  overlayOpacity = 1,
): OrientUniforms {
  const { mnNeg, mxNeg } = computeNegRange(nvimage);
  const colormapType = nvimage.colormapType ?? 0;
  const isLabelVol =
    nvimage.colormapLabel !== null && nvimage.colormapLabel !== undefined;
  return {
    slope: nvimage.hdr.scl_slope,
    intercept: nvimage.hdr.scl_inter,
    calMin: nvimage.calMin,
    calMax: nvimage.calMax,
    mnNeg,
    mxNeg,
    isAlphaThreshold:
      colormapType === COLORMAP_TYPE.ZERO_TO_MAX_TRANSLUCENT_BELOW_MIN
        ? 1.0
        : 0.0,
    isColorbarFromZero: colormapType !== COLORMAP_TYPE.MIN_TO_MAX ? 1.0 : 0.0,
    overlayOpacity,
    isLabel: isLabelVol ? 1.0 : 0.0,
    labelMin: isLabelVol ? (nvimage.colormapLabel?.min ?? 0) : 0,
    labelWidth: isLabelVol ? (nvimage.colormapLabel?.lut?.length ?? 0) / 4 : 0,
  };
}

export function prepareRGBAData(nvimage: NVImage): {
  rgbaData: Uint8Array;
  texDims: number[];
} {
  if (!nvimage.img2RASstep || !nvimage.img2RASstart || !nvimage.dimsRAS) {
    throw new Error("prepareRGBAData: missing RAS mapping");
  }
  const dimsIn = [
    nvimage.dims[1] ?? 0,
    nvimage.dims[2] ?? 0,
    nvimage.dims[3] ?? 0,
  ];
  const dimsOut = [nvimage.dimsRAS[1], nvimage.dimsRAS[2], nvimage.dimsRAS[3]];
  const nVox3D = dimsIn[0] * dimsIn[1] * dimsIn[2];
  const isRAS =
    nvimage.img2RASstep[0] === 1 &&
    nvimage.img2RASstep[1] === nvimage.dimsRAS[1] &&
    nvimage.img2RASstep[2] === nvimage.dimsRAS[1] * nvimage.dimsRAS[2];

  const dt = nvimage.hdr.datatypeCode;
  if (!nvimage.img) {
    throw new Error("prepareRGBAData: nvimage.img is null");
  }
  const raw = new Uint8Array(
    nvimage.img.buffer,
    nvimage.img.byteOffset,
    nvimage.img.byteLength,
  );

  let rgbaData: Uint8Array;
  if (dt === 128) {
    // RGB: 3 bytes per voxel -> pad to RGBA
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
      const r = rgb[ridx] ?? 0;
      const g = rgb[ridx + 1] ?? 0;
      const b = rgb[ridx + 2] ?? 0;
      const a = Math.floor((r + g + b) / 3);
      rgbaData[didx] = r;
      rgbaData[didx + 1] = g;
      rgbaData[didx + 2] = b;
      rgbaData[didx + 3] = a;
    }
  } else if (dt === 2304) {
    // RGBA: 4 bytes per voxel
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
    throw new Error(`prepareRGBAData: NIfTI datatype ${dt} not RGB/RGBA`);
  }

  // Apply modulation if present (brightness/opacity scaled by another volume)
  const modData = nvimage._modulationData as Float32Array | null | undefined;
  if (modData) {
    const nVox = (isRAS ? dimsIn : dimsOut).reduce((a, b) => a * b, 1);
    const len = Math.min(nVox, modData.length);
    for (let i = 0; i < len; i++) {
      const m = modData[i];
      rgbaData[i * 4] = Math.round(rgbaData[i * 4] * m);
      rgbaData[i * 4 + 1] = Math.round(rgbaData[i * 4 + 1] * m);
      rgbaData[i * 4 + 2] = Math.round(rgbaData[i * 4 + 2] * m);
      // Alpha is NOT modulated — it may encode sign polarity bits (V1 vectors)
    }
  }

  const texDims = isRAS ? dimsIn : dimsOut;
  return { rgbaData, texDims };
}
