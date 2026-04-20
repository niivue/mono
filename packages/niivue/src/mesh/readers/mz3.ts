import { makeLabelLut } from "@/cmap/NVCmaps";
import { maybeDecompress } from "@/codecs/NVGz";
import { log } from "@/logger";
import type { ColorMap, MZ3 } from "@/NVTypes";

export const extensions = ["MZ3"];
export const type = "mz3";
export async function read(buffer: ArrayBufferLike, n_vert = 0): Promise<MZ3> {
  // read mz3 mesh from ArrayBuffer
  // returns:
  //   positions Float32Array vertices [x,y,z]
  //   indices: Uint32Array triangle indices [i,j,k]
  //   scalars: Float32Array statistical maps
  //   colors: Float32Array curvature or ambient occlusion
  if (buffer.byteLength < 20) {
    throw new Error(`File too small to be mz3: bytes = ${buffer.byteLength}`);
  }
  const _buffer = await maybeDecompress(buffer);
  const reader = new DataView(_buffer);
  const magic = reader.getUint16(0, true);
  const attr = reader.getUint16(2, true);
  const nface = reader.getUint32(4, true);
  let nvert = reader.getUint32(8, true);
  const nskip = reader.getUint32(12, true);
  if (magic !== 23117) {
    throw new Error("Invalid MZ3 file");
  }
  const isFace = (attr & 1) !== 0;
  const isVert = (attr & 2) !== 0;
  const isRGBA = (attr & 4) !== 0;
  let isSCALAR = (attr & 8) !== 0;
  const isDOUBLE = (attr & 16) !== 0;
  const isLOOKUP = (attr & 64) !== 0;
  if (attr > 127) {
    throw new Error("Unsupported future version of MZ3 file");
  }

  let bytesPerScalar = 4;
  if (isDOUBLE) {
    bytesPerScalar = 8;
  }

  let NSCALAR = 0;
  if (n_vert > 0 && !isFace && nface < 1 && !isRGBA) {
    isSCALAR = true;
  }
  if (isSCALAR) {
    const nv = n_vert || nvert;
    const FSizeWoScalars =
      16 +
      nskip +
      (isFace ? nface * 12 : 0) +
      (isVert ? nv * 12 : 0) +
      (isRGBA ? nv * 4 : 0);
    const scalarFloats = Math.floor(
      (_buffer.byteLength - FSizeWoScalars) / bytesPerScalar,
    );
    if (nvert !== n_vert && scalarFloats % n_vert === 0) {
      nvert = n_vert;
    }
    NSCALAR = Math.floor(scalarFloats / nvert);
    if (NSCALAR < 1) {
      log.warn("Corrupt MZ3: file reports NSCALAR but not enough bytes");
      isSCALAR = false;
    }
  }

  if (nvert < 3 && n_vert < 3) {
    throw new Error("Not a mesh MZ3 file (maybe scalar)");
  }
  if (n_vert > 0 && n_vert !== nvert) {
    log.warn(`Layer has ${nvert}vertices, but background mesh has ${n_vert}`);
  }

  let filepos = 16 + nskip;
  const view = new DataView(_buffer);

  let indices: Uint32Array | null = null;
  if (isFace) {
    indices = new Uint32Array(nface * 3);
    for (let i = 0; i < nface * 3; i++) {
      indices[i] = view.getUint32(filepos, true);
      filepos += 4;
    }
  }
  let positions: Float32Array | null = null;
  if (isVert) {
    positions = new Float32Array(nvert * 3);
    for (let i = 0; i < nvert * 3; i++) {
      positions[i] = view.getFloat32(filepos, true);
      filepos += 4;
    }
  }
  let colors: Float32Array | null = null;
  if (isRGBA) {
    colors = new Float32Array(nvert * 3);
    for (let i = 0; i < nvert; i++) {
      for (let j = 0; j < 3; j++) {
        colors[i * 3 + j] = view.getUint8(filepos++) / 255;
      }
      filepos++; // skip Alpha
    }
  }
  let scalars = new Float32Array();
  if (isSCALAR && NSCALAR > 0) {
    if (isDOUBLE) {
      const flt64 = new Float64Array(NSCALAR * nvert);
      for (let i = 0; i < NSCALAR * nvert; i++) {
        flt64[i] = view.getFloat64(filepos, true);
        filepos += 8;
      }
      scalars = Float32Array.from(flt64);
    } else {
      scalars = new Float32Array(NSCALAR * nvert);
      for (let i = 0; i < NSCALAR * nvert; i++) {
        scalars[i] = view.getFloat32(filepos, true);
        filepos += 4;
      }
    }
  }
  // Build colormapLabel from embedded JSON or per-vertex RGBA colors
  let colormapLabel: ReturnType<typeof makeLabelLut> | undefined;
  if (isLOOKUP && isSCALAR) {
    const decoder = new TextDecoder("utf-8");
    const jsonBytes = new Uint8Array(_buffer, 16, nskip);
    const jsonText = decoder.decode(jsonBytes);
    const colormap = JSON.parse(jsonText) as ColorMap;
    colormapLabel = makeLabelLut(colormap);
  } else if (isRGBA && isSCALAR && colors) {
    let mx = scalars[0];
    for (let i = 0; i < nvert; i++) {
      mx = Math.max(mx, scalars[i]);
    }
    const Labels: ColorMap = { R: [], G: [], B: [], A: [], I: [], labels: [] };
    for (let i = 0; i <= mx; i++) {
      for (let v = 0; v < nvert; v++) {
        if (i === scalars[v]) {
          const v3 = v * 3;
          Labels.I.push(i);
          Labels.R.push(colors[v3] * 255);
          Labels.G.push(colors[v3 + 1] * 255);
          Labels.B.push(colors[v3 + 2] * 255);
          Labels.A.push(255);
          Labels.labels?.push(`${i}`);
          break;
        }
      }
    }
    colormapLabel = makeLabelLut(Labels);
  }
  if (n_vert > 0 && colormapLabel) {
    return { scalars, colormapLabel };
  }
  if (n_vert > 0) {
    return { scalars };
  }
  return { positions, indices, scalars, colors, colormapLabel };
}
