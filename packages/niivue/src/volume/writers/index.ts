/**
 * Volume Writer Registry
 *
 * Auto-discovers writer modules from this directory using import.meta.glob.
 * Each writer module should export:
 *   - extensions: string[] (supported file extensions)
 *   - write: async function(hdr, img, options?) => ArrayBuffer
 *
 * Compression (.gz) is handled transparently based on filename.
 */

import * as NVGz from '@/codecs/NVGz'
import * as NVLoader from '@/NVLoader'
import type { NIFTI1, NIFTI2 } from '@/NVTypes'

export type VolumeWriteOptions = {
  [key: string]: unknown
}

type VolumeWriter = {
  extensions?: string[]
  write: (
    hdr: NIFTI1 | NIFTI2,
    img: ArrayBuffer,
    options?: VolumeWriteOptions,
  ) => Promise<ArrayBuffer>
}

import { buildExtensionMap } from '@/NVLoader'

const modules = import.meta.glob<VolumeWriter>('./*.ts', { eager: true })
const writerByExt = buildExtensionMap(modules, './index.ts')

export function writeExtensions(): string[] {
  return Array.from(new Set(Array.from(writerByExt.keys()))).sort()
}

export async function writeVolume(
  filename: string,
  hdr: NIFTI1 | NIFTI2,
  img: ArrayBuffer,
  options?: VolumeWriteOptions,
): Promise<ArrayBuffer> {
  const ext = NVLoader.getFileExt(filename)
  const writer = writerByExt.get(ext.toUpperCase())
  if (!writer) {
    throw new Error(`No volume writer available for extension: ${ext}`)
  }
  const buffer = await writer.write(hdr, img, options)
  const isGz = filename.toLowerCase().endsWith('.gz')
  if (isGz) {
    const compressed = await NVGz.compress(new Uint8Array(buffer))
    return compressed.buffer as ArrayBuffer
  }
  return buffer
}
