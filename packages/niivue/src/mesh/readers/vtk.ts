import { maybeDecompress } from "@/codecs/NVGz";
import { log } from "@/logger";
import type { MZ3, NVTractData } from "@/NVTypes";

export const extensions = ["VTK"];
export const type = "mz3";

function readTxtVTK(buffer: ArrayBuffer): MZ3 {
  const txt = new TextDecoder("utf-8").decode(buffer);
  const lines = txt.split(/\r?\n/);
  let lineIdx = 0;
  function readLine(skipBlank = true): string | null {
    while (lineIdx < lines.length) {
      const line = lines[lineIdx++];
      if (skipBlank && line.trim() === "") {
        continue;
      }
      return line;
    }
    return null;
  }
  let line = readLine(true);
  if (!line?.startsWith("# vtk DataFile")) {
    throw new Error("Invalid VTK mesh");
  }
  readLine(false); // comment line
  line = readLine(true);
  if (!line?.startsWith("ASCII")) {
    throw new Error("Invalid VTK mesh, expected ASCII");
  }
  line = readLine(true);
  if (!line?.includes("POLYDATA")) {
    throw new Error("Only able to read VTK POLYDATA");
  }
  line = readLine(true);
  if (!line?.includes("POINTS")) {
    throw new Error("Invalid VTK mesh, expected POINTS");
  }
  const items = line.trim().split(/\s+/);
  const nvert = parseInt(items[1], 10);
  if (!Number.isFinite(nvert) || nvert < 1) {
    throw new Error("Invalid VTK mesh");
  }
  const positions = new Float32Array(nvert * 3);
  let v = 0;
  while (v < positions.length) {
    line = readLine(true);
    if (!line) {
      throw new Error("Invalid VTK mesh");
    }
    const vals = line.trim().split(/\s+/);
    for (let i = 0; i < vals.length && v < positions.length; i++) {
      positions[v++] = parseFloat(vals[i]);
    }
  }
  line = readLine(true);
  if (!line) {
    throw new Error("Invalid VTK mesh");
  }
  const header = line.trim().split(/\s+/);
  const section = header[0];
  const tris: number[] = [];
  let tokenBuf: string[] = [];
  function nextNumber(): number {
    while (tokenBuf.length === 0) {
      const l = readLine(true);
      if (!l) {
        throw new Error("Invalid VTK mesh");
      }
      tokenBuf = l.trim().split(/\s+/).filter(Boolean);
    }
    const tok = tokenBuf.shift();
    return tok ? parseFloat(tok) : NaN;
  }
  if (section.includes("POLYGONS")) {
    const npoly = parseInt(header[1], 10);
    for (let i = 0; i < npoly; i++) {
      const n = nextNumber();
      if (!Number.isFinite(n) || n < 3) {
        continue;
      }
      const first = nextNumber();
      let prev = nextNumber();
      for (let t = 0; t < n - 2; t++) {
        const curr = nextNumber();
        tris.push(first, prev, curr);
        prev = curr;
      }
    }
  } else if (section.includes("TRIANGLE_STRIPS")) {
    const nstrip = parseInt(header[1], 10);
    for (let i = 0; i < nstrip; i++) {
      const n = nextNumber();
      if (!Number.isFinite(n) || n < 3) {
        continue;
      }
      let idx0 = nextNumber();
      let idx1 = nextNumber();
      for (let t = 0; t < n - 2; t++) {
        const idx2 = nextNumber();
        if (t % 2) {
          tris.push(idx2, idx1, idx0);
        } else {
          tris.push(idx0, idx1, idx2);
        }
        idx0 = idx1;
        idx1 = idx2;
      }
    }
  } else if (section.includes("LINES")) {
    throw new Error("VTK LINES not supported for mesh importer");
  } else {
    throw new Error(`Unsupported ASCII VTK datatype ${section}`);
  }
  return { positions, indices: new Uint32Array(tris) };
}

export async function read(buffer: ArrayBuffer): Promise<MZ3> {
  buffer = await maybeDecompress(buffer);
  const len = buffer.byteLength;
  if (len < 20) {
    throw new Error(`File too small to be VTK: bytes = ${buffer.byteLength}`);
  }
  const bytes = new Uint8Array(buffer);
  let pos = 0;
  function readStr(isSkipBlank = true): string {
    if (isSkipBlank) {
      while (pos < len && bytes[pos] === 10) {
        pos++;
      }
    } // skip blank lines
    const startPos = pos;
    while (pos < len && bytes[pos] !== 10) {
      pos++;
    }
    pos++; // skip EOLN
    if (pos - startPos < 1) {
      return "";
    }
    return new TextDecoder().decode(buffer.slice(startPos, pos - 1));
  }
  let line = readStr(); // 1st line: signature
  if (!line.startsWith("# vtk DataFile")) {
    throw new Error("Invalid VTK mesh");
  }
  line = readStr(false); // 2nd line comment, n.b. MRtrix stores empty line
  line = readStr(); // 3rd line ASCII/BINARY
  if (line.startsWith("ASCII")) {
    return readTxtVTK(buffer);
  } else if (!line.startsWith("BINARY")) {
    throw new Error(`Invalid VTK image, expected ASCII or BINARY ${line}`);
  }
  line = readStr(); // 5th line "DATASET POLYDATA"
  if (!line.includes("POLYDATA")) {
    throw new Error(`Only able to read VTK POLYDATA ${line}`);
  }
  line = readStr(); // 6th line "POINTS 10261 float"
  if (
    !line.includes("POINTS") ||
    (!line.includes("double") && !line.includes("float"))
  ) {
    log.warn(`Only able to read VTK float or double POINTS${line}`);
  }
  const isFloat64 = line.includes("double");
  let items = line.trim().split(/\s+/);
  const nvert = parseInt(items[1], 10); // POINTS 10261 float
  const nvert3 = nvert * 3;
  const positions = new Float32Array(nvert3);
  const reader = new DataView(buffer);
  if (isFloat64) {
    for (let i = 0; i < nvert3; i++) {
      positions[i] = reader.getFloat64(pos, false);
      pos += 8;
    }
  } else {
    for (let i = 0; i < nvert3; i++) {
      positions[i] = reader.getFloat32(pos, false);
      pos += 4;
    }
  }
  line = readStr(); // Type, "LINES 11885 "
  items = line.trim().split(/\s+/);
  const tris: number[] = [];
  if (items[0].includes("LINES")) {
    throw new Error("VTK LINES not supported for mesh importer");
  } else if (items[0].includes("TRIANGLE_STRIPS")) {
    const nstrip = parseInt(items[1], 10);
    for (let i = 0; i < nstrip; i++) {
      const ntri = reader.getInt32(pos, false) - 2; // -2 as triangle strip is creates pts - 2 faces
      pos += 4;
      for (let t = 0; t < ntri; t++) {
        if (t % 2) {
          // preserve winding order
          tris.push(reader.getInt32(pos + 8, false));
          tris.push(reader.getInt32(pos + 4, false));
          tris.push(reader.getInt32(pos, false));
        } else {
          tris.push(reader.getInt32(pos, false));
          tris.push(reader.getInt32(pos + 4, false));
          tris.push(reader.getInt32(pos + 8, false));
        }
        pos += 4;
      } // for each triangle
      pos += 8;
    } // for each strip
  } else if (items[0].includes("POLYGONS")) {
    const npoly = parseInt(items[1], 10);
    const byteOffsetAfterPoly = pos;
    const maybeOffsetsLine = readStr();
    if (maybeOffsetsLine.startsWith("OFFSETS")) {
      let isInt64 = maybeOffsetsLine.includes("int64");
      const offset = new Uint32Array(npoly);
      let is32bitOverflow = false;
      for (let i = 0; i < npoly; i++) {
        if (isInt64) {
          if (reader.getInt32(pos, false) !== 0) {
            is32bitOverflow = true;
          }
          pos += 4;
        } // skip high 32 bits
        offset[i] = reader.getInt32(pos, false);
        pos += 4;
      }
      if (
        !Number.isSafeInteger(npoly) ||
        npoly >= 2147483648 ||
        is32bitOverflow
      ) {
        throw new Error(`values exceed 2GB limit`);
      }
      const connLine = readStr();
      if (!connLine.startsWith("CONNECTIVITY")) {
        throw new Error("Expected CONNECTIVITY after OFFSETS");
      }
      isInt64 = connLine.includes("int64");
      const numIndices = offset[npoly - 1];
      const connectivity = new Uint32Array(numIndices);
      for (let i = 0; i < numIndices; i++) {
        if (isInt64) {
          pos += 4;
        }
        connectivity[i] = reader.getInt32(pos, false);
        pos += 4;
      }
      for (let i = 0; i < npoly; i++) {
        const start = i === 0 ? 0 : offset[i - 1];
        const end = offset[i];
        for (let t = 1; t < end - start - 1; t++) {
          tris.push(connectivity[start]);
          tris.push(connectivity[start + t]);
          tris.push(connectivity[start + t + 1]);
        }
      }
    } else {
      // Classic binary VTK format: rewind and parse as before
      pos = byteOffsetAfterPoly;
      for (let i = 0; i < npoly; i++) {
        const ntri = reader.getInt32(pos, false) - 2;
        if (i === 0 && ntri > 65535) {
          throw new Error(
            "Invalid VTK binary polygons using little-endian data (MRtrix)",
          );
        }
        pos += 4;
        const fx = reader.getInt32(pos, false);
        pos += 4;
        let fy = reader.getInt32(pos, false);
        pos += 4;
        for (let t = 0; t < ntri; t++) {
          const fz = reader.getInt32(pos, false);
          pos += 4;
          tris.push(fx, fy, fz);
          fy = fz;
        }
      }
    }
  } else {
    throw new Error(`Unsupported binary VTK datatype ${items[0]}`);
  }
  const indices = new Uint32Array(tris);
  return {
    positions,
    indices,
  };
}

/**
 * Probe a decompressed VTK buffer to determine if it contains
 * triangulated mesh data (POLYGONS/TRIANGLE_STRIPS) or streamlines (LINES).
 */
export function probeVTKContent(buffer: ArrayBuffer): "mesh" | "tract" {
  const len = buffer.byteLength;
  if (len < 20) return "mesh";
  const bytes = new Uint8Array(buffer);
  let pos = 0;
  function nextLine(skipBlank = true): string {
    if (skipBlank) {
      while (pos < len && bytes[pos] === 10) pos++;
    }
    const start = pos;
    while (pos < len && bytes[pos] !== 10) pos++;
    pos++;
    return start < pos
      ? new TextDecoder().decode(buffer.slice(start, pos - 1))
      : "";
  }
  let line = nextLine();
  if (!line.startsWith("# vtk DataFile")) return "mesh";
  nextLine(false); // comment
  line = nextLine(); // ASCII or BINARY
  const isAscii = line.startsWith("ASCII");
  if (!isAscii && !line.startsWith("BINARY")) return "mesh";
  nextLine(); // DATASET POLYDATA
  line = nextLine(); // POINTS nvert type
  if (!line.includes("POINTS")) return "mesh";
  const items = line.trim().split(/\s+/);
  const nvert = parseInt(items[1], 10) || 0;
  if (isAscii) {
    // Skip past ASCII point coordinates
    let v = 0;
    while (v < nvert * 3 && pos < len) {
      const l = nextLine(true);
      if (!l) break;
      v += l.trim().split(/\s+/).length;
    }
    // Skip METADATA if present
    line = nextLine(true);
    if (line.startsWith("METADATA")) {
      while (pos < len) {
        line = nextLine(false);
        if (!line || line.trim() === "") break;
      }
      line = nextLine(true);
    }
  } else {
    // Skip past binary point data
    const bytesPerVal = line.includes("double") ? 8 : 4;
    pos += nvert * 3 * bytesPerVal;
    line = nextLine();
  }
  return line.includes("LINES") ? "tract" : "mesh";
}

/** Parse ASCII VTK LINES into NVTractData. */
function readTxtVTKLines(buffer: ArrayBuffer): NVTractData {
  const txt = new TextDecoder("utf-8").decode(buffer);
  const lines = txt.split(/\r?\n/);
  let lineIdx = 0;
  function readLine(skipBlank = true): string | null {
    while (lineIdx < lines.length) {
      const line = lines[lineIdx++];
      if (skipBlank && line.trim() === "") continue;
      return line;
    }
    return null;
  }
  readLine(true); // # vtk DataFile
  readLine(false); // comment
  readLine(true); // ASCII
  readLine(true); // DATASET POLYDATA
  const pointsLine = readLine(true);
  if (!pointsLine?.includes("POINTS")) {
    throw new Error("Invalid VTK LINES: expected POINTS");
  }
  const pItems = pointsLine.trim().split(/\s+/);
  const nvert = parseInt(pItems[1], 10);
  const positions = new Float32Array(nvert * 3);
  let v = 0;
  while (v < positions.length) {
    const line = readLine(true);
    if (!line) break;
    const vals = line.trim().split(/\s+/);
    for (let i = 0; i < vals.length && v < positions.length; i++) {
      positions[v++] = parseFloat(vals[i]);
    }
  }
  // Skip METADATA if present
  let line = readLine(true);
  if (line?.startsWith("METADATA")) {
    while (lineIdx < lines.length) {
      line = readLine(false);
      if (!line || line.trim() === "") break;
    }
    line = readLine(true);
  }
  if (!line?.includes("LINES")) {
    throw new Error("Invalid VTK: expected LINES section");
  }
  const header = line.trim().split(/\s+/);
  const nCount = parseInt(header[1], 10);
  if (nCount < 1) throw new Error("Corrupted VTK ASCII LINES");

  // Read next data line to check for OFFSETS style
  const dataLine = readLine(true);
  if (!dataLine) throw new Error("Invalid VTK LINES data");

  if (dataLine.startsWith("OFFSETS")) {
    // New OFFSETS style: offset array indexes directly into positions
    const offsets = new Uint32Array(nCount + 1);
    let c = 0;
    while (c < nCount) {
      const l = readLine(true);
      if (!l) break;
      const vals = l.trim().split(/\s+/);
      for (let i = 0; i < vals.length && c < nCount; i++) {
        offsets[c++] = parseInt(vals[i], 10);
      }
    }
    offsets[nCount] = nvert; // fence-post: total vertex count
    return {
      vertices: positions,
      offsets,
      dpv: {},
      dps: {},
      groups: {},
      dpvMeta: {},
      dpsMeta: {},
    };
  }

  // Classic style: dataLine is the first data line with numPoints + indices
  let asciiInts = dataLine
    .trim()
    .split(/\s+/)
    .map((s) => parseInt(s, 10));
  let asciiIntsPos = 0;
  function nextInt(): number {
    while (asciiIntsPos >= asciiInts.length) {
      const l = readLine(true);
      if (!l) throw new Error("Invalid VTK LINES data");
      asciiInts = l
        .trim()
        .split(/\s+/)
        .map((s) => parseInt(s, 10));
      asciiIntsPos = 0;
    }
    return asciiInts[asciiIntsPos++];
  }
  let npt = 0;
  const offsetArr: number[] = [0];
  const pts: number[] = [];
  for (let c = 0; c < nCount; c++) {
    const numPoints = nextInt();
    npt += numPoints;
    offsetArr.push(npt);
    for (let i = 0; i < numPoints; i++) {
      const idx = nextInt() * 3;
      pts.push(positions[idx], positions[idx + 1], positions[idx + 2]);
    }
  }
  return {
    vertices: Float32Array.from(pts),
    offsets: Uint32Array.from(offsetArr),
    dpv: {},
    dps: {},
    groups: {},
    dpvMeta: {},
    dpsMeta: {},
  };
}

/**
 * Parse VTK LINES (both ASCII and binary) into NVTractData.
 * Expects a decompressed buffer.
 */
export function readVTKLines(buffer: ArrayBuffer): NVTractData {
  // Determine ASCII vs binary from header
  const bytes = new Uint8Array(buffer);
  const len = buffer.byteLength;
  let pos = 0;
  // Skip line 1 (signature)
  while (pos < len && bytes[pos] !== 10) pos++;
  pos++;
  // Skip line 2 (comment)
  while (pos < len && bytes[pos] !== 10) pos++;
  pos++;
  // Skip blank lines
  while (pos < len && bytes[pos] === 10) pos++;
  // Read encoding line
  const encStart = pos;
  while (pos < len && bytes[pos] !== 10) pos++;
  const encoding = new TextDecoder().decode(buffer.slice(encStart, pos));
  if (encoding.startsWith("ASCII")) {
    return readTxtVTKLines(buffer);
  }

  // Binary VTK LINES parsing
  pos = 0;
  function readStr(isSkipBlank = true): string {
    if (isSkipBlank) {
      while (pos < len && bytes[pos] === 10) pos++;
    }
    const startPos = pos;
    while (pos < len && bytes[pos] !== 10) pos++;
    pos++;
    return startPos < pos
      ? new TextDecoder().decode(buffer.slice(startPos, pos - 1))
      : "";
  }
  readStr(); // signature
  readStr(false); // comment
  readStr(); // BINARY
  readStr(); // DATASET POLYDATA
  let line = readStr(); // POINTS nvert type
  const isFloat64 = line.includes("double");
  const items = line.trim().split(/\s+/);
  const nvert = parseInt(items[1], 10);
  const nvert3 = nvert * 3;
  const positions = new Float32Array(nvert3);
  const reader = new DataView(buffer);
  if (isFloat64) {
    for (let i = 0; i < nvert3; i++) {
      positions[i] = reader.getFloat64(pos, false);
      pos += 8;
    }
  } else {
    for (let i = 0; i < nvert3; i++) {
      positions[i] = reader.getFloat32(pos, false);
      pos += 4;
    }
  }
  line = readStr(); // LINES n_count ...
  const headerItems = line.trim().split(/\s+/);
  const nCount = parseInt(headerItems[1], 10);

  // Check for OFFSETS style (DiPy)
  const posOK = pos;
  line = readStr();
  if (line.startsWith("OFFSETS")) {
    const isInt64 = line.includes("int64");
    const offsets = new Uint32Array(nCount + 1);
    if (isInt64) {
      for (let c = 0; c < nCount; c++) {
        const hi = reader.getInt32(pos, false);
        if (hi !== 0)
          log.warn("int32 overflow: JavaScript does not support int64");
        pos += 4;
        offsets[c] = reader.getInt32(pos, false);
        pos += 4;
      }
    } else {
      for (let c = 0; c < nCount; c++) {
        offsets[c] = reader.getInt32(pos, false);
        pos += 4;
      }
    }
    offsets[nCount] = nvert; // fence-post
    return {
      vertices: positions,
      offsets,
      dpv: {},
      dps: {},
      groups: {},
      dpvMeta: {},
      dpsMeta: {},
    };
  }

  // Classic binary style
  pos = posOK;
  let npt = 0;
  const offsetArr: number[] = [0];
  const pts: number[] = [];
  for (let c = 0; c < nCount; c++) {
    const numPoints = reader.getInt32(pos, false);
    pos += 4;
    npt += numPoints;
    offsetArr.push(npt);
    for (let i = 0; i < numPoints; i++) {
      const idx = reader.getInt32(pos, false) * 3;
      pos += 4;
      pts.push(positions[idx], positions[idx + 1], positions[idx + 2]);
    }
  }
  return {
    vertices: Float32Array.from(pts),
    offsets: Uint32Array.from(offsetArr),
    dpv: {},
    dps: {},
    groups: {},
    dpvMeta: {},
    dpsMeta: {},
  };
}
