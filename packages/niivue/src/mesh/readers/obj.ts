import { maybeDecompress } from "@/codecs/NVGz";
import type { MZ3 } from "@/NVTypes";

declare const log: { warn: (...args: unknown[]) => void };

export const extensions = ["OBJ"];
export const type = "mz3";

function readOBJMNI(buffer: ArrayBuffer): MZ3 {
  const enc = new TextDecoder("utf-8");
  const txt = enc.decode(buffer);
  const items = txt.trim().split(/\s*,\s*|\s+/);
  if (items.length < 1 || items[0] !== "P") {
    log.warn("This is not a valid MNI OBJ mesh.");
  }
  let j = 6;
  const nVert = parseInt(items[j++], 10);
  const nVertX3 = nVert * 3;
  const positions = new Float32Array(nVertX3);
  for (let i = 0; i < nVertX3; i++) {
    positions[i] = parseFloat(items[j++]);
  }
  j += nVertX3;
  const nTri = parseInt(items[j++], 10);
  const colour_flag = parseInt(items[j++], 10);
  if (nTri < 1 || colour_flag < 0 || colour_flag > 2) {
    log.warn("This is not a valid MNI OBJ mesh.");
  }
  let num_c = 1;
  if (colour_flag === 1) {
    num_c = nTri;
  } else if (colour_flag === 2) {
    num_c = nVert;
  }
  j += num_c * 4;
  j += nTri;
  const nTriX3 = nTri * 3;
  const indices = new Uint32Array(nTriX3);
  for (let i = 0; i < nTriX3; i++) {
    indices[i] = parseInt(items[j++], 10);
  }
  return { positions, indices };
}

async function readOBJWavefront(buffer: ArrayBuffer): Promise<MZ3> {
  buffer = await maybeDecompress(buffer);
  const enc = new TextDecoder("utf-8");
  const txt = enc.decode(buffer);
  if (txt[0] === "P") {
    return readOBJMNI(buffer);
  }
  const lines = txt.split("\n");
  const pts: number[] = [];
  const tris: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const str = lines[i];
    if (str[0] === "v" && str[1] === " ") {
      const items = str.trim().split(/\s+/);
      pts.push(parseFloat(items[1]));
      pts.push(parseFloat(items[2]));
      pts.push(parseFloat(items[3]));
    }
    if (str[0] === "f") {
      const items = str.trim().split(/\s+/);
      const new_t = items.length - 3;
      if (new_t < 1) break;
      let tn = items[1].split("/");
      const t0 = parseInt(tn[0], 10) - 1;
      tn = items[2].split("/");
      let tprev = parseInt(tn[0], 10) - 1;
      for (let j = 0; j < new_t; j++) {
        tn = items[3 + j].split("/");
        const tcurr = parseInt(tn[0], 10) - 1;
        tris.push(t0, tprev, tcurr);
        tprev = tcurr;
      }
    }
  }
  const positions = new Float32Array(pts);
  const indices = new Uint32Array(tris);
  let min = indices[0];
  let max = indices[0];
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] < min) min = indices[i];
    if (indices[i] > max) max = indices[i];
  }
  if (max - min + 1 > positions.length / 3) {
    throw new Error("Not a valid OBJ file");
  }
  for (let i = 0; i < indices.length; i++) {
    indices[i] -= min;
  }
  return { positions, indices };
}

export async function read(buffer: ArrayBuffer): Promise<MZ3> {
  buffer = await maybeDecompress(buffer);
  const enc = new TextDecoder("utf-8");
  const txt = enc.decode(buffer);
  if (txt[0] === "P") {
    return readOBJMNI(buffer);
  }
  return readOBJWavefront(buffer);
}
