import { log } from "@/logger";
import type { MZ3 } from "@/NVTypes";

export const extensions = ["ICO"];
export const type = "mz3";

export async function read(buffer: ArrayBuffer): Promise<MZ3> {
  // FreeSurfer can convert meshes to ICO/TRI format text files
  const enc = new TextDecoder("utf-8");
  const txt = enc.decode(buffer);
  const lines = txt.split("\n");
  let header = lines[0].trim().split(/\s+/);
  if (header.length > 1) {
    log.warn("This is not a valid FreeSurfer ICO/TRI mesh.");
  }
  const num_v = parseInt(header[0], 10);
  const positions = new Float32Array(num_v * 3);
  let line = 1;
  for (let i = 0; i < num_v; i++) {
    const items = lines[line].trim().split(/\s+/);
    line++;
    let idx = parseInt(items[0], 10) - 1;
    const x = parseFloat(items[1]);
    const y = parseFloat(items[2]);
    const z = parseFloat(items[3]);
    if (idx < 0 || idx >= num_v) {
      log.error("ICO vertices corrupted");
      break;
    }
    idx *= 3;
    positions[idx] = x;
    positions[idx + 1] = y;
    positions[idx + 2] = z;
  }
  header = lines[line].trim().split(/\s+/);
  line++;
  const num_f = parseInt(header[0], 10);
  const indices = new Uint32Array(num_f * 3);
  for (let i = 0; i < num_f; i++) {
    const items = lines[line].trim().split(/\s+/);
    line++;
    let idx = parseInt(items[0], 10) - 1;
    const x = parseInt(items[1], 10) - 1;
    const y = parseInt(items[2], 10) - 1;
    const z = parseInt(items[3], 10) - 1;
    if (idx < 0 || idx >= num_f) {
      log.error("ICO indices corrupted");
      break;
    }
    idx *= 3;
    indices[idx] = x;
    indices[idx + 1] = y;
    indices[idx + 2] = z;
  }
  for (let j = 0; j < indices.length; j += 3) {
    const tri = indices[j];
    indices[j] = indices[j + 1];
    indices[j + 1] = tri;
  }
  return {
    positions,
    indices,
  };
}
