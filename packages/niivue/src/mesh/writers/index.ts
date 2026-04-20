/**
 * Mesh Writer Registry
 *
 * Auto-discovers writer modules from this directory using import.meta.glob.
 * Each writer module should export:
 *   - extensions: string[] (supported file extensions)
 *   - write: async function(positions, indices, options?) => ArrayBuffer
 */

export type WriteOptions = {
  [key: string]: unknown;
};

type MeshWriter = {
  extensions?: string[];
  write: (
    positions: Float32Array,
    indices: Uint32Array,
    options?: WriteOptions,
  ) => Promise<ArrayBuffer>;
};

import { buildExtensionMap } from "@/NVLoader";

const modules = import.meta.glob<MeshWriter>("./*.ts", { eager: true });
const writerByExt = buildExtensionMap(modules, "./index.ts");

export function writeExtensions(): string[] {
  return Array.from(new Set(Array.from(writerByExt.keys()))).sort();
}

export async function writeMesh(
  ext: string,
  positions: Float32Array,
  indices: Uint32Array,
  options?: WriteOptions,
): Promise<ArrayBuffer> {
  const writer = writerByExt.get(ext.toUpperCase());
  if (!writer) {
    throw new Error(`No mesh writer available for extension: ${ext}`);
  }
  return writer.write(positions, indices, options);
}
