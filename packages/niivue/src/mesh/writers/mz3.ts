import { compress } from "@/codecs/NVGz";

export const extensions = ["MZ3"];

export type MZ3WriteOptions = {
  compress?: boolean;
};

export async function write(
  positions: Float32Array,
  indices: Uint32Array,
  options?: MZ3WriteOptions,
): Promise<ArrayBuffer> {
  const nvert = positions.length / 3;
  const nface = indices.length / 3;
  // attr: 1 = faces, 2 = vertices
  const attr = 1 | 2;
  const headerBytes = 16;
  const faceBytes = nface * 3 * 4;
  const vertBytes = nvert * 3 * 4;
  const buffer = new ArrayBuffer(headerBytes + faceBytes + vertBytes);
  const view = new DataView(buffer);
  // Header: magic(2) + attr(2) + nface(4) + nvert(4) + nskip(4)
  view.setUint16(0, 23117, true); // magic
  view.setUint16(2, attr, true);
  view.setUint32(4, nface, true);
  view.setUint32(8, nvert, true);
  view.setUint32(12, 0, true); // nskip
  let offset = headerBytes;
  // Face indices
  for (let i = 0; i < nface * 3; i++) {
    view.setUint32(offset, indices[i], true);
    offset += 4;
  }
  // Vertex positions
  for (let i = 0; i < nvert * 3; i++) {
    view.setFloat32(offset, positions[i], true);
    offset += 4;
  }
  if (options?.compress) {
    const compressed = await compress(new Uint8Array(buffer));
    return compressed.buffer as ArrayBuffer;
  }
  return buffer;
}
