import type { MZ3 } from "@/NVTypes";

export const extensions = ["STL"];
export const type = "mz3";

function readTxtSTL(buffer: ArrayBuffer): MZ3 {
  const enc = new TextDecoder("utf-8");
  const txt = enc.decode(buffer);
  const lines = txt.split("\n");
  if (!lines[0].startsWith("solid")) {
    throw new Error("Not a valid STL file");
  }
  const pts: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].includes("vertex")) {
      continue;
    }
    const items = lines[i].trim().split(/\s+/);
    for (let j = 1; j < items.length; j++) {
      pts.push(parseFloat(items[j]));
    }
  }
  const npts = Math.floor(pts.length / 3);
  if (npts * 3 !== pts.length) {
    throw new Error("Unable to parse ASCII STL file.");
  }
  const positions = new Float32Array(pts);
  const indices = new Uint32Array(npts);
  for (let i = 0; i < npts; i++) {
    indices[i] = i;
  }
  return {
    positions,
    indices,
  };
}

export async function read(buffer: ArrayBuffer): Promise<MZ3> {
  if (buffer.byteLength < 80 + 4 + 50) {
    throw new Error(`File too small to be STL: bytes = ${buffer.byteLength}`);
  }
  const reader = new DataView(buffer);
  const sig = reader.getUint32(0, true);
  if (sig === 1768714099) {
    return readTxtSTL(buffer);
  }
  const ntri = reader.getUint32(80, true);
  const ntri3 = 3 * ntri;
  if (buffer.byteLength < 80 + 4 + ntri * 50) {
    throw new Error(`STL file too small to store triangles = ${ntri}`);
  }
  const indices = new Uint32Array(ntri3);
  const positions = new Float32Array(ntri3 * 3);
  let pos = 80 + 4 + 12;
  let v = 0;
  for (let i = 0; i < ntri; i++) {
    for (let j = 0; j < 9; j++) {
      positions[v] = reader.getFloat32(pos, true);
      v += 1;
      pos += 4;
    }
    pos += 14;
  }
  for (let i = 0; i < ntri3; i++) {
    indices[i] = i;
  }
  return {
    positions,
    indices,
  };
}
