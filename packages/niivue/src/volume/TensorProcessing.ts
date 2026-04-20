/**
 * TensorProcessing module
 *
 * Handles diffusion tensor and vector field processing.
 * Provides explicit V1 vector conversion for formats (like AFNI) that lack
 * NIfTI intent codes for automatic detection.
 */

import { log } from "@/logger";
import { NiiDataType } from "@/NVConstants";
import type { NVImage } from "@/NVTypes";
import { convertFloat32RGBVector } from "./NVVolume";

/**
 * Convert a 3-frame float32 volume to V1 (eigenvector) RGBA representation,
 * with optional per-axis sign flips.
 *
 * Uses the same conversion as the automatic NIfTI intent_code 2003 path
 * (convertFloat32RGBVector), but works on already-loaded NVImage data for
 * formats like AFNI that lack intent codes.
 *
 * @param nvImage - The NVImage instance to convert in-place
 * @param isFlipX - Flip X component (default: false)
 * @param isFlipY - Flip Y component (default: false)
 * @param isFlipZ - Flip Z component (default: false)
 * @returns true if successful, false if V1 data is not available
 */
export function loadImgV1(
  nvImage: NVImage,
  isFlipX = false,
  isFlipY = false,
  isFlipZ = false,
): boolean {
  let v1 = nvImage.v1;
  if (!v1 && nvImage.nFrame4D === 3 && nvImage.img) {
    if (nvImage.img instanceof Float32Array) {
      v1 = nvImage.img.slice();
    }
  }
  if (!v1) {
    log.warn("Image does not have V1 data");
    return false;
  }
  // Apply optional axis flips before conversion
  if (isFlipX) {
    for (let i = 0; i < nvImage.nVox3D; i++) {
      v1[i] = -v1[i];
    }
  }
  if (isFlipY) {
    for (let i = nvImage.nVox3D; i < 2 * nvImage.nVox3D; i++) {
      v1[i] = -v1[i];
    }
  }
  if (isFlipZ) {
    for (let i = 2 * nvImage.nVox3D; i < 3 * nvImage.nVox3D; i++) {
      v1[i] = -v1[i];
    }
  }
  // Convert using shared RGBA encoding (handles slope/intercept, NaN, sign encoding)
  const result = convertFloat32RGBVector(nvImage.hdr, v1);
  // Apply converted header and image back to the volume
  nvImage.hdr = result.hdr;
  nvImage.img = result.img;
  nvImage.nFrame4D = 1;
  nvImage.dims = result.hdr.dims.slice(0, 4);
  // RGBA32 data: cal_min/cal_max are nominal (not used for colormap lookup)
  nvImage.cal_min = 0;
  nvImage.cal_max = 255;
  nvImage.robust_min = 0;
  nvImage.robust_max = 255;
  nvImage.global_min = 0;
  nvImage.global_max = 255;
  return true;
}
