import { mat4, vec3, vec4 } from "gl-matrix";
import { log } from "@/logger";
import * as NVShapes from "@/mesh/NVShapes";
import type { MZ3 } from "@/NVTypes";

export const extensions = ["X3D"];
export const type = "mz3";

export async function read(buffer: ArrayBuffer): Promise<MZ3> {
  const len = buffer.byteLength;
  if (len < 20) {
    throw new Error(`File too small to be X3D: bytes = ${len}`);
  }
  const bytes = new Uint8Array(buffer);
  let pos = 0;
  function readStr(): string {
    while (pos < len && bytes[pos] !== 60) {
      pos++;
    }
    const startP = pos;
    while (pos < len && bytes[pos] !== 62) {
      pos++;
    }
    const endP = pos;
    return new TextDecoder().decode(buffer.slice(startP, endP + 1)).trim();
  }
  let line = readStr();
  function readStringTag(tagName: string): string {
    const fpos = line.indexOf(`${tagName}=`);
    if (fpos < 0) {
      return "";
    }
    const delimiter = line[fpos + tagName.length + 1];
    const spos = line.indexOf(delimiter, fpos) + 1;
    const epos = line.indexOf(delimiter, spos);
    return line.slice(spos, epos);
  }
  function readNumericTag(tagName: string): number | number[] {
    const fpos = line.indexOf(`${tagName}=`);
    if (fpos < 0) {
      return 1;
    }
    const delimiter = line[fpos + tagName.length + 1];
    const spos = line.indexOf(delimiter, fpos) + 1;
    const epos = line.indexOf(delimiter, spos);
    let str = line.slice(spos, epos).trim();
    str = str.replace(/,\s*$/, "");
    const items = str.trim().split(/\s*,\s*|\s+/);
    if (items.length < 2) {
      return parseFloat(str);
    }
    const ret: number[] = [];
    for (let i = 0; i < items.length; i++) {
      const v = parseFloat(items[i]);
      if (!Number.isFinite(v)) {
        continue;
      }
      ret.push(v);
    }
    return ret;
  }
  if (!line.includes("xml version")) {
    log.warn("Not a X3D image");
  }
  let positions: number[] = [];
  let indices: number[] = [];
  const colors: number[] = [];
  let color: number[] = [];
  let translation: vec4 = [0, 0, 0, 0];
  let rotation = [0, 0, 0, 0];
  let rgba = [255, 255, 255, 255];
  let rgbaGlobal = [255, 255, 255, 255];
  const appearanceStyles: Record<string, number[]> = {};

  function appendMesh(
    addPositions: number[],
    addIndices: number[],
    rgbaColor: number[],
    addColors?: number[],
  ): void {
    const idx0 = Math.floor(positions.length / 3);
    for (let i = 0; i < addIndices.length; i++) {
      indices.push(addIndices[i] + idx0);
    }
    positions = positions.concat(addPositions);
    const npt = Math.floor(addPositions.length / 3);
    if (addColors && addColors.length === npt * 3) {
      for (let i = 0; i < addColors.length; i += 3) {
        colors.push(
          addColors[i] / 255.0,
          addColors[i + 1] / 255.0,
          addColors[i + 2] / 255.0,
        );
      }
    } else {
      const r = rgbaColor[0] / 255.0;
      const g = rgbaColor[1] / 255.0;
      const b = rgbaColor[2] / 255.0;
      for (let i = 0; i < npt; i++) {
        colors.push(r, g, b);
      }
    }
  }

  function readAppearance(): void {
    if (!line.endsWith("/>")) {
      if (line.startsWith("<Appearance>")) {
        while (pos < len && !line.endsWith("</Appearance>")) {
          line += readStr();
        }
      } else {
        while (pos < len && !line.endsWith("/>")) {
          line += readStr();
        }
      }
    }
    const ref = readStringTag("USE");
    if (ref.length > 1) {
      if (ref in appearanceStyles) {
        rgba = appearanceStyles[ref];
      } else {
        log.warn(`Unable to find DEF for ${ref}`);
      }
      return;
    }
    const diffuseColor = readNumericTag("diffuseColor") as number[];
    if (diffuseColor.length < 3) {
      return;
    }
    rgba[0] = Math.round(diffuseColor[0] * 255);
    rgba[1] = Math.round(diffuseColor[1] * 255);
    rgba[2] = Math.round(diffuseColor[2] * 255);
    const def = readStringTag("DEF");
    if (def.length < 1) {
      return;
    }
    appearanceStyles[def] = rgba;
  }

  while (pos < len) {
    line = readStr();
    rgba = rgbaGlobal.slice();
    if (line.startsWith("<Transform")) {
      translation = readNumericTag("translation") as vec4;
      rotation = readNumericTag("rotation") as number[];
    }
    if (line.startsWith("<Appearance")) {
      readAppearance();
      rgbaGlobal = rgba.slice();
    }
    if (line.startsWith("<Shape")) {
      let radius = 1.0;
      let height = 1.0;
      let coordIndex: number[] = [];
      let point: number[] = [];
      while (pos < len) {
        line = readStr();
        if (line.startsWith("<Appearance")) {
          readAppearance();
        }
        if (line.startsWith("</Shape")) {
          break;
        }
        if (line.startsWith("<Sphere")) {
          radius = readNumericTag("radius") as number;
          height = -1.0;
        }
        if (line.startsWith("<Cylinder")) {
          radius = readNumericTag("radius") as number;
          height = readNumericTag("height") as number;
        }
        if (line.startsWith("<IndexedFaceSet")) {
          height = -2;
          coordIndex = readNumericTag("coordIndex") as number[];
        }
        if (line.startsWith("<IndexedTriangleSet")) {
          height = -7;
          coordIndex = readNumericTag("index") as number[];
        }
        if (line.startsWith("<IndexedTriangleStripSet")) {
          height = -3;
          coordIndex = readNumericTag("index") as number[];
        }
        if (line.startsWith("<Coordinate")) {
          point = readNumericTag("point") as number[];
          const rem = point.length % 3;
          if (rem !== 0) {
            point = point.slice(0, -rem);
          }
        }
        if (line.startsWith("<Color")) {
          color = readNumericTag("color") as number[];
        }
        if (line.startsWith("<Box")) {
          height = -4;
          log.warn("Unsupported x3d shape: Box");
        }
        if (line.startsWith("<Cone")) {
          height = -5;
          log.warn("Unsupported x3d shape: Cone");
        }
        if (line.startsWith("<ElevationGrid")) {
          height = -6;
          log.warn("Unsupported x3d shape: ElevationGrid");
        }
      }
      if (height < -3 && height !== -7) {
        // unsupported
      } else if (height < -1) {
        if (coordIndex.length < 1 || point.length < 3) {
          log.warn("Indexed mesh must specify indices and points");
          break;
        }
        const idx0 = Math.floor(positions.length / 3);
        let j = 2;
        if (height === -7) {
          indices = indices.concat(coordIndex.map((v) => v + idx0));
        } else if (height === -2) {
          let triStart = 0;
          while (j < coordIndex.length) {
            if (coordIndex[j] >= 0) {
              indices.push(coordIndex[triStart] + idx0);
              indices.push(coordIndex[j - 1] + idx0);
              indices.push(coordIndex[j - 0] + idx0);
              j += 1;
            } else {
              j += 3;
              triStart = j - 2;
            }
          }
        } else {
          while (j < coordIndex.length) {
            if (coordIndex[j] >= 0) {
              indices.push(coordIndex[j - 2] + idx0);
              indices.push(coordIndex[j - 1] + idx0);
              indices.push(coordIndex[j - 0] + idx0);
              j += 1;
            } else {
              j += 3;
            }
          }
        }
        positions = positions.concat(point);
        const npt = Math.floor(point.length / 3);
        if (color.length === npt * 3) {
          for (let i = 0; i < npt; i++) {
            colors.push(color[i * 3 + 0], color[i * 3 + 1], color[i * 3 + 2]);
          }
        } else {
          const r = rgba[0] / 255.0;
          const g = rgba[1] / 255.0;
          const b = rgba[2] / 255.0;
          for (let i = 0; i < npt; i++) {
            colors.push(r, g, b);
          }
        }
      } else if (height < 0.0) {
        const origin = [translation[0], translation[1], translation[2]];
        const sphere = NVShapes.createSphere(
          origin,
          radius,
          [rgba[0] / 255.0, rgba[1] / 255.0, rgba[2] / 255.0, rgba[3] / 255.0],
          2,
        );
        appendMesh(sphere.positions, sphere.indices, rgba);
      } else {
        const r = mat4.create();
        mat4.fromRotation(r, rotation[3], [
          rotation[0],
          rotation[1],
          rotation[2],
        ]);
        const pti = vec4.fromValues(0, -height * 0.5, 0, 1);
        const ptj = vec4.fromValues(0, +height * 0.5, 0, 1);
        vec4.transformMat4(pti, pti, r);
        vec4.transformMat4(ptj, ptj, r);
        vec4.add(pti, pti, translation);
        vec4.add(ptj, ptj, translation);
        const pti3 = vec3.fromValues(pti[0], pti[1], pti[2]);
        const ptj3 = vec3.fromValues(ptj[0], ptj[1], ptj[2]);
        const cyl = NVShapes.createCylinder(
          [pti3[0], pti3[1], pti3[2]],
          [ptj3[0], ptj3[1], ptj3[2]],
          radius,
          [rgba[0] / 255.0, rgba[1] / 255.0, rgba[2] / 255.0, rgba[3] / 255.0],
          20,
          true,
        );
        appendMesh(cyl.positions, cyl.indices, rgba);
      }
    }
  }
  const out: MZ3 = {
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(indices),
  };
  if (colors.length === positions.length) {
    out.colors = Float32Array.from(colors);
  }
  return out;
}
