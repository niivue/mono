import * as nifti from "nifti-reader-js";
import { Zip } from "@/codecs/NVZip";
import { NiiDataType } from "@/NVConstants";
import type { NIFTI1, NIFTI2, TypedVoxelArray } from "@/NVTypes";

export const extensions = ["npy", "npz"];
export const type = "nii";

function getTypeSize(dtype: string): number {
  const typeMap: Record<string, number> = {
    "|b1": 1,
    "<i1": 1,
    "<u1": 1,
    "<i2": 2,
    "<u2": 2,
    "<i4": 4,
    "<u4": 4,
    "<f4": 4,
    "<f8": 8,
  };
  return typeMap[dtype] ?? 1;
}

function getDataTypeCode(dtype: string): number {
  const typeMap: Record<string, number> = {
    "|b1": NiiDataType.DT_BINARY,
    "<i1": NiiDataType.DT_INT8,
    "<u1": NiiDataType.DT_UINT8,
    "<i2": NiiDataType.DT_INT16,
    "<u2": NiiDataType.DT_UINT16,
    "<i4": NiiDataType.DT_INT32,
    "<u4": NiiDataType.DT_UINT32,
    "<f4": NiiDataType.DT_FLOAT32,
    "<f8": NiiDataType.DT_FLOAT64,
  };
  return typeMap[dtype] ?? NiiDataType.DT_FLOAT32;
}

function readNPYBuffer(buffer: ArrayBuffer): {
  hdr: NIFTI1 | NIFTI2;
  img: ArrayBuffer | TypedVoxelArray;
} {
  const dv = new DataView(buffer);
  const magicBytes = [
    dv.getUint8(0),
    dv.getUint8(1),
    dv.getUint8(2),
    dv.getUint8(3),
    dv.getUint8(4),
    dv.getUint8(5),
  ];
  const expectedMagic = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59];
  if (!magicBytes.every((byte, i) => byte === expectedMagic[i])) {
    throw new Error("Not a valid NPY file: Magic number mismatch");
  }
  const headerLen = dv.getUint16(8, true);
  const headerText = new TextDecoder("utf-8").decode(
    buffer.slice(10, 10 + headerLen),
  );
  const shapeMatch = headerText.match(/'shape': \((.*?)\)/);
  if (!shapeMatch) throw new Error("Invalid NPY header: Shape not found");
  const shape = shapeMatch[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .map(Number);
  const dtypeMatch = headerText.match(/'descr': '([^']+)'/);
  if (!dtypeMatch) throw new Error("Invalid NPY header: Data type not found");
  const dtype = dtypeMatch[1];
  const numElements = shape.reduce((a, b) => a * b, 1);
  const dataStart = 10 + headerLen;
  const dataBuffer = buffer.slice(
    dataStart,
    dataStart + numElements * getTypeSize(dtype),
  );
  const width = shape.length > 0 ? shape[shape.length - 1] : 1;
  const height = shape.length > 1 ? shape[shape.length - 2] : 1;
  const slices = shape.length > 2 ? shape[shape.length - 3] : 1;
  const hdr = new nifti.NIFTI1() as NIFTI1;
  hdr.dims = [3, width, height, slices, 0, 0, 0, 0];
  hdr.pixDims = [1, 1, 1, 1, 1, 0, 0, 0];
  hdr.affine = [
    [hdr.pixDims[1], 0, 0, -(hdr.dims[1] - 2) * 0.5 * hdr.pixDims[1]],
    [0, -hdr.pixDims[2], 0, (hdr.dims[2] - 2) * 0.5 * hdr.pixDims[2]],
    [0, 0, -hdr.pixDims[3], (hdr.dims[3] - 2) * 0.5 * hdr.pixDims[3]],
    [0, 0, 0, 1],
  ];
  hdr.numBitsPerVoxel = getTypeSize(dtype) * 8;
  hdr.datatypeCode = getDataTypeCode(dtype);
  return { hdr, img: dataBuffer };
}

export async function read(
  buffer: ArrayBuffer,
  _name?: string,
  _pairedImgData: ArrayBuffer | null = null,
): Promise<{ hdr: NIFTI1 | NIFTI2; img: ArrayBuffer | TypedVoxelArray }> {
  const dv = new DataView(buffer);
  const magicBytes = [
    dv.getUint8(0),
    dv.getUint8(1),
    dv.getUint8(2),
    dv.getUint8(3),
  ];
  const zipMagic = [0x50, 0x4b, 0x03, 0x04];
  const isZip = magicBytes.every((byte, i) => byte === zipMagic[i]);
  if (!isZip) {
    return readNPYBuffer(buffer);
  }
  const zip = new Zip(buffer);
  for (let i = 0; i < zip.entries.length; i++) {
    const entry = zip.entries[i];
    if (entry.fileName.toLowerCase().endsWith(".npy")) {
      const data = await entry.extract?.();
      if (!data) {
        throw new Error('Failed to extract .npy entry from NPZ archive');
      }
      return readNPYBuffer(data.buffer as ArrayBuffer);
    }
  }
  throw new Error("NPZ archive contains no .npy entries");
}
