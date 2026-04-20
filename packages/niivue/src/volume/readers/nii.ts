import * as nifti from "nifti-reader-js";
import type { NIFTI1, NIFTI2, TypedVoxelArray } from "@/NVTypes";

export const extensions = ["nii", "nii.gz"];
export const type = "nii";

export async function read(
  buffer: ArrayBuffer,
  _name?: string,
  _pairedImgData: ArrayBuffer | null = null,
): Promise<{ hdr: NIFTI1 | NIFTI2; img: ArrayBuffer | TypedVoxelArray }> {
  const hdr = nifti.readHeader(buffer as ArrayBuffer) as
    | nifti.NIFTI1
    | nifti.NIFTI2;
  const imageBuffer = nifti.isCompressed(buffer as ArrayBuffer)
    ? nifti.decompress(buffer as ArrayBuffer)
    : buffer;
  const img = nifti.readImage(hdr, imageBuffer as ArrayBuffer) as ArrayBuffer;

  return {
    img: img,
    hdr: hdr as unknown as NIFTI1 | NIFTI2,
  };
}
