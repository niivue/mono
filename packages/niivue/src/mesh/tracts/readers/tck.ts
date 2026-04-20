import type { NVTractData } from "@/NVTypes";

export const extensions = ["TCK"];

/**
 * Read MRtrix TCK (tracks) format.
 * https://mrtrix.readthedocs.io/en/latest/getting_started/image_data.html#tracks-file-format-tck
 *
 * Points are already in mm space — no transformation needed.
 * NaN marks streamline boundaries, Infinity marks EOF.
 */
export async function read(buffer: ArrayBufferLike): Promise<NVTractData> {
  const len = buffer.byteLength;
  if (len < 20) throw new Error("File too small to be TCK");
  const bytes = new Uint8Array(buffer);
  let pos = 0;

  function readLine(): string {
    while (pos < len && bytes[pos] === 10) pos++; // skip blank lines
    const start = pos;
    while (pos < len && bytes[pos] !== 10) pos++;
    pos++; // skip newline
    return new TextDecoder().decode(buffer.slice(start, pos - 1));
  }

  // Parse header
  const sig = readLine();
  if (!sig.includes("mrtrix tracks")) throw new Error("Not a valid TCK file");

  let dataOffset = -1;
  let line = "";
  while (pos < len && !line.includes("END")) {
    line = readLine();
    if (line.toLowerCase().startsWith("file:")) {
      dataOffset = parseInt(line.split(" ").pop()!, 10);
    }
  }
  if (dataOffset < 20)
    throw new Error("Not a valid TCK file (missing file offset)");

  // Parse binary data
  const reader = new DataView(buffer as ArrayBuffer);
  pos = dataOffset;
  // Over-provision arrays
  let vertices = new Float32Array(len / 4);
  let offsets = new Uint32Array(len / (4 * 4));
  let npt = 0;
  let npt3 = 0;
  let noffset = 0;
  offsets[0] = 0;

  while (pos + 12 <= len) {
    const x = reader.getFloat32(pos, true);
    pos += 4;
    const y = reader.getFloat32(pos, true);
    pos += 4;
    const z = reader.getFloat32(pos, true);
    pos += 4;
    if (!Number.isFinite(x)) {
      // NaN = streamline boundary, Infinity = EOF
      offsets[noffset++] = npt;
      if (!Number.isNaN(x)) break; // Infinity = end of file
    } else {
      vertices[npt3++] = x;
      vertices[npt3++] = y;
      vertices[npt3++] = z;
      npt++;
    }
  }

  // Trim over-provisioned arrays
  vertices = vertices.slice(0, npt3);
  offsets = offsets.slice(0, noffset);

  return {
    vertices,
    offsets,
    dpv: {},
    dps: {},
    groups: {},
    dpvMeta: {},
    dpsMeta: {},
  };
}
