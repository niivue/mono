import { log } from "@/logger";
import type { MZ3 } from "@/NVTypes";

export const extensions = ["BYU", "GEO"];
export const type = "mz3";

function readGEO(buffer: ArrayBuffer, isFlipWinding = false): MZ3 {
  const enc = new TextDecoder("utf-8");
  const txt = enc.decode(buffer);
  const lines = txt.split("\n");
  const header = lines[0].trim().split(/\s+/);
  const num_p = parseInt(header[0], 10);
  let num_v = parseInt(header[1], 10);
  let num_f = parseInt(header[2], 10);
  const num_c = parseInt(header[3], 10);
  if (num_p > 1 || num_c !== num_f * 3) {
    log.warn("Multi-part BYU/GEO header or not a triangular mesh.");
  }
  const pts: number[] = [];
  num_v *= 3;
  let v = 0;
  let line = 2;
  while (v < num_v) {
    const items = lines[line].trim().split(/\s+/);
    line++;
    for (let i = 0; i < items.length; i++) {
      pts.push(parseFloat(items[i]));
      v++;
      if (v >= num_v) {
        break;
      }
    }
  }
  const t: number[] = [];
  num_f *= 3;
  let f = 0;
  while (f < num_f) {
    const items = lines[line].trim().split(/\s+/);
    line++;
    for (let i = 0; i < items.length; i++) {
      t.push(Math.abs(parseInt(items[i], 10)) - 1);
      f++;
      if (f >= num_f) {
        break;
      }
    }
  }
  if (isFlipWinding) {
    for (let j = 0; j < t.length; j += 3) {
      const tri = t[j];
      t[j] = t[j + 1];
      t[j + 1] = tri;
    }
  }
  const positions = new Float32Array(pts);
  const indices = new Uint32Array(t);
  return {
    positions,
    indices,
  };
}

export async function read(buffer: ArrayBuffer): Promise<MZ3> {
  return readGEO(buffer, true);
}
