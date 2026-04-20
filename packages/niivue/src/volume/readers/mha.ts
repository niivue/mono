import { mat3, vec3 } from "gl-matrix";
import * as nifti from "nifti-reader-js";
import { decompress } from "@/codecs/NVGz";
import { log } from "@/logger";
import { NiiDataType } from "@/NVConstants";
import type { NIFTI1, NIFTI2, TypedVoxelArray } from "@/NVTypes";

export const extensions = ["mha", "mhd"];
export const type = "nii";

export async function read(
  buffer: ArrayBuffer,
  _name?: string,
  pairedImgData: ArrayBuffer | null = null,
): Promise<{ hdr: NIFTI1 | NIFTI2; img: ArrayBuffer | TypedVoxelArray }> {
  const len = buffer.byteLength;
  if (len < 20) {
    throw new Error(`File too small to be MHA/MHD: bytes = ${len}`);
  }
  const bytes = new Uint8Array(buffer);
  let pos = 0;
  const eol = (c: number): boolean => c === 10 || c === 13;
  const readStr = (): string => {
    while (pos < len && eol(bytes[pos])) pos++;
    const startPos = pos;
    while (pos < len && !eol(bytes[pos])) pos++;
    if (pos - startPos < 2) return "";
    return new TextDecoder().decode(buffer.slice(startPos, pos));
  };

  let line = readStr();
  const hdr = new nifti.NIFTI1() as NIFTI1;
  hdr.pixDims = [1, 1, 1, 1, 1, 0, 0, 0];
  hdr.dims = [1, 1, 1, 1, 1, 1, 1, 1];
  hdr.littleEndian = true;
  let isGz = false;
  let isDetached = false;
  const mat33 = mat3.fromValues(NaN, 0, 0, 0, 1, 0, 0, 0, 1);
  const offset = vec3.fromValues(0, 0, 0);

  while (line !== "") {
    let items = line.split(" ");
    if (items.length > 2) items = items.slice(2);
    if (line.startsWith("BinaryDataByteOrderMSB") && items[0].includes("False"))
      hdr.littleEndian = true;
    if (line.startsWith("BinaryDataByteOrderMSB") && items[0].includes("True"))
      hdr.littleEndian = false;
    if (line.startsWith("CompressedData") && items[0].includes("True"))
      isGz = true;
    if (line.startsWith("TransformMatrix")) {
      for (let d = 0; d < 9; d++) mat33[d] = parseFloat(items[d]);
    }
    if (line.startsWith("Offset")) {
      for (let d = 0; d < Math.min(items.length, 3); d++)
        offset[d] = parseFloat(items[d]);
    }
    if (line.startsWith("ElementSpacing")) {
      for (let d = 0; d < items.length; d++)
        hdr.pixDims[d + 1] = parseFloat(items[d]);
    }
    if (line.startsWith("DimSize")) {
      hdr.dims[0] = items.length;
      for (let d = 0; d < items.length; d++)
        hdr.dims[d + 1] = parseInt(items[d], 10);
    }
    if (line.startsWith("ElementType")) {
      switch (items[0]) {
        case "MET_UCHAR":
          hdr.numBitsPerVoxel = 8;
          hdr.datatypeCode = NiiDataType.DT_UINT8;
          break;
        case "MET_CHAR":
          hdr.numBitsPerVoxel = 8;
          hdr.datatypeCode = NiiDataType.DT_INT8;
          break;
        case "MET_SHORT":
          hdr.numBitsPerVoxel = 16;
          hdr.datatypeCode = NiiDataType.DT_INT16;
          break;
        case "MET_USHORT":
          hdr.numBitsPerVoxel = 16;
          hdr.datatypeCode = NiiDataType.DT_UINT16;
          break;
        case "MET_INT":
          hdr.numBitsPerVoxel = 32;
          hdr.datatypeCode = NiiDataType.DT_INT32;
          break;
        case "MET_UINT":
          hdr.numBitsPerVoxel = 32;
          hdr.datatypeCode = NiiDataType.DT_UINT32;
          break;
        case "MET_FLOAT":
          hdr.numBitsPerVoxel = 32;
          hdr.datatypeCode = NiiDataType.DT_FLOAT32;
          break;
        case "MET_DOUBLE":
          hdr.numBitsPerVoxel = 64;
          hdr.datatypeCode = NiiDataType.DT_FLOAT64;
          break;
        default:
          throw new Error(`Unsupported MHA data type: ${items[0]}`);
      }
    }
    if (line.startsWith("ObjectType") && !items[0].includes("Image")) {
      log.warn(`Only able to read ObjectType = Image, not ${line}`);
    }
    if (line.startsWith("ElementDataFile")) {
      if (items[0] !== "LOCAL") isDetached = true;
      break;
    }
    line = readStr();
  }

  const mmMat = mat3.fromValues(
    hdr.pixDims[1],
    0,
    0,
    0,
    hdr.pixDims[2],
    0,
    0,
    0,
    hdr.pixDims[3],
  );
  mat3.multiply(mat33, mat33, mmMat);
  hdr.affine = [
    [-mat33[0], -mat33[3], -mat33[6], -offset[0]],
    [-mat33[1], -mat33[4], -mat33[7], -offset[1]],
    [mat33[2], mat33[5], mat33[8], offset[2]],
    [0, 0, 0, 1],
  ];

  while (bytes[pos] === 10) pos++;
  hdr.vox_offset = pos;

  let dataSection: ArrayBuffer;
  if (isDetached && pairedImgData) {
    dataSection = pairedImgData.slice(0);
  } else {
    dataSection = buffer.slice(hdr.vox_offset);
  }
  if (isGz) {
    const raw = await decompress(new Uint8Array(dataSection));
    dataSection = raw.buffer.slice(
      raw.byteOffset,
      raw.byteOffset + raw.byteLength,
    ) as ArrayBuffer;
  }

  return { hdr, img: dataSection };
}
